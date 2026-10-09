//! Golden contracts captured from the immutable pre-migration image.
use crate::{
    config::{self, Config},
    memory, output, preparation,
};
use serde_json::{Value, json};

fn config_case(input: &Value) -> Value {
    let directory =
        std::env::temp_dir().join(format!("daedalus-config-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    for (name, content) in input["files"].as_object().unwrap() {
        std::fs::write(directory.join(name), content.as_str().unwrap()).unwrap();
    }
    let env = input["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect();
    let result = config::load(&directory.join("config.yaml"), &env);
    std::fs::remove_dir_all(directory).unwrap();
    match result {
        Ok(v) => json!({"ok":v}),
        Err(_) => json!({"error":true}),
    }
}

#[test]
fn golden_contracts() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../tests/fixtures/contracts.json")).unwrap();
    assert_eq!(
        fixtures["baseline_sha"],
        "7dc4e1d7ba8e6bea3018e5cc2d29d9870d46c36b"
    );
    for case in fixtures["cases"].as_array().unwrap() {
        let input = &case["input"];
        let actual = match case["operation"].as_str().unwrap() {
            "history" => json!(preparation::history(
                input["messages"].as_array().unwrap(),
                input["max_messages"].as_u64().unwrap() as usize,
                input["max_tokens"].as_u64().unwrap() as usize
            )),
            "clock_schema" => preparation::clock_schema("current_datetime_tool", &json!({})),
            "trusted_headers" => {
                let mut headers = http::HeaderMap::new();
                for (name, value) in input.as_object().unwrap() {
                    headers.insert(
                        http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                        value.as_str().unwrap().parse().unwrap(),
                    );
                }
                let values: serde_json::Map<_, _> = input
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(|name| (name.clone(), json!(preparation::header(&headers, name))))
                    .collect();
                json!({"headers": values, "output_key": output::key(
                    preparation::header(&headers, "x-user-id"),
                    &format!("tor_{}", "0".repeat(32))
                )})
            }
            "prepare" => {
                let config = Config::new(input["config"].clone(), Default::default()).unwrap();
                match preparation::base_prepare(&config, &input["body"], false) {
                    Ok((mut p, _)) => {
                        p.tools.push(
                            serde_json::from_value(preparation::clock_schema(
                                "current_datetime_tool",
                                &json!({}),
                            ))
                            .unwrap(),
                        );
                        json!({"ok":p})
                    }
                    Err(_) => json!({"error":true}),
                }
            }
            "config" => config_case(input),
            "output" => {
                let config=Config::new(json!({"llms":{"main":{"base_url":"http://model.invalid/v1","model_name":"fixture"}},"workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),Default::default()).unwrap();
                let content = input["content"].as_str().unwrap();
                let (lossless, reversible) = output::preview(
                    content,
                    input["tool"].as_str().unwrap(),
                    input["query"].as_str().unwrap(),
                    &output::Settings::new(&config),
                );
                let reference = output::reference(content);
                json!({"content":reversible.unwrap_or(lossless),"reference":reference,"key":output::key("synthetic-alice",&reference)})
            }
            "identity" => {
                let user = input["user"].as_str().unwrap();
                let bank = memory::bank_id(user);
                // Dependency spike: UUID v5 and UTF-8 hash parity for P2 grants.
                use sha2::{Digest, Sha256};
                let session = format!(
                    "daedalus-user-{}",
                    &format!("{:x}", Sha256::digest(user.as_bytes()))[..32]
                );
                let namespace =
                    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, b"nemo-agent-toolkit");
                let legacy = uuid::Uuid::new_v5(&namespace, session.as_bytes()).to_string();
                let hash = format!("{:x}", Sha256::digest(legacy.as_bytes()));
                json!({"bank":bank,"bootstrap_digest":memory::digest(&["v1",&bank]),"oauth":{"gmail":format!("nat/object_store/gmail-mcp-oauth-ro/tokens/{hash}"),"calendar":format!("nat/object_store/calendar-mcp-oauth-rw/tokens/{hash}"),"docs":format!("nat/object_store/docs-mcp-oauth-drive/tokens/{hash}")}})
            }
            "memory_payload" => json!(memory::bounded_payload(
                input["brief"].as_str().unwrap(),
                input["pages"].as_array().unwrap().clone(),
                input["facts"].as_array().unwrap().clone()
            )),
            other => panic!("Unimplemented fixture operation: {other}"),
        };
        assert_eq!(actual, case["expected"], "baseline contract {}", case["id"]);
    }
}

#[test]
fn invalid_configuration_is_redacted_and_required_tools_fail_closed() {
    for model in [
        json!({"base_url":"https://user:synthetic-secret@model.invalid","model_name":"fixture"}),
        json!({"base_url":"http://model.invalid","model_name":"fixture","request_timeout":"synthetic-secret"}),
    ] {
        let error=Config::new(json!({"llms":{"main":model},"workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),Default::default()).err().unwrap().to_string();
        assert!(!error.contains("synthetic-secret"));
    }
    let config = json!({"llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture"}},"functions":{"external":{"_type":"webscrape"}},"workflow":{"_type":"daedalus_rust_agent","llm_name":"main","tools":["external"]}});
    assert!(
        Config::new(
            config,
            std::collections::HashMap::from([("DAEDALUS_TOOL_EXECUTOR".into(), "disabled".into())])
        )
        .is_err()
    );
}

#[tokio::test]
#[ignore = "requires the disposable TLS/ACL Redis fixture in migration/image_check.py"]
async fn redis_upgrade_and_atomicity() {
    use std::{collections::HashMap, io::Read};
    let url = std::env::var("DAEDALUS_TEST_REDIS_URL").expect("Disposable Redis URL required");
    assert!(url.starts_with("rediss://backend:synthetic-backend@localhost:"));
    let config = Config::new(json!({"llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture"}},"workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),HashMap::from([("REDIS_URL".into(),url)])).unwrap();
    let store = output::OutputStore::new(&config).unwrap();
    let content =
        std::fs::read_to_string(std::env::var("DAEDALUS_TEST_OUTPUT_FILE").unwrap()).unwrap();
    let preview = store
        .optimize("synthetic-alice", "fixture", "summarize", &content)
        .await;
    assert!(preview.contains("_daedalus_compacted_tool_output"));
    let key = output::key("synthetic-alice", &output::reference(&content));
    let ttl: i64 = store
        .store
        .command(redis::cmd("TTL").arg(&key))
        .await
        .unwrap();
    assert!((7100..=7200).contains(&ttl));
    let legacy: Vec<u8> = store
        .store
        .command(redis::cmd("GET").arg(output::key(
            "synthetic-legacy",
            &output::reference(&content),
        )))
        .await
        .unwrap();
    assert_eq!(&legacy[..2], b"z1");
    let mut decoded = String::new();
    flate2::read::ZlibDecoder::new(&legacy[2..])
        .read_to_string(&mut decoded)
        .unwrap();
    assert_eq!(decoded, content);
    assert!(
        store.store.get("session:forbidden").await.is_err(),
        "Backend ACL must reject frontend sessions"
    );
    store
        .store
        .set("approval:fixture-race", "available", 60)
        .await
        .unwrap();
    let results = futures::future::join_all((0..32).map(|_| async {
        store.store.command::<i64>(redis::cmd("EVAL").arg("if redis.call('GET',KEYS[1]) then redis.call('DEL',KEYS[1]); return 1 else return 0 end").arg(1).arg("approval:fixture-race")).await.unwrap()
    })).await;
    assert_eq!(results.iter().sum::<i64>(), 1);
}
