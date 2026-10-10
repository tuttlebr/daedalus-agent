//! Reversible tool-output compaction; failed persistence preserves the full result.
use crate::{
    config::{Config, number, truthy},
    storage::Store,
};
use anyhow::Result;
use flate2::{Compression, write::ZlibEncoder};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Write,
    sync::LazyLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const MARKER: &str = "_daedalus_compacted_tool_output";
static ERRORS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:critical|denied|error|exception|failed|failure|fatal|invalid|missing|not[ -]?ready|timeout|unavailable|unhealthy|warning)\b").unwrap()
});
static COMPLETE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:all|complete|count|each|entire|every|exact|exhaustive|full|raw|verbatim)\b|\bhow many\b|\bare there (?:any|no)\b|\blist (?:all|every)\b").unwrap()
});
pub fn chars(s: &str) -> usize {
    s.chars().count()
}
pub fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
fn text_range(s: &str, start: usize, end: usize) -> String {
    s.chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}
pub fn reference(content: &str) -> String {
    format!("tor_{:x}", Sha256::digest(content.as_bytes()))[..36].into()
}
pub fn key(user: &str, reference: &str) -> String {
    format!(
        "daedalus:tool-output:v1:{}:{reference}",
        &format!("{:x}", Sha256::digest(user.as_bytes()))[..24]
    )
}
fn terms(query: &str) -> BTreeSet<String> {
    let re = Regex::new(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{2,}").unwrap();
    let stop = "about after also and are can could does for from have into latest list more please show that the their this tool what when where which with would";
    re.find_iter(query)
        .map(|m| m.as_str().to_lowercase())
        .filter(|s| !stop.split_whitespace().any(|w| w == s))
        .collect()
}

#[derive(Clone)]
pub struct Settings {
    pub enabled: bool,
    pub min_chars: usize,
    pub max_items: usize,
    pub min_savings: usize,
    pub ratio: f64,
    pub max_original: usize,
    pub ttl: usize,
}
impl Settings {
    pub fn new(config: &Config) -> Self {
        let w = config.workflow();
        let n = |key, default| w.get(key).and_then(|v| number(v).ok()).unwrap_or(default);
        Self {
            enabled: w.get("tool_output_compaction_enabled").is_none_or(truthy),
            min_chars: n("tool_output_compaction_min_chars", 8000.) as usize,
            max_items: n("tool_output_compaction_max_items", 16.) as usize,
            min_savings: n("tool_output_compaction_min_savings_chars", 1500.) as usize,
            ratio: n("tool_output_compaction_max_ratio", 0.70),
            max_original: n("tool_output_compaction_max_original_chars", 4_000_000.) as usize,
            ttl: (n("tool_output_cache_ttl_seconds", 7200.) as usize).max(1),
        }
    }
}
pub struct OutputStore {
    pub store: Store,
    pub settings: Settings,
    disabled_until: Mutex<Option<Instant>>,
}
impl OutputStore {
    pub fn new(config: &Config) -> Result<Self> {
        Ok(Self {
            store: Store::new(config)?,
            settings: Settings::new(config),
            disabled_until: Mutex::new(None),
        })
    }
    pub async fn optimize(&self, user: &str, tool: &str, query: &str, content: &str) -> String {
        let (lossless, reversible) = preview(content, tool, query, &self.settings);
        let Some(compacted) = reversible else {
            return lossless;
        };
        if user.is_empty()
            || self
                .disabled_until
                .lock()
                .await
                .is_some_and(|t| t > Instant::now())
        {
            return lossless;
        }
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(3));
        if encoder.write_all(content.as_bytes()).is_err() {
            return lossless;
        }
        let Ok(compressed) = encoder.finish() else {
            return lossless;
        };
        let mut payload = b"z1".to_vec();
        payload.extend(compressed);
        let result: Result<()> = self
            .store
            .command(
                redis::cmd("SET")
                    .arg(key(user, &reference(content)))
                    .arg(payload)
                    .arg("EX")
                    .arg(self.settings.ttl),
            )
            .await;
        if result.is_err() {
            *self.disabled_until.lock().await = Some(Instant::now() + Duration::from_secs(30));
            tracing::warn!(event = "tool_output_cache_unavailable");
            return lossless;
        }
        tracing::info!(
            event = "tool_output_compacted",
            original_chars = chars(content),
            compacted_chars = chars(&compacted)
        );
        compacted
    }
}

// Duplicate keys at any depth make normalization unsafe. A visitor detects them
// before serde_json's ordinary map representation could silently discard them.
struct Unique(Value);
impl<'de> serde::Deserialize<'de> for Unique {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Unique;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut v = vec![];
                while let Some(Unique(x)) = a.next_element()? {
                    v.push(x);
                }
                Ok(Unique(json!(v)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut v = serde_json::Map::new();
                while let Some((k, Unique(x))) = a.next_entry::<String, Unique>()? {
                    if v.contains_key(&k) {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                    v.insert(k, x);
                }
                Ok(Unique(Value::Object(v)))
            }
        }
        d.deserialize_any(Visitor)
    }
}
fn parsed(content: &str) -> Option<(Value, String, String)> {
    fn decode(text: &str) -> Option<Value> {
        // The first pass rejects duplicate keys. Parse the ordinary Value only
        // afterward so arbitrary precision number tokens keep their exact value.
        serde_json::from_str::<Unique>(text).ok()?;
        serde_json::from_str(text).ok()
    }
    if let Some(value) = decode(content.trim()) {
        return Some((value, String::new(), String::new()));
    }
    // Rust regex deliberately has no backreferences; compare the closing tag explicitly.
    let tag = Regex::new(
        r"(?s)^(\s*<([A-Za-z][A-Za-z0-9_:-]*)>\s*)(.*)(\s*</([A-Za-z][A-Za-z0-9_:-]*)>\s*)$",
    )
    .unwrap();
    if let Some(c) = tag.captures(content)
        && c[2] == c[5]
        && let Some(value) = decode(c[3].trim())
    {
        return Some((value, c[1].into(), c[4].into()));
    }
    let fence = Regex::new(r"(?is)^(\s*```(?:json)?\s*)(.*?)(\s*```\s*)$").unwrap();
    if let Some(c) = fence.captures(content)
        && let Some(value) = decode(c[2].trim())
    {
        return Some((value, c[1].into(), c[3].into()));
    }
    None
}

/// Python's compact JSON formatting: preserve big integers and normalize only
/// floats, including signed, two-digit exponents. Full raw output stays cached.
pub fn compact(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(compact).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => format!(
            "{{{}}}",
            values
                .iter()
                .map(|(key, value)| format!("{}:{}", json!(key), compact(value)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Number(number) if number.is_f64() => python_float(number.as_f64().unwrap()),
        _ => value.to_string(),
    }
}

/// CPython JSON uses the shortest round-tripping decimal with ties to even.
/// Rust's Debug formatter chooses a different shortest decimal for some ties.
/// serde_json's formatter has the matching tie rule; apply Python's decimal
/// notation thresholds, trailing .0 and minimum two-digit signed exponent.
fn python_float(value: f64) -> String {
    if value == 0.0 {
        return if value.is_sign_negative() {
            "-0.0"
        } else {
            "0.0"
        }
        .into();
    }
    let text = serde_json::to_string(&value).unwrap();
    let sign = if text.starts_with('-') { "-" } else { "" };
    let text = text.trim_start_matches('-');
    let (mantissa, exponent) = text
        .split_once('e')
        .map(|(m, e)| (m, e.parse::<i32>().unwrap()))
        .unwrap_or((text, 0));
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let all = mantissa.replace('.', "");
    let leading = all.bytes().take_while(|b| *b == b'0').count();
    let digits = all[leading..].trim_end_matches('0');
    let power = exponent + point - leading as i32 - 1;
    if !(-4..16).contains(&power) {
        let tail = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        format!("{sign}{}{tail}e{power:+03}", &digits[..1])
    } else {
        let point = power + 1;
        if point <= 0 {
            format!("{sign}0.{}{digits}", "0".repeat((-point) as usize))
        } else if point as usize >= digits.len() {
            format!(
                "{sign}{digits}{}.0",
                "0".repeat(point as usize - digits.len())
            )
        } else {
            format!(
                "{sign}{}.{}",
                &digits[..point as usize],
                &digits[point as usize..]
            )
        }
    }
}
pub fn indices(items: &[Value], max_items: usize, query: &str) -> Vec<usize> {
    let count = items.len();
    let budget = max_items.max(1).min(count);
    let mut selected: BTreeSet<usize> = (0..3.min(count))
        .chain(count.saturating_sub(2)..count)
        .collect();
    let rendered: Vec<String> = items.iter().map(compact).collect();
    let signals: Vec<usize> = rendered
        .iter()
        .enumerate()
        .filter(|(_, s)| ERRORS.is_match(s))
        .map(|(i, _)| i)
        .collect();
    let remaining = budget.saturating_sub(selected.len());
    let quota = if remaining > 0 {
        (remaining / 2).max(1)
    } else {
        0
    };
    for &i in signals.iter().take(quota) {
        if selected.len() >= budget {
            break;
        }
        selected.insert(i);
    }
    let terms = terms(query);
    if !terms.is_empty() && selected.len() < budget {
        let mut scored: Vec<(std::cmp::Reverse<usize>, usize)> = rendered
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let lowered = s.to_lowercase();
                let score = terms
                    .iter()
                    .map(|t| lowered.matches(t.as_str()).count())
                    .sum::<usize>();
                (score > 0).then_some((std::cmp::Reverse(score), i))
            })
            .collect();
        scored.sort();
        for (_, i) in scored.into_iter().take((budget - selected.len()).max(1)) {
            if selected.len() >= budget {
                break;
            }
            selected.insert(i);
        }
    }
    for &i in signals.iter().skip(quota) {
        if selected.len() >= budget {
            break;
        }
        selected.insert(i);
    }
    if selected.len() < budget {
        let remaining = budget - selected.len();
        let step = count as f64 / (remaining + 1) as f64;
        for ordinal in 1..=remaining {
            selected.insert(((ordinal as f64 * step).round_ties_even() as usize).min(count - 1));
        }
    }
    for i in 0..count {
        if selected.len() >= budget {
            break;
        }
        selected.insert(i);
    }
    selected.into_iter().take(budget).collect()
}

pub fn preview(content: &str, tool: &str, query: &str, s: &Settings) -> (String, Option<String>) {
    let original = chars(content);
    if !s.enabled || content.is_empty() || content.contains(MARKER) || original > s.max_original {
        return (content.into(), None);
    }
    let Some((value, prefix, suffix)) = parsed(content) else {
        return (content.into(), None);
    };
    let render = |v: &Value| format!("{prefix}{}{suffix}", compact(v));
    let minified = render(&value);
    let lossless = if original.saturating_sub(chars(&minified)) >= 256 {
        minified
    } else {
        content.into()
    };
    if original < s.min_chars || COMPLETE.is_match(query) {
        return (lossless, None);
    }
    let reference = reference(content);
    let mut envelope = None;
    if tool == "curated_feed_search_tool"
        && value["success"] == true
        && value["source"].is_object()
        && let Some(article) = value["content"].as_str()
        && chars(article) > 4000
    {
        let length = chars(article);
        let windows: Vec<(usize, usize)> = (0..length)
            .step_by(800)
            .map(|i| (i, (i + 800).min(length)))
            .collect();
        let mut selected = BTreeSet::from([0, windows.len() - 1]);
        let terms = terms(&format!(
            "{query} {}",
            value["query"].as_str().unwrap_or("")
        ));
        let mut ranked: Vec<_> = (1..windows.len() - 1)
            .map(|i| {
                let text = text_range(article, windows[i].0, windows[i].1);
                (
                    std::cmp::Reverse(ERRORS.is_match(&text)),
                    std::cmp::Reverse(
                        terms
                            .iter()
                            .map(|t| text.to_lowercase().matches(t.as_str()).count())
                            .sum::<usize>(),
                    ),
                    i,
                )
            })
            .collect();
        ranked.sort();
        let mut remaining = 4000
            - selected
                .iter()
                .map(|&i| windows[i].1 - windows[i].0)
                .sum::<usize>();
        for (_, _, i) in ranked {
            let size = windows[i].1 - windows[i].0;
            if size <= remaining {
                selected.insert(i);
                remaining -= size;
            }
        }
        let excerpts:Vec<Value>=selected.iter().map(|&i|json!({"start_offset":windows[i].0,"end_offset":windows[i].1,"text":text_range(article,windows[i].0,windows[i].1)})).collect();
        let shown = excerpts
            .iter()
            .map(|v| chars(v["text"].as_str().unwrap()))
            .sum::<usize>();
        let mut metadata = value.as_object().unwrap().clone();
        metadata.shift_remove("content");
        metadata.insert("excerpts".into(), json!(excerpts));
        envelope = Some(
            json!({MARKER:{"reference":reference,"content_path":"$.content","offset_basis":"decoded_article","original_chars":original,"article_chars":length,"omitted_chars":length-shown,"selection":"verbatim_boundaries,cautions,query_relevance","retrieval":"Partial excerpts, not the complete source. Use tool_output_retriever_tool with this reference to read exact surrounding content when omitted context could affect a claim. Do not infer absence from this preview. Excerpt offsets refer to the decoded article, not its JSON wrapper. Recover this source by query or page the original JSON; do not use excerpt offsets as retrieval offsets."},"preview":metadata}),
        );
    }
    let acceptable = |v: &Value| {
        let output = render(v);
        (original.saturating_sub(chars(&output)) >= s.min_savings
            && chars(&output) as f64 / original.max(1) as f64 <= s.ratio)
            .then_some(output)
    };
    if let Some(output) = envelope.as_ref().and_then(acceptable) {
        return (lossless, Some(output));
    }
    let target = if let Some(items) = value.as_array() {
        Some(("$".to_string(), items))
    } else {
        value.as_object().and_then(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_array().filter(|a| !a.is_empty()).map(|a| (k, a)))
                .min_by_key(|(_, a)| std::cmp::Reverse(chars(&compact(&json!(a)))))
                .map(|(k, a)| (format!("$.{k}"), a))
        })
    };
    if let Some((path, items)) = target
        && items.len() > s.max_items
    {
        let selected = indices(items, s.max_items, query);
        let shown = selected.len();
        let array = json!({"total_items":items.len(),"shown_items":shown,"omitted_items":items.len()-shown,"selection":"first,last,errors,query_relevance,even_sample","items":selected.iter().map(|&i|json!({"index":i,"value":items[i]})).collect::<Vec<_>>()});
        let mut preview = value.clone();
        if path == "$" {
            preview = array;
        } else {
            preview[&path[2..]] = array;
        }
        let envelope = json!({MARKER:{"reference":reference,"array_path":path,"original_chars":original,"estimated_original_tokens":original.div_ceil(4).max(1),"total_items":items.len(),"shown_items":shown,"omitted_items":items.len()-shown,"retrieval":"Use tool_output_retriever_tool with this reference when omitted rows could affect the answer. Search by query first; page exact content when completeness matters."},"preview":preview});
        return (lossless, acceptable(&envelope));
    }
    (lossless, None)
}
