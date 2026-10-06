//! Content-free operational diagnostics. Never format upstream errors here.

use std::fmt;

use anyhow::Error;
use rig_core::error::ProviderError;
use tracing_subscriber::filter::LevelFilter;

pub fn init() {
    let level = std::env::var("LOG_LEVEL")
        .ok()
        .and_then(|value| value.parse::<LevelFilter>().ok())
        .unwrap_or(LevelFilter::INFO);
    tracing_subscriber::fmt()
        .json()
        .with_ansi(false)
        .with_span_list(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| format!("daedalus_runtime={level}").into()),
        )
        .init();
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
        result.kind = error.kind().code();
        result.status = error
            .provider_response_status()
            .map(|status| status.as_u16());
        result.retryable = error.is_retryable();
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
