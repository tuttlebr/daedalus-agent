//! Content-free operational diagnostics. Never format upstream errors here.

use std::fmt;

use anyhow::Error;
use rig_core::error::ProviderError;
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields, format::Writer};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::{Layer, layer::SubscriberExt, util::SubscriberInitExt};

// tracing callsites have static levels. Keep one field list for both outcomes.
macro_rules! outcome_event {
    ($failed:expr, $($fields:tt)*) => {
        if $failed {
            tracing::error!($($fields)*);
        } else {
            tracing::info!($($fields)*);
        }
    };
}
pub(crate) use outcome_event;

struct LogFormat<F> {
    json: F,
    color: bool,
}

impl<S, N, F> FormatEvent<S, N> for LogFormat<F>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
    F: FormatEvent<S, N>,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        if !self.color {
            return self.json.format_event(ctx, writer, event);
        }
        let mut line = String::new();
        self.json.format_event(ctx, Writer::new(&mut line), event)?;
        // The JSON formatter writes the top-level severity before all event fields.
        let Some((before, rest)) = line.split_once("\"level\":\"") else {
            return writer.write_str(&line);
        };
        let Some((level, after)) = rest.split_once('"') else {
            return writer.write_str(&line);
        };
        let color = match *event.metadata().level() {
            Level::ERROR => 31,
            Level::WARN => 33,
            Level::INFO => 32,
            Level::DEBUG => 36,
            Level::TRACE => 90,
        };
        write!(
            writer,
            "{before}\"level\":\"\x1b[{color}m{level}\x1b[0m\"{after}"
        )
    }
}

pub fn init() {
    let level = std::env::var("LOG_LEVEL")
        .ok()
        .and_then(|value| value.parse::<LevelFilter>().ok())
        .unwrap_or(LevelFilter::INFO);
    let layer = tracing_subscriber::fmt::layer()
        .json()
        .with_ansi(false)
        .with_span_list(false)
        .map_event_format(|json| LogFormat {
            json,
            color: std::env::var("LOG_FORMAT").map_or(true, |v| v.eq_ignore_ascii_case("console")),
        })
        .with_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| format!("daedalus_runtime={level}").into())
                // The SDK logs remote bodies, session IDs and URLs at several
                // levels. RUST_LOG must never expose credentials or tool input.
                .add_directive("rmcp=off".parse().unwrap())
                .add_directive("reqwest=off".parse().unwrap())
                .add_directive("hyper=off".parse().unwrap())
                .add_directive("hyper_util=off".parse().unwrap())
                .add_directive("h2=off".parse().unwrap()),
        )
        // More-specific RUST_LOG directives cannot override this boundary.
        .with_filter(tracing_subscriber::filter::filter_fn(|metadata| {
            metadata.target().starts_with("daedalus_runtime")
        }));
    tracing_subscriber::registry().with(layer).init();
}

#[derive(Debug, Clone, Copy)]
pub struct Phase(pub &'static str);

impl fmt::Display for Phase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

pub struct Failure {
    pub phase: &'static str,
    pub kind: &'static str,
    pub status: Option<u16>,
    pub retryable: bool,
}

pub fn failure(error: &Error) -> Failure {
    let mut result = Failure {
        phase: error.downcast_ref::<Phase>().map_or("run", |phase| phase.0),
        kind: "application",
        status: None,
        retryable: false,
    };
    if let Some(error) = error.downcast_ref::<ProviderError>() {
        result.kind = crate::provider::error_kind(error);
        result.status = error
            .provider_response_status()
            .map(|status| status.as_u16());
        result.retryable = crate::provider::retryable(error);
    } else if let Some(error) = error.downcast_ref::<reqwest::Error>() {
        result.kind = if error.is_timeout() {
            "timeout"
        } else if error.is_connect() {
            "connect"
        } else if error.is_decode() {
            "decode"
        } else if error.is_status() {
            "http_status"
        } else {
            "transport"
        };
        result.status = error.status().map(|status| status.as_u16());
    } else if error.downcast_ref::<serde_json::Error>().is_some() {
        result.kind = "json";
    }
    result
}

/// Configuration-owned model/tool labels, never arbitrary provider text.
pub fn label(value: &str) -> &str {
    if !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:/".contains(&byte))
    {
        value
    } else {
        "invalid_label"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_diagnostics_keep_stage_status_and_retryability_without_body() {
        let error = Error::new(ProviderError::from_http_response(
            http::StatusCode::SERVICE_UNAVAILABLE,
            "private provider body and credential",
        ))
        .context(Phase("model_stream"));
        let details = failure(&error);
        assert_eq!(details.phase, "model_stream");
        assert_eq!(details.kind, "provider_response");
        assert_eq!(details.status, Some(503));
        assert!(details.retryable);
        assert_eq!(label("private\nforged_log=success"), "invalid_label");
        assert_eq!(label("fixture_mcp__read"), "fixture_mcp__read");
    }
}
