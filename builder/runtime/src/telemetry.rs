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
pub fn traceparent(span: &opentelemetry_sdk::trace::Span) -> http::HeaderValue {
    let context = span.span_context();
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
    ) -> opentelemetry_sdk::trace::Span {
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
pub fn routing(
    span: &mut opentelemetry_sdk::trace::Span,
    selection: &crate::preparation::ModelSelection,
) {
    span.set_attributes([
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
    ]);
    if let Some(skill) = &selection.triggering_skill {
        span.set_attribute(KeyValue::new(
            "model_triggering_skill",
            crate::logging::label(skill).to_owned(),
        ));
    }
}
pub fn finish(span: &mut opentelemetry_sdk::trace::Span, outcome: &str, metrics: &Value) {
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
