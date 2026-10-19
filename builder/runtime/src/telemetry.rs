//! Optional content-free OTLP spans owned by the Rust run lifecycle.
use crate::{agent::PreparedRun, config::Config};
use anyhow::{Result, anyhow};
use opentelemetry::{
    KeyValue,
    trace::{Span, Tracer, TracerProvider},
};
use opentelemetry_otlp::{WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    Resource,
    trace::{BatchConfigBuilder, BatchSpanProcessor, SdkTracer, SdkTracerProvider},
};
use serde_json::Value;
use std::{collections::HashMap, time::Duration};

pub struct Telemetry {
    provider: SdkTracerProvider,
    tracer: SdkTracer,
}
pub struct RunSpan {
    span: opentelemetry_sdk::trace::Span,
    routing: Vec<KeyValue>,
}
impl RunSpan {
    pub fn trace_id(&self) -> opentelemetry::trace::TraceId {
        self.span.span_context().trace_id()
    }
}
pub fn traceparent(span: &RunSpan) -> http::HeaderValue {
    let context = span.span.span_context();
    format!(
        "00-{}-{}-{:02x}",
        context.trace_id(),
        context.span_id(),
        context.trace_flags().to_u8()
    )
    .parse()
    .expect("W3C span identifiers contain only ASCII hex")
}
impl Telemetry {
    pub fn new(config: &Config) -> Result<Option<Self>> {
        let raw = &config.raw["telemetry"];
        let endpoint = raw["endpoint"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| config.variable("DAEDALUS_PHOENIX_ENDPOINT", ""));
        if endpoint.is_empty() {
            return Ok(None);
        }
        let key = config.variable("PHOENIX_API_KEY", "").trim().to_string();
        let mut headers = HashMap::new();
        if !key.is_empty() {
            headers.insert(
                "authorization".into(),
                if key.to_lowercase().starts_with("bearer ") {
                    key
                } else {
                    format!("Bearer {key}")
                },
            );
        }
        let timeout = raw["timeout"].as_f64().unwrap_or(3.).clamp(0.1, 30.);
        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(endpoint)
            .with_timeout(Duration::from_secs_f64(timeout))
            .with_headers(headers)
            .with_retry_policy(opentelemetry_otlp::RetryPolicy::default().with_max_retries(0))
            .build()
            .map_err(|_| anyhow!("Invalid telemetry configuration"))?;
        let project = raw["project"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| config.variable("PHOENIX_PROJECT_NAME", "daedalus"));
        let provider = SdkTracerProvider::builder()
            .with_span_processor(
                BatchSpanProcessor::builder(exporter)
                    .with_batch_config(
                        BatchConfigBuilder::default()
                            .with_scheduled_delay(Duration::from_secs(1))
                            .build(),
                    )
                    .build(),
            )
            .with_resource(
                Resource::builder_empty()
                    .with_attributes([
                        KeyValue::new("service.name", "daedalus-runtime"),
                        KeyValue::new("openinference.project.name", project),
                    ])
                    .build(),
            )
            .build();
        let tracer = provider.tracer("daedalus.agent");
        Ok(Some(Self { provider, tracer }))
    }
    pub fn start(
        &self,
        prepared: &PreparedRun,
        selection: &crate::preparation::ModelSelection,
    ) -> RunSpan {
        let mut span = self.tracer.start("daedalus.agent");
        span.set_attributes([
            KeyValue::new("openinference.span.kind", "AGENT"),
            KeyValue::new(
                "request_profile",
                if prepared.daily_summary {
                    "daily_summary"
                } else {
                    "default"
                },
            ),
            KeyValue::new(
                "requested_route_alias",
                crate::logging::label(&prepared.model.model_name).to_owned(),
            ),
        ]);
        let mut span = RunSpan {
            span,
            routing: Vec::new(),
        };
        routing(&mut span, selection);
        span
    }
    pub async fn shutdown(&self) {
        let provider = self.provider.clone();
        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            tokio::task::spawn_blocking(move || {
                provider.shutdown_with_timeout(Duration::from_secs(2))
            }),
        )
        .await;
    }
}
pub fn routing(span: &mut RunSpan, selection: &crate::preparation::ModelSelection) {
    // The SDK appends repeated keys and counts them toward the attribute limit.
    // Keep only the latest routing state and export it once at termination.
    span.routing = vec![
        KeyValue::new(
            "requested_model_profile",
            selection
                .requested
                .clone()
                .unwrap_or_else(|| "automatic".into()),
        ),
        KeyValue::new("effective_model_profile", selection.effective.clone()),
        KeyValue::new("model_selection_source", selection.source),
        KeyValue::new("model_promotion_count", selection.promotion_count),
    ];
    if let Some(skill) = &selection.triggering_skill {
        span.routing.push(KeyValue::new(
            "model_triggering_skill",
            crate::logging::label(skill).to_owned(),
        ));
    }
}
pub fn finish(run: &mut RunSpan, outcome: &str, metrics: &Value) {
    let span = &mut run.span;
    span.set_attributes(std::mem::take(&mut run.routing));
    span.set_attribute(KeyValue::new("outcome", outcome.to_string()));
    for name in [
        "model_calls",
        "tool_calls",
        "input_tokens",
        "output_tokens",
        "reported_usage_calls",
    ] {
        if let Some(value) = metrics[name].as_i64() {
            span.set_attribute(KeyValue::new(name, value));
        }
    }
    span.end();
}

#[cfg(test)]
mod tests {
    //! A local OTLP peer decodes the actual export; no private value may cross it.
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
        let body =
            json!({"messages":[{"role":"user","content":"PRIVATE_IDENTITY PRIVATE_ARGUMENT"}]});
        let (prepared, _) = crate::preparation::base_prepare(&config, &body, false).unwrap();
        let telemetry = crate::telemetry::Telemetry::new(&config).unwrap().unwrap();
        let mut trace_ids = Vec::new();
        for outcome in ["completed", "cancelled", "failed"] {
            let mut selection =
                crate::preparation::ModelSelection::new(&config, &body, false, false);
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
                &opentelemetry_proto::tonic::common::v1::any_value::Value::StringValue(
                    outcome.into()
                )
            ));
        }
        server.abort();
    }
}
