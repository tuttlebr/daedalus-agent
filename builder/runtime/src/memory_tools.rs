//! Native, identity-bound memory tools and fenced autonomous write reservations.
//! The retained Python executor is the wire/storage oracle, not a fallback.

use std::{collections::BTreeMap, sync::LazyLock, time::Duration};

use anyhow::{Result, anyhow, bail};
use http::HeaderMap;
use serde_json::{Value, json};

use crate::{authorization::hash, config::Config, output, preparation::header, storage::Store};

static CONTRACT: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../resources/memory-tools.json")).unwrap());
const ADDED: &str = "Memory added successfully. You can continue. Please respond to the user.";
const AMBIGUOUS: &str = "Memory write wasn't repeated because the same autonomous operation has an existing or ambiguous execution record.";
const UNAVAILABLE: &str = "Error adding memory: durable memory is unavailable.";

pub fn owns(kind: &str) -> bool {
    matches!(kind, "daedalus_add_memory" | "daedalus_get_memory")
}

pub fn validate(raw: &Value) -> Result<()> {
    let mut compatible = raw.clone();
    if let Some(map) = compatible.as_object_mut() {
        // Reuse the pinned Pydantic scalar/boolean checks; get_memory's top_k
        // has the same integer bounds as the output retriever's max_matches.
        if raw["_type"] == "daedalus_get_memory"
            && let Some(top_k) = map.remove("top_k")
        {
            map.insert("max_matches".into(), top_k);
        }
        if raw.as_object().unwrap().keys().any(|key| {
            !(["_type", "description", "verbose"].contains(&key.as_str())
                || raw["_type"] == "daedalus_get_memory" && key == "top_k")
        }) {
            bail!("Invalid memory tool configuration");
        }
    }
    crate::output_retriever::Settings::new(&compatible)
        .map(|_| ())
        .map_err(|_| anyhow!("Invalid memory tool configuration"))
}

pub fn schema(name: &str, raw: &Value) -> Value {
    let mut schema = CONTRACT[raw["_type"].as_str().unwrap()].clone();
    schema["name"] = json!(name);
    if let Some(description) = raw.get("description") {
        schema["description"] = description.clone();
    }
    schema
}

pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

/// Python's json.dumps forms used by the dependent service and stored hashes.
/// Do not use MCP canonicalization: it intentionally removes approval_token.
pub(crate) fn json_text(value: &Value, sorted: bool, ascii: bool, spaced: bool) -> String {
    let separator = if spaced { ", " } else { "," };
    let colon = if spaced { ": " } else { ":" };
    match value {
        Value::Object(map) => {
            let entries: Vec<_> = if sorted {
                map.iter().collect::<BTreeMap<_, _>>().into_iter().collect()
            } else {
                map.iter().collect()
            };
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| {
                        format!(
                            "{}{colon}{}",
                            json_text(&json!(key), sorted, ascii, spaced),
                            json_text(value, sorted, ascii, spaced)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(separator)
            )
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|v| json_text(v, sorted, ascii, spaced))
                .collect::<Vec<_>>()
                .join(separator)
        ),
        _ => output::compact(value)
            .chars()
            .map(|c| {
                if ascii && c > '\u{7e}' {
                    c.encode_utf16(&mut [0; 2])
                        .iter()
                        .map(|c| format!("\\u{c:04x}"))
                        .collect::<String>()
                } else {
                    c.to_string()
                }
            })
            .collect(),
    }
}

fn search_request(query: &str, mut top_k: usize) -> (Value, usize) {
    let normalized = query
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let expanded = if CONTRACT["daily_triggers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| normalized.contains(s.as_str().unwrap()))
    {
        top_k = top_k.max(CONTRACT["daily_top_k"].as_u64().unwrap() as usize);
        format!("{query} {}", CONTRACT["daily_terms"].as_str().unwrap())
    } else {
        query.into()
    };
    (
        json!({"query":expanded,"budget":if top_k > 10 {"mid"} else {"low"},
        "max_tokens":(top_k*160).clamp(512,4096),"types":["world","experience","observation"],
        "prefer_observations":true,"include":{"entities":null,"chunks":null,"source_facts":null},"trace":false}),
        top_k,
    )
}

fn normalized_arguments(args: &Value) -> Value {
    let mut metadata = args.get("metadata").cloned().unwrap_or_else(|| json!({}));
    if let Some(pairs) = args["key_value_pairs"]
        .as_object()
        .filter(|p| !p.is_empty())
    {
        let mut merged = metadata["key_value_pairs"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        merged.extend(pairs.clone());
        metadata["key_value_pairs"] = json!(merged);
    }
    json!({"memory":trim(args["memory"].as_str().unwrap_or("")),
        "tags":args.get("tags").cloned().unwrap_or_else(|| json!([])),"metadata":metadata})
}

fn retain_request(user: &str, request: &str, args: &Value) -> Value {
    let content = args["memory"].as_str().unwrap();
    let id = format!(
        "daedalus-explicit-{}",
        crate::memory::digest(&[&crate::memory::bank_id(user), "explicit", request, content])
    );
    let mut tags = vec![json!("source:explicit")];
    for tag in args["tags"].as_array().unwrap() {
        if !tags.contains(tag) {
            tags.push(tag.clone());
        }
    }
    let mut metadata = json!({"source":"explicit"});
    metadata
        .as_object_mut()
        .unwrap()
        .extend(args["metadata"].as_object().unwrap().clone());
    let metadata: serde_json::Map<String, Value> = metadata
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| !trim(k).is_empty())
        .map(|(k, v)| {
            (
                trim(k).into(),
                json!(
                    v.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| json_text(v, true, true, false))
                ),
            )
        })
        .collect();
    json!({"items":[{"content":content,"document_id":id,"context":"Daedalus verified explicit memory",
        "metadata":metadata,"tags":tags,"observation_scopes":"shared","update_mode":"replace"}],"async":false})
}

fn recall_result(reply: Value, top_k: usize) -> Result<String> {
    let reply = crate::hindsight::without_bank_fields(reply);
    let results = reply.get("results").cloned().unwrap_or_else(|| json!([]));
    // Python iterates strings and object keys but retains only dictionaries;
    // None and numeric responses instead fail the operation.
    let memories: Vec<_> = match results {
        Value::Array(items) => items
            .into_iter()
            .filter(Value::is_object)
            .take(top_k)
            .collect(),
        Value::Object(_) | Value::String(_) => vec![],
        _ => bail!("Invalid memory results"),
    };
    Ok(format!(
        "Memories as a JSON: \n{}",
        json_text(&json!(memories), false, true, true)
    ))
}

fn operation_key(user: &str, execution: &str, args: &Value) -> (String, String) {
    let digest = hash(&json_text(args, true, false, false));
    (
        format!(
            "daedalus:idempotency:v1:{}:{}:{}:{digest}",
            hash(user),
            hash(execution),
            hash("add_memory")
        ),
        digest,
    )
}

struct Reservation {
    key: String,
    owner: String,
}
enum Reserved {
    Acquired(Reservation),
    Existing(String),
}

pub struct Tools {
    pub hindsight: crate::hindsight::Client,
    store: Store,
    enabled: bool,
    ttl: String,
}

impl Tools {
    pub fn new(config: &Config) -> Result<Self> {
        Ok(Self {
            hindsight: crate::hindsight::Client::new(config)?,
            store: Store::new(config)?,
            enabled: config
                .variable("DAEDALUS_MEMORY_MODE", "hindsight")
                .trim()
                .eq_ignore_ascii_case("hindsight"),
            ttl: config.variable("AUTONOMY_IDEMPOTENCY_TTL_SECONDS", "604800"),
        })
    }

    async fn request(&self, user: &str, suffix: &str, body: Value, retain: bool) -> Result<Value> {
        self.hindsight
            .request(
                reqwest::Method::POST,
                user,
                suffix,
                Some(body),
                &[],
                retain.then_some(120.),
            )
            .await
    }

    async fn command<T: redis::FromRedisValue>(&self, cmd: &mut redis::Cmd) -> Result<T> {
        self.store
            .command_with_timeout(cmd, Duration::from_secs(5))
            .await
    }
    fn ttl(&self) -> Result<u64> {
        Ok(self.ttl.trim().parse::<i64>()?.max(3600) as u64)
    }

    async fn reserve(&self, user: &str, execution: &str, args: &Value) -> Result<Reserved> {
        let (key, digest) = operation_key(user, execution, args);
        let owner = crate::authorization::nonce();
        let payload =
            json!({"state":"in_progress","owner":owner,"arguments_sha256":digest}).to_string();
        for _ in 0..2 {
            let result: Option<String> = self
                .command(
                    redis::cmd("SET")
                        .arg(&key)
                        .arg(&payload)
                        .arg("NX")
                        .arg("EX")
                        .arg(self.ttl()?),
                )
                .await?;
            if result.is_some() {
                return Ok(Reserved::Acquired(Reservation { key, owner }));
            }
            let raw: Option<Vec<u8>> = self.command(redis::cmd("GET").arg(&key)).await?;
            if let Some(raw) = raw.filter(|v| !v.is_empty()) {
                let raw = String::from_utf8(raw)?;
                let record = match serde_json::from_str::<Value>(&raw) {
                    Ok(record) if record.is_object() => record,
                    Ok(_) => bail!("Invalid idempotency record"),
                    Err(_) => return Ok(Reserved::Existing(AMBIGUOUS.into())),
                };
                let result = if record["state"] == "completed" {
                    record["result"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(AMBIGUOUS)
                } else {
                    AMBIGUOUS
                };
                return Ok(Reserved::Existing(result.into()));
            }
        }
        Ok(Reserved::Existing(AMBIGUOUS.into()))
    }

    async fn complete(&self, reservation: Reservation) -> Result<bool> {
        let script = "local current=redis.call('GET',KEYS[1]); if not current then return 0 end; local decoded=cjson.decode(current); if decoded['state'] ~= 'in_progress' or decoded['owner'] ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1";
        let done: i64 = self
            .command(
                redis::cmd("EVAL")
                    .arg(script)
                    .arg(1)
                    .arg(&reservation.key)
                    .arg(&reservation.owner)
                    .arg(json!({"state":"completed","result":ADDED}).to_string())
                    .arg(self.ttl()?),
            )
            .await?;
        Ok(done == 1)
    }

    pub async fn call(&self, raw: &Value, args: &Value, headers: &HeaderMap) -> String {
        let user = header(headers, "x-user-id");
        if raw["_type"] == "daedalus_get_memory" {
            let query = trim(args["query"].as_str().unwrap_or(""));
            if query.is_empty() {
                return "Memories as a JSON: \n[]".into();
            }
            if user.is_empty() {
                return "Error: get_memory denied: authenticated user header x-user-id is required.".into();
            }
            if !self.enabled {
                return "Memories as a JSON: \n[]".into();
            }
            let default = crate::output_retriever::Settings::new(&json!({
                "max_matches": raw.get("top_k").cloned().unwrap_or_else(||json!(5))
            }))
            .expect("memory tool configuration was validated")
            .max_matches;
            let top_k = args
                .get("top_k")
                .filter(|v| !v.is_null())
                .and_then(Value::as_f64)
                .map(|n| n as usize)
                .unwrap_or(default);
            let (body, limit) = search_request(query, top_k);
            return match self
                .request(user, "memories/recall", body, false)
                .await
                .and_then(|v| recall_result(v, limit))
            {
                Ok(content) => content,
                Err(_) => "Error retrieving memory: durable memory is unavailable.".into(),
            };
        }
        let args = normalized_arguments(args);
        let text = args["memory"].as_str().unwrap();
        if text.is_empty() {
            return "Error: memory is required.".into();
        }
        if user.is_empty() {
            return "Error: add_memory denied: authenticated user header x-user-id is required."
                .into();
        }
        let execution =
            if header(headers, "x-daedalus-execution-scope").eq_ignore_ascii_case("autonomy") {
                header(headers, "x-daedalus-execution-id")
            } else {
                ""
            };
        // A dropped/cancelled future must leave the reservation in_progress.
        // There is no automatic release, replay or retry after dispatch.
        let reservation = if execution.is_empty() {
            None
        } else {
            match self.reserve(user, execution, &args).await {
                Ok(Reserved::Acquired(reservation)) => Some(reservation),
                Ok(Reserved::Existing(result)) => return result,
                Err(_) => {
                    return "Error: add_memory idempotency unavailable: Redis unavailable.".into();
                }
            }
        };
        if !self.enabled {
            return "Durable memory is disabled by the operator.".into();
        }
        if output::chars(text) > 12000 {
            return UNAVAILABLE.into();
        }
        let request = header(headers, "x-daedalus-request-id");
        let request = if !request.is_empty() {
            request.to_owned()
        } else if !execution.is_empty() {
            execution.into()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        if self
            .request(
                user,
                "memories",
                retain_request(user, &request, &args),
                true,
            )
            .await
            .is_err()
        {
            return UNAVAILABLE.into();
        }
        if let Some(reservation) = reservation {
            match self.complete(reservation).await {
                Ok(true) => {},
                Ok(false) => tracing::warn!(event="memory_write_receipt_not_owned"),
                Err(_) => return "Tool failed (RedisError). Check its arguments and service availability.".into(),
            }
        }
        ADDED.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        extract::{OriginalUri, State},
        routing::post,
    };
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn expand(value: Value) -> Value {
        match value {
            Value::Object(map) if map.len() == 1 && map.contains_key("$string_parts") => {
                json!(
                    map["$string_parts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap())
                        .collect::<String>()
                )
            }
            Value::Object(map) => {
                Value::Object(map.into_iter().map(|(k, v)| (k, expand(v))).collect())
            }
            Value::Array(items) => Value::Array(items.into_iter().map(expand).collect()),
            other => other,
        }
    }
    fn fixtures() -> Value {
        expand(serde_json::from_str(include_str!("../tests/fixtures/memory-tools.json")).unwrap())
    }

    #[tokio::test]
    async fn frozen_memory_tools_match_python_and_hindsight_requests() {
        let fixtures = fixtures();
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let state = (calls.clone(), fixtures["cases"][0]["reply"].clone());
        let server = Router::new().route("/{*path}", post(|State((calls, reply)): State<(Arc<Mutex<Vec<Value>>>, Value)>, OriginalUri(uri): OriginalUri, headers: HeaderMap, Json(body): Json<Value>| async move {
            calls.lock().await.push(json!({"path":uri.path(),"method":"POST","body":body,"authorization":headers["authorization"].to_str().unwrap()}));
            Json(reply)
        })).with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let config = Config::new(json!({"llms":{"main":{"base_url":"http://model.invalid/v1","model_name":"fixture"}},"workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),
            [("HINDSIGHT_API_URL".into(),base),("HINDSIGHT_API_KEY".into(),"synthetic-hindsight".into()),("REDIS_URL".into(),"redis://127.0.0.1:1".into())].into()).unwrap();
        let tools = Tools::new(&config).unwrap();
        let mut headers: HeaderMap = [
            ("x-user-id", "synthetic-alice"),
            ("x-daedalus-request-id", "synthetic-request"),
        ]
        .into_iter()
        .map(|(k, v)| {
            (
                http::HeaderName::from_static(k),
                http::HeaderValue::from_static(v),
            )
        })
        .collect();
        for (i, case) in fixtures["cases"].as_array().unwrap().iter().enumerate() {
            headers.insert(
                "x-daedalus-request-id",
                case["request_id"].as_str().unwrap().parse().unwrap(),
            );
            let mut raw = case["config"].clone();
            raw["_type"] = case["kind"].clone();
            validate(&raw).unwrap();
            assert_eq!(
                tools.call(&raw, &case["arguments"], &headers).await,
                case["expected"].as_str().unwrap(),
                "result {i}"
            );
            assert_eq!(
                json!(*calls.lock().await),
                case["calls"],
                "service calls {i}"
            );
            calls.lock().await.clear();
        }
        task.abort();
    }

    #[test]
    fn autonomous_keys_match_python_without_dropping_metadata() {
        for case in fixtures()["reservations"].as_array().unwrap() {
            let (key, digest) =
                operation_key("synthetic-alice", "synthetic-execution", &case["arguments"]);
            assert_eq!(key, case["key"]);
            assert_eq!(digest, case["digest"]);
        }
        let a = operation_key(
            "alice",
            "execution",
            &json!({"metadata":{"approval_token":"one"}}),
        );
        let b = operation_key(
            "alice",
            "execution",
            &json!({"metadata":{"approval_token":"two"}}),
        );
        assert_ne!(a, b);
    }

    #[test]
    fn model_schemas_match_the_frozen_python_catalog() {
        // CONTRACT is the production resource that builds these schemas, so
        // compare its parameters with the independently frozen catalogue.
        let catalog: Value =
            serde_json::from_str(include_str!("../tests/fixtures/native-catalog.json")).unwrap();
        for (kind, name) in [
            ("daedalus_add_memory", "add_memory"),
            ("daedalus_get_memory", "get_memory"),
        ] {
            assert_eq!(
                schema(name, &json!({"_type":kind}))["parameters"],
                catalog[name]["schema"],
                "{kind}"
            );
        }
    }

    #[test]
    fn memory_configuration_and_response_privacy() {
        for value in [json!(1), json!(50), json!("2.0"), json!(true)] {
            assert!(validate(&json!({"_type":"daedalus_get_memory","top_k":value})).is_ok());
        }
        for raw in [
            json!({"_type":"daedalus_get_memory","top_k":0}),
            json!({"_type":"daedalus_get_memory","top_k":51}),
            json!({"_type":"daedalus_add_memory","top_k":1}),
            json!({"_type":"daedalus_get_memory","description":null}),
            json!({"_type":"daedalus_get_memory","max_matches":3}),
        ] {
            assert!(validate(&raw).is_err());
        }
        assert!(recall_result(json!({"results":null}), 5).is_err());
        assert_eq!(
            recall_result(json!({}), 5).unwrap(),
            "Memories as a JSON: \n[]"
        );
        assert_eq!(
            recall_result(json!({"results":"none"}), 5).unwrap(),
            "Memories as a JSON: \n[]"
        );
        let nested = json!({"bank_id":"secret","items":[{"tenant_id":"secret","ok":{"bank_id":"secret","value":"safe"}}]});
        assert_eq!(
            crate::hindsight::without_bank_fields(nested),
            json!({"items":[{"ok":{"value":"safe"}}]})
        );
    }
}
