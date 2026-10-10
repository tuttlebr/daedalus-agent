//! Golden behavior was exported from the immutable Python baseline, not from
//! the candidate. Never regenerate expected values with Rust to fix a failure.
use crate::{
    authorization::{Policies, canonical},
    mcp_http, oauth,
};
use serde_json::{Value, json};

fn fixture_strings(value: Value) -> Value {
    match value {
        Value::Object(mut object) if object.len() == 1 && object.contains_key("$string_parts") => {
            Value::String(
                object
                    .remove("$string_parts")
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|part| part.as_str().unwrap())
                    .collect(),
            )
        }
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, fixture_strings(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(fixture_strings).collect()),
        value => value,
    }
}

#[test]
fn authorization_contracts() {
    let fixtures: Value = fixture_strings(
        serde_json::from_str(include_str!("../tests/fixtures/authorization.json")).unwrap(),
    );
    assert_eq!(
        fixtures["baseline_sha"],
        "7dc4e1d7ba8e6bea3018e5cc2d29d9870d46c36b"
    );
    for case in fixtures["cases"].as_array().unwrap() {
        let input = &case["input"];
        let actual = match case["operation"].as_str().unwrap() {
            "canonical" => {
                let (text, digest) =
                    canonical(&serde_json::from_str(input.as_str().unwrap()).unwrap()).unwrap();
                json!({"canonical":text,"sha256":digest})
            }
            "oauth-key" => json!(
                oauth::token_key(
                    input["service"].as_str().unwrap(),
                    input["user"].as_str().unwrap()
                )
                .unwrap()
            ),
            "grant" => oauth::decode_grant_in_timezone(
                input.as_str().unwrap(),
                fixtures["legacy_timezone"]
                    .as_str()
                    .unwrap()
                    .parse::<chrono_tz::Tz>()
                    .unwrap(),
            )
            .unwrap(),
            "policy" => {
                let mut group = input.clone();
                group["_type"] = json!("mcp_client");
                match Policies::new(&json!({"function_groups":{"fixture":group}})) {
                    Err(_) => json!({"valid":false}),
                    Ok(policy) => {
                        let calls: Vec<_> = case["expected"]["calls"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|call| {
                                let mut result = call.clone();
                                let name = call["tool"].as_str().unwrap();
                                result["allowed"] = json!(policy.allowed(
                                    "fixture",
                                    name,
                                    &call["args"],
                                    &call["annotations"]
                                ));
                                result["read_only"] = json!(policy.read_only("fixture", name));
                                result
                            })
                            .collect();
                        json!({"valid":true,"calls":calls})
                    }
                }
            }
            "result" => json!(crate::output::compact(&mcp_http::result_envelope(
                input.clone()
            ))),
            operation => panic!("Unknown fixture operation: {operation}"),
        };
        assert_eq!(actual, case["expected"], "{}: {}", case["id"], input);
    }
}
