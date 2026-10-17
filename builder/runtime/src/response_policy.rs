//! Presentation policy, independent of tool permissions and answer correctness.
//!
//! A provider may emit text before announcing a tool call. Final-only requests
//! therefore withhold a whole model round until it completes without calls.
//! This never edits the final answer or treats it as semantically validated.

use anyhow::{Result, bail};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub const MAX_WITHHELD_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub enum ResponsePolicy {
    #[default]
    Auto,
    Streaming,
    FinalOnly,
}

impl ResponsePolicy {
    pub fn parse(body: &Value) -> Result<Self> {
        match body.get("response_mode").and_then(Value::as_str) {
            Some("auto") => Ok(Self::Auto),
            Some("streaming") => Ok(Self::Streaming),
            Some("final_only") => Ok(Self::FinalOnly),
            None if body.get("response_mode").is_none_or(Value::is_null) => Ok(Self::Auto),
            _ => bail!("Invalid response_mode"),
        }
    }

    /// Only caller-authored user messages and steering enter this heuristic.
    /// False positives can delay display; they cannot change tool authority.
    /// Explicit streaming/final_only modes avoid natural-language inference.
    pub fn observe_user(&mut self, text: &str) {
        static EXACT: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(concat!(
                r"(?ix)\b(?:return|reply|respond|output|answer|print|emit)\s+",
                r"(?:(?:with|using|in|as)\s+)?(?:only|just|exactly)\b",
                r"|\b(?:no|without)\s+(?:any\s+)?(?:commentary|explanation|prose|preamble)\b",
                r"|\b(?:json|yaml|csv|xml)\s+only\b"
            ))
            .expect("response presentation pattern")
        });
        if matches!(self, Self::Auto) && EXACT.is_match(text) {
            *self = Self::FinalOnly;
        }
    }

    pub fn final_only(&self) -> bool {
        matches!(self, Self::FinalOnly)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_output_presentation_and_explicit_overrides() {
        for text in [
            "Find the label. Return only that label, preserving its characters.",
            "Reply with only the integer.",
            "Respond using exactly two lines.",
            "Output JSON only.",
            "Check the source, without commentary.",
        ] {
            let mut auto = ResponsePolicy::parse(&json!({})).unwrap();
            auto.observe_user(text);
            assert!(auto.final_only(), "{text}");
            let mut streaming =
                ResponsePolicy::parse(&json!({"response_mode":"streaming"})).unwrap();
            streaming.observe_user(text);
            assert!(!streaming.final_only());
        }
        for text in [
            "Research these reports and explain what changed.",
            "Use only the supplied sources, then write a detailed comparison.",
            "Only one source is available. Explain the uncertainty.",
        ] {
            let mut auto = ResponsePolicy::default();
            auto.observe_user(text);
            assert!(!auto.final_only());
        }
        let mut exact = ResponsePolicy::parse(&json!({"response_mode":"final_only"})).unwrap();
        exact.observe_user("Also consult the second source.");
        assert!(exact.final_only());
        for value in [json!(false), json!("unknown"), json!({})] {
            assert!(ResponsePolicy::parse(&json!({"response_mode":value})).is_err());
        }
    }
}
