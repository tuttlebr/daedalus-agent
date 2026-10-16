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

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Reservation {
    key: String,
    owner_token: Option<String>,
    state: String,
    stored_result: Option<String>,
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
    let payload = json_text(
        &json!({"state":"in_progress", "owner":owner,
        "arguments_sha256":prepared.arguments_sha256}),
        true,
        true,
        false,
    );
    for _ in 0..2 {
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
        if acquired.is_some() {
            return Ok(Reservation {
                key: prepared.key.clone(),
                owner_token: Some(owner),
                state: "in_progress".into(),
                stored_result: None,
                surrogates: Surrogates::new(),
            });
        }
        let raw: Option<Vec<u8>> = command(&store, redis::cmd("GET").arg(&prepared.key)).await?;
        if let Some(raw) = raw.filter(|v| !v.is_empty()) {
            let raw = String::from_utf8(raw)
                .map_err(|_| anyhow!("Invalid idempotency record encoding"))?;
            let (existing, surrogates) = match document_json::decode(raw.as_bytes()) {
                Some((existing, surrogates)) if existing.is_object() => (existing, surrogates),
                Some(_) => return Err(anyhow!("Invalid idempotency record")),
                None => (json!({"state":"invalid"}), Surrogates::new()),
            };
            return Ok(Reservation {
                key: prepared.key.clone(),
                owner_token: None,
                state: existing
                    .get("state")
                    .filter(|v| truthy(v))
                    .map(crate::profile_import::identifier)
                    .unwrap_or_else(|| "invalid".into()),
                stored_result: existing["result"].as_str().map(str::to_owned),
                surrogates,
            });
        }
    }
    Ok(Reservation {
        key: prepared.key.clone(),
        owner_token: None,
        state: "in_progress".into(),
        stored_result: None,
        surrogates: Surrogates::new(),
    })
}

/// Publish every handled result, including failure receipts, while still owner.
/// Lost replies leave the stored receipt untouched; callers must not re-ingest.
pub async fn complete(config: &Config, reservation: &Reservation, result: &Text) -> Result<bool> {
    if !reservation.acquired() || reservation.owner_token.as_deref() == Some("") {
        return Ok(false);
    }
    let store = Store::new(config)?;
    let script = "local current=redis.call('GET',KEYS[1]); if not current then return 0 end; local decoded=cjson.decode(current); if decoded['state'] ~= 'in_progress' or decoded['owner'] ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1";
    let completed: i64 = command(
        &store,
        redis::cmd("EVAL")
            .arg(script)
            .arg(1)
            .arg(&reservation.key)
            .arg(reservation.owner_token.as_deref().unwrap())
            .arg(format!(
                "{{\"result\":{},\"state\":\"completed\"}}",
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
            .filter(|value| truthy(value))
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
    let key = format!(
        "daedalus:idempotency:v1:{}:{}:{}:{arguments_sha256}",
        hash(user),
        hash(execution),
        hash("ingest_user_documents")
    );
    Ok(Prepared {
        key,
        arguments_sha256,
        #[cfg(test)]
        arguments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

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
            let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
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
                        arguments: request["arguments"].clone(),
                    };
                    reserve(&config, &prepared)
                        .await
                        .map(|r| json!({"acquired":r.acquired(), "reservation":r}))
                }
                "complete" => {
                    let reservation =
                        serde_json::from_value(request["reservation"].clone()).unwrap();
                    complete(
                        &config,
                        &reservation,
                        &request["result"].as_str().unwrap().into(),
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
