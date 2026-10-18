//! Migration-era checks of retained production primitives: content-free
//! telemetry export and bounded stateless-tool concurrency.
use axum::{Router, routing::post};
use serde_json::json;

#[tokio::test]
async fn telemetry_exports_terminal_metrics_without_private_content() {
    use axum::{body::Bytes, extract::State};
    use prost::Message;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    type Requests = Arc<Mutex<Vec<Vec<u8>>>>;
    async fn collect(State(requests): State<Requests>, bytes: Bytes) -> &'static str {
        requests.lock().await.push(bytes.to_vec());
        ""
    }
    let requests = Requests::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/traces", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/v1/traces", post(collect))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config = crate::config::Config::new(json!({"telemetry":{"endpoint":endpoint},"llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture","api_key":"PRIVATE_CREDENTIAL"}},"workflow":{"_type":"daedalus_rust_agent","llm_name":"main","instructions":"PRIVATE_PROMPT"}}),Default::default()).unwrap();
    let body = json!({"messages":[{"role":"user","content":"PRIVATE_IDENTITY PRIVATE_ARGUMENT"}]});
    let (prepared, _) = crate::preparation::base_prepare(&config, &body, false).unwrap();
    let telemetry = crate::telemetry::Telemetry::new(&config).unwrap().unwrap();
    let mut trace_ids = Vec::new();
    for outcome in ["completed", "cancelled", "failed"] {
        let mut selection = crate::preparation::ModelSelection::new(&config, &body, false, false);
        let mut span = telemetry.start(&prepared, &selection);
        let trace_id = span.trace_id();
        assert!(
            crate::telemetry::traceparent(&span)
                .to_str()
                .unwrap()
                .contains(&trace_id.to_string())
        );
        trace_ids.push(trace_id.to_bytes().to_vec());
        // Long tool-heavy runs used to fill the SDK's 128 attribute slots with
        // duplicate routing keys and silently lose every terminal metric.
        for call in 0..100 {
            if call == 50 {
                selection.effective = "deep".into();
                selection.source = "skill_load";
                selection.promotion_count = 1;
                selection.triggering_skill = Some("research".into());
            }
            crate::telemetry::routing(&mut span, &selection);
        }
        crate::telemetry::finish(
            &mut span,
            outcome,
            &json!({"model_calls":9,"tool_calls":100,"input_tokens":1201211,"output_tokens":72607,"reported_usage_calls":9}),
        );
    }
    telemetry.shutdown().await;
    let requests = requests.lock().await;
    assert!(!requests.is_empty());
    let mut outcomes = Vec::new();
    for bytes in requests.iter() {
        assert!(!String::from_utf8_lossy(bytes).contains("PRIVATE"));
        let export =
            opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest::decode(
                bytes.as_slice(),
            )
            .unwrap();
        for resource in export.resource_spans {
            for scope in resource.scope_spans {
                for span in scope.spans {
                    use opentelemetry_proto::tonic::common::v1::any_value::Value;
                    assert_eq!(span.name, "daedalus.agent");
                    assert!(trace_ids.contains(&span.trace_id));
                    assert_eq!(span.dropped_attributes_count, 0);
                    let count = span.attributes.len();
                    let attributes: std::collections::HashMap<_, _> = span
                        .attributes
                        .into_iter()
                        .map(|a| (a.key, a.value.unwrap().value.unwrap()))
                        .collect();
                    assert_eq!(attributes.len(), count, "no duplicate routing keys");
                    for (key, expected) in [
                        ("model_calls", Value::IntValue(9)),
                        ("tool_calls", Value::IntValue(100)),
                        ("input_tokens", Value::IntValue(1201211)),
                        ("output_tokens", Value::IntValue(72607)),
                        ("reported_usage_calls", Value::IntValue(9)),
                        ("effective_model_profile", Value::StringValue("deep".into())),
                        (
                            "model_selection_source",
                            Value::StringValue("skill_load".into()),
                        ),
                        ("model_promotion_count", Value::IntValue(1)),
                        (
                            "model_triggering_skill",
                            Value::StringValue("research".into()),
                        ),
                    ] {
                        assert_eq!(attributes.get(key), Some(&expected), "{key}");
                    }
                    outcomes.push(attributes["outcome"].clone());
                }
            }
        }
    }
    assert_eq!(outcomes.len(), 3);
    for outcome in ["completed", "cancelled", "failed"] {
        assert!(outcomes.contains(
            &opentelemetry_proto::tonic::common::v1::any_value::Value::StringValue(outcome.into())
        ));
    }
    server.abort();
}

#[test]
fn verifier_concurrency_is_bounded_and_other_tools_stay_serial() {
    let mut raw = json!({
        "llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture"}},
        "workflow":{"_type":"daedalus_rust_agent","llm_name":"main"},
        "functions":{
            "verify":{"_type":"source_verifier"},
            "documents":{"_type":"nat_nv_ingest"}
        }
    });
    let config = crate::config::Config::new(raw.clone(), Default::default()).unwrap();
    assert_eq!(config.tool_concurrency("verify"), 1);
    assert_eq!(config.tool_concurrency("documents"), 1);
    assert_eq!(config.tool_concurrency("mcp__read"), 1);
    let mut unsupported = raw.clone();
    unsupported["functions"]["documents"]["max_concurrency"] = json!(8);
    assert!(crate::config::Config::new(unsupported, Default::default()).is_err());
    for limit in [1, 3, 8] {
        raw["functions"]["verify"]["max_concurrency"] = json!(limit);
        let config = crate::config::Config::new(raw.clone(), Default::default()).unwrap();
        assert_eq!(config.tool_concurrency("verify"), limit);
    }
    for value in [
        json!(0),
        json!(9),
        json!(-1),
        json!(true),
        json!(1.5),
        json!("3"),
        json!(null),
    ] {
        raw["functions"]["verify"]["max_concurrency"] = value;
        assert!(crate::config::Config::new(raw.clone(), Default::default()).is_err());
    }
}
