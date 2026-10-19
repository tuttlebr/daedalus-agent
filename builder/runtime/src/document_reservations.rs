//! Durable autonomous document-write reservations and completed-result replay.
use crate::{
    collections,
    config::{Config, truthy},
    document_json::{self, Surrogates, Text},
    document_store,
    document_tools::Settings,
    memory_tools::json_text,
    storage::Store,
};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{future::Future, time::Duration};

const AMBIGUOUS: &str = "Document ingest wasn't repeated because the same autonomous operation has an existing or ambiguous execution record.";
const CONTRACT: &str = "document-overlap-v2";

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Reservation {
    key: String,
    owner_token: Option<String>,
    state: String,
    stored_result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    contract: Option<String>,
    #[serde(skip)]
    surrogates: Surrogates,
}

impl Reservation {
    pub fn acquired(&self) -> bool {
        self.owner_token.is_some() && self.state == "in_progress"
    }

    /// An existing record always stops dispatch, even without a usable result.
    pub fn replay(&self) -> Option<Text> {
        if self.acquired() {
            return None;
        }
        let result = if self.state == "completed" {
            self.stored_result.as_deref().filter(|s| !s.is_empty())
        } else {
            None
        };
        Some(match result {
            Some(result) => Text::new(result.into(), self.surrogates.clone()),
            None => AMBIGUOUS.into(),
        })
    }
}

fn ttl(config: &Config) -> Result<String> {
    let configured =
        document_store::integer(&config.variable("AUTONOMY_IDEMPOTENCY_TTL_SECONDS", "604800"))
            .ok_or_else(|| anyhow!("Invalid idempotency TTL"))?;
    Ok(
        if configured.starts_with('-')
            || configured.len() < 4
            || configured.len() == 4 && configured.as_str() < "3600"
        {
            "3600".into()
        } else {
            configured
        },
    )
}

async fn command<T: redis::FromRedisValue>(store: &Store, cmd: &mut redis::Cmd) -> Result<T> {
    store
        .command_with_timeout(cmd, Duration::from_secs(5))
        .await
}

/// Open the global ledger only when an autonomous write needs a reservation.
/// A failed SET is ambiguous and must never be retried after a transport error.
pub async fn reserve(config: &Config, prepared: &Prepared) -> Result<Reservation> {
    let store = Store::new(config)?;
    let owner = crate::authorization::nonce();
    let mut record = json!({"state":"in_progress", "owner":owner,
        "arguments_sha256":prepared.arguments_sha256});
    if let Some(contract) = &prepared.contract {
        record["contract"] = json!(contract);
    }
    let payload = json_text(&record, true, true, false);
    for _ in 0..2 {
        let (acquired, existing_key, raw) = if let Some(legacy_key) = &prepared.legacy_key {
            let contract = prepared
                .contract
                .as_deref()
                .ok_or_else(|| anyhow!("A legacy reservation requires a contract marker"))?;
            let legacy_raw: Option<Vec<u8>> =
                command(&store, redis::cmd("GET").arg(legacy_key)).await?;
            let marked = legacy_raw
                .as_ref()
                .and_then(|raw| document_json::decode(raw))
                .is_some_and(|(record, _)| record["contract"] == contract);
            // The legacy check and new reservation must be atomic. Only a
            // marked record distinguishes a new default request from old zero.
            // Compare inspected bytes instead of using Redis's JSON decoder,
            // which cannot decode every retained Python receipt string.
            let script = r#"
local current = redis.call('GET', KEYS[1])
if current then return {0, KEYS[1], current} end
local legacy = redis.call('GET', KEYS[2])
if legacy and (ARGV[4] ~= '1' or legacy ~= ARGV[3]) then
  return {0, KEYS[2], legacy}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return {1, KEYS[1], ''}
"#;
            let (acquired, key, raw): (i64, String, Vec<u8>) = command(
                &store,
                redis::cmd("EVAL")
                    .arg(script)
                    .arg(2)
                    .arg(&prepared.key)
                    .arg(legacy_key)
                    .arg(&payload)
                    .arg(ttl(config)?)
                    .arg(legacy_raw.unwrap_or_default())
                    .arg(if marked { "1" } else { "0" }),
            )
            .await?;
            (acquired == 1, key, Some(raw))
        } else {
            let acquired: Option<String> = command(
                &store,
                redis::cmd("SET")
                    .arg(&prepared.key)
                    .arg(&payload)
                    .arg("NX")
                    .arg("EX")
                    .arg(ttl(config)?),
            )
            .await?;
            let raw = if acquired.is_some() {
                None
            } else {
                command(&store, redis::cmd("GET").arg(&prepared.key)).await?
            };
            (acquired.is_some(), prepared.key.clone(), raw)
        };
        if acquired {
            return Ok(Reservation {
                key: prepared.key.clone(),
                owner_token: Some(owner),
                state: "in_progress".into(),
                stored_result: None,
                contract: prepared.contract.clone(),
                surrogates: Surrogates::new(),
            });
        }
        if let Some(raw) = raw.filter(|v| !v.is_empty()) {
            let raw = String::from_utf8(raw)
                .map_err(|_| anyhow!("Invalid idempotency record encoding"))?;
            let (existing, surrogates) = match document_json::decode(raw.as_bytes()) {
                Some((existing, surrogates)) if existing.is_object() => (existing, surrogates),
                Some(_) => return Err(anyhow!("Invalid idempotency record")),
                None => (json!({"state":"invalid"}), Surrogates::new()),
            };
            if existing_key != prepared.key
                && existing["contract"].as_str() == prepared.contract.as_deref()
            {
                continue;
            }
            return Ok(Reservation {
                key: existing_key,
                owner_token: None,
                state: existing
                    .get("state")
                    .filter(|v| truthy(v))
                    .map(crate::profile_import::identifier)
                    .unwrap_or_else(|| "invalid".into()),
                stored_result: existing["result"].as_str().map(str::to_owned),
                contract: None,
                surrogates,
            });
        }
    }
    Ok(Reservation {
        key: prepared.key.clone(),
        owner_token: None,
        state: "in_progress".into(),
        stored_result: None,
        contract: None,
        surrogates: Surrogates::new(),
    })
}

/// Publish every handled result, including failure receipts, while still owner.
/// Lost replies leave the stored receipt untouched; callers must not re-ingest.
/// Publish a finished ingest's receipt. Its rows are already written: an
/// unavailable receipt store must not turn that success into a tool error.
/// The reservation then stays in progress, which still blocks blind replays.
pub async fn finalize(config: &Config, reservation: &Reservation, result: &Text) {
    if !matches!(complete(config, reservation, result).await, Ok(true)) {
        tracing::warn!("Document ingest finished but its idempotency result couldn't be finalized");
    }
}

pub async fn complete(config: &Config, reservation: &Reservation, result: &Text) -> Result<bool> {
    if !reservation.acquired() || reservation.owner_token.as_deref() == Some("") {
        return Ok(false);
    }
    let store = Store::new(config)?;
    let contract = reservation
        .contract
        .as_ref()
        .map(|contract| format!("\"contract\":{},", serde_json::to_string(contract).unwrap()))
        .unwrap_or_default();
    let script = "local current=redis.call('GET',KEYS[1]); if not current then return 0 end; local decoded=cjson.decode(current); if decoded['state'] ~= 'in_progress' or decoded['owner'] ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1";
    let completed: i64 = command(
        &store,
        redis::cmd("EVAL")
            .arg(script)
            .arg(1)
            .arg(&reservation.key)
            .arg(reservation.owner_token.as_deref().unwrap())
            .arg(format!(
                "{{{contract}\"result\":{},\"state\":\"completed\"}}",
                result.ascii_json()
            ))
            .arg(ttl(config)?),
    )
    .await?;
    Ok(completed == 1)
}

pub struct Prepared {
    pub key: String,
    pub arguments_sha256: String,
    pub contract: Option<String>,
    pub legacy_key: Option<String>,
    #[cfg(test)]
    pub arguments: Value,
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

/// Resolve every immutable upload identity before any reservation or write.
/// Reads preserve order and duplicates, and stop at the first invalid record.
pub async fn prepare<F, R>(
    config: &Config,
    settings: &Settings,
    input: &Value,
    user: &str,
    execution: &str,
    mut read: F,
) -> Result<Prepared>
where
    F: FnMut(String) -> R,
    R: Future<Output = Result<Option<Value>>>,
{
    let references = if truthy(&input["documentRefs"]) {
        input["documentRefs"]
            .as_array()
            .ok_or_else(|| anyhow!("Error: Invalid document reference provided."))?
            .iter()
            .collect::<Vec<_>>()
    } else {
        vec![&input["documentRef"]]
    };
    let mut identities = Vec::with_capacity(references.len());
    for reference in references {
        let reference = document_store::immutable_reference(reference)?;
        let record = read(reference.key()).await?;
        identities.push(document_store::immutable_identity(
            config,
            &reference,
            user,
            record.as_ref(),
        )?);
    }
    let setting = |field: &str| {
        input
            .get(field)
            .filter(|value| {
                if field == "chunk_overlap" {
                    !value.is_null()
                } else {
                    truthy(value)
                }
            })
            .unwrap_or(&settings.values[field])
            .clone()
    };
    let collection = collections::resolve(
        input["collection_name"].as_str(),
        Some(user),
        settings.values["default_collection_name"].as_str(),
    );
    let arguments = json!({"collection":collection, "documents":identities,
        "chunkSize":setting("chunk_size"), "chunkOverlap":setting("chunk_overlap")});
    let arguments_sha256 = hash(&json_text(&arguments, true, false, false));
    let prefix = format!(
        "daedalus:idempotency:v1:{}:{}:{}:",
        hash(user),
        hash(execution),
        hash("ingest_user_documents")
    );
    let key = format!("{prefix}{arguments_sha256}");
    let legacy_key = if input["chunk_overlap"] == 0 && settings.values["chunk_overlap"] != 0 {
        let mut legacy = arguments.clone();
        legacy["chunkOverlap"] = settings.values["chunk_overlap"].clone();
        Some(format!(
            "{prefix}{}",
            hash(&json_text(&legacy, true, false, false))
        ))
    } else {
        None
    };
    Ok(Prepared {
        key,
        arguments_sha256,
        contract: Some(CONTRACT.into()),
        legacy_key,
        #[cfg(test)]
        arguments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[tokio::test]
    async fn unavailable_receipt_store_never_fails_a_finished_ingest() {
        let config = Config {
            raw: json!({}),
            policy_raw: json!({}),
            python_tools: false,
            env: [("REDIS_URL".to_string(), "redis://127.0.0.1:1".to_string())].into(),
        };
        let reservation = Reservation {
            key: "synthetic-key".into(),
            owner_token: Some("synthetic-owner".into()),
            state: "in_progress".into(),
            stored_result: None,
            contract: None,
            surrogates: Surrogates::new(),
        };
        let result = Text::from("Successfully ingested 1 chunk.");
        // The receipt write itself fails; the tool previously returned that
        // error instead of the ingest's result.
        assert!(complete(&config, &reservation, &result).await.is_err());
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            finalize(&config, &reservation, &result),
        )
        .await
        .unwrap();
    }

    #[test]
    fn retained_receipt_replay_decisions() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/document-reservations.json"))
                .unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        for case in fixture["cases"].as_array().unwrap() {
            let Some(stored) = case.get("reservation") else {
                continue;
            };
            let reservation = Reservation {
                key: "synthetic-key".into(),
                owner_token: None,
                state: stored["state"].as_str().unwrap().into(),
                stored_result: stored["result"].as_str().map(str::to_owned),
                contract: None,
                surrogates: Surrogates::new(),
            };
            assert_eq!(
                reservation.replay().map(Text::observation),
                case["expected"].get("result").cloned(),
                "{}",
                case["name"]
            );
        }
        assert!(
            Reservation {
                key: "synthetic-key".into(),
                owner_token: Some("synthetic-owner".into()),
                state: "in_progress".into(),
                stored_result: Some("stale result".into()),
                contract: None,
                surrogates: Surrogates::new(),
            }
            .replay()
            .is_none()
        );
    }

    #[tokio::test]
    #[ignore = "requires the disposable Redis fixture in document_reservations_check.py"]
    async fn actual_redis_reservations() {
        use std::io::{BufRead, Write};
        for line in std::io::stdin().lock().lines() {
            let (request, request_surrogates) =
                document_json::decode(line.unwrap().as_bytes()).unwrap();
            let config = Config {
                raw: json!({}),
                policy_raw: json!({}),
                python_tools: false,
                env: serde_json::from_value(request["environment"].clone()).unwrap(),
            };
            let result = match request["operation"].as_str().unwrap() {
                "reserve" => {
                    let prepared = Prepared {
                        key: request["key"].as_str().unwrap().into(),
                        arguments_sha256: request["digest"].as_str().unwrap().into(),
                        contract: request["contract"].as_str().map(str::to_owned),
                        legacy_key: request["legacy_key"].as_str().map(str::to_owned),
                        arguments: request["arguments"].clone(),
                    };
                    reserve(&config, &prepared).await.map(|r| {
                        let acquired = r.acquired();
                        let mut observation = serde_json::to_value(&r).unwrap();
                        if let Some(result) = r.stored_result {
                            observation["stored_result"] =
                                Text::new(result, r.surrogates).observation();
                        }
                        json!({"acquired":acquired, "reservation":observation})
                    })
                }
                "complete" => {
                    let reservation =
                        serde_json::from_value(request["reservation"].clone()).unwrap();
                    complete(
                        &config,
                        &reservation,
                        &Text::new(
                            request["result"].as_str().unwrap().into(),
                            request_surrogates,
                        ),
                    )
                    .await
                    .map(|completed| json!({"completed":completed}))
                }
                _ => panic!("Unknown reservation fixture operation"),
            };
            let response = result.unwrap_or_else(|_| json!({"error":true}));
            println!("RESERVATION_RESULT {response}");
            std::io::stdout().flush().unwrap();
        }
    }

    #[tokio::test]
    async fn retained_immutable_uploads_and_reservation_keys() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/document-reservations.json"))
                .unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        for case in fixture["cases"].as_array().unwrap() {
            if case.get("execution").is_some_and(|v| v == "") || case["scope"] == "interactive" {
                // These requests bypass preparation in the retained adapter;
                // its complete native dispatch is a separate acceptance gate.
                assert_eq!(case["expected"]["calls"].as_array().unwrap().len(), 1);
                continue;
            }
            let mut env: HashMap<String, String> =
                serde_json::from_value(fixture["environment"].clone()).unwrap();
            if let Some(extra) = case["env"].as_object() {
                env.extend(
                    extra
                        .iter()
                        .map(|(key, value)| (key.clone(), value.as_str().unwrap().into())),
                );
            }
            let settings = Settings::new(case.get("config").unwrap_or(&json!({})), &env).unwrap();
            let config = Config {
                raw: json!({}),
                policy_raw: json!({}),
                python_tools: false,
                env,
            };
            let calls = Mutex::new(Vec::new());
            let actual = prepare(
                &config,
                &settings,
                &case["arguments"],
                fixture["user"].as_str().unwrap(),
                "synthetic-execution",
                |key| {
                    calls.lock().unwrap().push(json!({"read":["JSON.GET",key]}));
                    futures::future::ready(Ok(case["records"].get(&key).cloned()))
                },
            )
            .await;
            let expected_calls = case["expected"]["calls"].as_array().unwrap();
            assert_eq!(
                *calls.lock().unwrap(),
                expected_calls
                    .iter()
                    .filter(|call| call.get("read").is_some())
                    .cloned()
                    .collect::<Vec<_>>(),
                "{}",
                case["name"]
            );
            if let Some(reservation) = expected_calls
                .iter()
                .find(|call| call.get("reserve").is_some())
            {
                let actual = actual.unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
                if case["arguments"]["chunk_overlap"] == 0 && settings.values["chunk_overlap"] != 0
                {
                    // The frozen baseline accidentally ignored zero. Keep its
                    // old key as a compatibility lookup, but honor zero for
                    // new writes and their exact argument digest.
                    let mut expected = reservation["reserve"]["arguments"].clone();
                    expected["chunkOverlap"] = json!(0);
                    assert_eq!(actual.arguments, expected);
                    assert_eq!(
                        actual.arguments_sha256,
                        hash(&json_text(&expected, true, false, false))
                    );
                    assert!(actual.key.ends_with(&actual.arguments_sha256));
                    assert_eq!(actual.legacy_key.as_deref(), reservation["key"].as_str());
                    continue;
                }
                assert_eq!(
                    actual.arguments, reservation["reserve"]["arguments"],
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    actual.arguments_sha256, reservation["digest"],
                    "{}",
                    case["name"]
                );
                assert_eq!(actual.key, reservation["key"], "{}", case["name"]);
            } else {
                let error = actual.err().unwrap_or_else(|| {
                    panic!("{} unexpectedly prepared a reservation", case["name"])
                });
                assert_eq!(
                    format!("Error: document ingest idempotency unavailable: {error}."),
                    case["expected"]["result"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
}
