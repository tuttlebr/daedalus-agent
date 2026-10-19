//! Reversible tool-output compaction; failed persistence preserves the full result.
use crate::{
    config::{Config, number, truthy},
    storage::Store,
};
use anyhow::Result;
use flate2::{Compression, Decompress, FlushDecompress, Status, write::ZlibEncoder};
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
pub fn redact_approval_markers(content: &str) -> String {
    static MARKERS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?:<!--|&lt;!--)daedalus-mcp-approval:[A-Za-z0-9_-]+(?:-->|--&gt;)").unwrap()
    });
    MARKERS
        .replace_all(content, "[untrusted approval marker omitted]")
        .into_owned()
}
static ERRORS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:critical|denied|error|exception|failed|failure|fatal|invalid|missing|not[ -]?ready|timeout|unavailable|unhealthy|warning)\b").unwrap()
});
static COMPLETE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:all|complete|count|each|entire|every|exact|exhaustive|full|raw|verbatim)\b|\bhow many\b|\bare there (?:any|no)\b|\blist (?:all|every)\b").unwrap()
});
static RESEARCH_COMPLETE: LazyLock<Regex> = LazyLock::new(|| {
    // Precise identifiers and per-source read limits do not request the entire
    // article. Keep exhaustive/verbatim requests on the full-content path.
    Regex::new(concat!(
        r"(?i)\b(?:all|complete|count|entire|every|exhaustive|full|raw|verbatim)\b",
        r"|\bhow many\b|\bare there (?:any|no)\b",
        r"|\b(?:list|enumerate|extract|report|return)\s+each\b",
        r"|\beach\s+(?:line|word|character|byte|paragraph|sentence|item|entry|record|measurement|fact|detail)\b",
        r"|\bexact\s+(?:source|content|document|text|article|code|transcript|output)\b"
    )).unwrap()
});
pub fn chars(s: &str) -> usize {
    s.chars().count()
}
pub fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
/// Character-offset slicing over one precomputed boundary table. Excerpt
/// ranking slices every 800-character window; rescanning from the start for
/// each window was quadratic in the article length.
struct CharSlices<'a> {
    text: &'a str,
    boundaries: Vec<usize>,
}
impl<'a> CharSlices<'a> {
    fn new(text: &'a str) -> Self {
        let boundaries = text
            .char_indices()
            .map(|(offset, _)| offset)
            .chain(std::iter::once(text.len()))
            .collect();
        Self { text, boundaries }
    }
    fn len(&self) -> usize {
        self.boundaries.len() - 1
    }
    /// Characters `start..end`, clamped like `chars().skip(start).take(..)`.
    fn get(&self, start: usize, end: usize) -> &'a str {
        let end = end.min(self.len());
        let start = start.min(end);
        &self.text[self.boundaries[start]..self.boundaries[end]]
    }
}
pub fn reference(content: &str) -> String {
    format!("tor_{:x}", Sha256::digest(content.as_bytes()))[..36].into()
}
pub fn valid_reference(reference: &str) -> bool {
    reference.len() == 36
        && reference.starts_with("tor_")
        && reference.as_bytes()[4..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

fn decode(payload: &[u8]) -> Result<Option<String>> {
    let Some(payload) = payload.strip_prefix(b"z1") else {
        return Ok(None);
    };
    let mut decoder = Decompress::new(true);
    let mut content = Vec::new();
    loop {
        let mut buffer = [0; 16 * 1024];
        let before_in = decoder.total_in();
        let before_out = decoder.total_out();
        let status = decoder.decompress(
            &payload[before_in as usize..],
            &mut buffer,
            FlushDecompress::None,
        )?;
        content.extend_from_slice(&buffer[..(decoder.total_out() - before_out) as usize]);
        if status == Status::StreamEnd {
            return Ok(Some(String::from_utf8(content)?));
        }
        if decoder.total_in() == before_in && decoder.total_out() == before_out {
            anyhow::bail!("Invalid tool output cache entry");
        }
    }
}
pub fn key(user: &str, reference: &str) -> String {
    format!(
        "daedalus:tool-output:v1:{}:{reference}",
        &format!("{:x}", Sha256::digest(user.as_bytes()))[..24]
    )
}
fn terms(query: &str) -> BTreeSet<String> {
    static TERM: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{2,}").unwrap());
    let re = &*TERM;
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
}

/// Python creates one reader per configured retriever factory. Keep its error
/// backoff independent of other retrievers and the run's compaction writer.
pub struct OutputReader {
    store: Store,
    disabled_until: Mutex<Option<Instant>>,
}
impl OutputReader {
    pub fn new(config: &Config) -> Result<Self> {
        Ok(Self {
            store: Store::new(config)?,
            disabled_until: Mutex::new(None),
        })
    }
    pub async fn get(&self, user: &str, reference_id: &str) -> Option<String> {
        if user.is_empty()
            || !valid_reference(reference_id)
            || self
                .disabled_until
                .lock()
                .await
                .is_some_and(|t| t > Instant::now())
        {
            return None;
        }
        let result: Result<Option<String>> = async {
            let payload: Option<Vec<u8>> = self
                .store
                .command(redis::cmd("GET").arg(key(user, reference_id)))
                .await?;
            let Some(payload) = payload else {
                return Ok(None);
            };
            let Some(content) = decode(&payload)? else {
                return Ok(None);
            };
            if reference(&content) != reference_id {
                tracing::warn!(event = "tool_output_cache_integrity_failed");
                return Ok(None);
            }
            Ok(Some(content))
        }
        .await;
        match result {
            Ok(content) => content,
            Err(_) => {
                *self.disabled_until.lock().await = Some(Instant::now() + Duration::from_secs(30));
                tracing::warn!(event = "tool_output_retrieval_cache_unavailable");
                None
            }
        }
    }
}
impl OutputStore {
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
fn decimal_parts(token: &str) -> Option<(bool, String, i64)> {
    let negative = token.starts_with('-');
    let unsigned = token.trim_start_matches('-');
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let fraction = mantissa.split_once('.').map_or(0, |(_, tail)| tail.len());
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_start_matches('0');
    let significant = digits.trim_end_matches('0');
    if significant.is_empty() {
        return Some((negative, String::new(), 0));
    }
    let exponent = exponent
        .parse::<i64>()
        .ok()?
        .checked_sub(fraction as i64)?
        .checked_add((digits.len() - significant.len()) as i64)?;
    Some((negative, significant.into(), exponent))
}

fn numbers_are_lossless(value: &Value) -> bool {
    match value {
        Value::Number(number) => {
            let token = number.to_string();
            if !token.contains(['.', 'e', 'E']) {
                return true; // Arbitrary-precision integers are never rounded.
            }
            number.as_f64().is_some_and(|number| {
                let rendered = python_float(number);
                if token == rendered {
                    return true;
                }
                let before = decimal_parts(&token);
                before.is_some() && before == decimal_parts(&rendered)
            })
        }
        Value::Array(items) => items.iter().all(numbers_are_lossless),
        Value::Object(fields) => fields.values().all(numbers_are_lossless),
        _ => true,
    }
}

fn parsed(content: &str) -> Option<(Value, String, String)> {
    fn decode(text: &str) -> Option<Value> {
        // The first pass rejects duplicate keys. Parse the ordinary Value only
        // afterward so arbitrary precision number tokens keep their exact value.
        serde_json::from_str::<Unique>(text).ok()?;
        let value = serde_json::from_str(text).ok()?;
        // Float formatting must not overflow, underflow, or round a decimal.
        // Unsafe payloads pass through verbatim without relying on the cache.
        numbers_are_lossless(&value).then_some(value)
    }
    if let Some(value) = decode(content.trim()) {
        return Some((value, String::new(), String::new()));
    }
    // Rust regex deliberately has no backreferences; compare the closing tag explicitly.
    static TAG: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?s)^(\s*<([A-Za-z][A-Za-z0-9_:-]*)>\s*)(.*)(\s*</([A-Za-z][A-Za-z0-9_:-]*)>\s*)$",
        )
        .unwrap()
    });
    static FENCE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?is)^(\s*```(?:json)?\s*)(.*?)(\s*```\s*)$").unwrap());
    if let Some(c) = TAG.captures(content)
        && c[2] == c[5]
        && let Some(value) = decode(c[3].trim())
    {
        return Some((value, c[1].into(), c[4].into()));
    }
    if let Some(c) = FENCE.captures(content)
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
        Value::Number(number) if number.is_f64() && numbers_are_lossless(value) => {
            python_float(number.as_f64().unwrap())
        }
        _ => value.to_string(),
    }
}

/// CPython JSON uses the shortest round-tripping decimal with ties to even.
/// Rust's Debug formatter chooses a different shortest decimal for some ties.
/// serde_json's formatter has the matching tie rule; apply Python's decimal
/// notation thresholds, trailing .0 and minimum two-digit signed exponent.
pub(crate) fn python_float(value: f64) -> String {
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
    let research = tool == "webscrape_tool"
        && value["output_mode"] == "research"
        && value["success"] == true
        && value["content"].is_string();
    let preserve = if research {
        &*RESEARCH_COMPLETE
    } else {
        &*COMPLETE
    };
    if original < s.min_chars || preserve.is_match(query) {
        return (lossless, None);
    }
    let reference = reference(content);
    let mut envelope = None;
    if (tool == "curated_feed_search_tool"
        || (tool == "webscrape_tool" && value["output_mode"] == "research"))
        && value["success"] == true
        && value["source"].is_object()
        && let Some(article) = value["content"].as_str()
        && chars(article) > 4000
    {
        let article = CharSlices::new(article);
        let length = article.len();
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
                let text = article.get(windows[i].0, windows[i].1);
                let lowercase = text.to_lowercase();
                (
                    std::cmp::Reverse(ERRORS.is_match(text)),
                    std::cmp::Reverse(
                        terms
                            .iter()
                            .map(|t| lowercase.matches(t.as_str()).count())
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
        let excerpts:Vec<Value>=selected.iter().map(|&i|json!({"start_offset":windows[i].0,"end_offset":windows[i].1,"text":article.get(windows[i].0,windows[i].1)})).collect();
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

#[cfg(test)]
mod retrieval_tests {
    use super::*;

    /// The previous per-window character scan, kept as the reference.
    fn text_range(s: &str, start: usize, end: usize) -> String {
        s.chars()
            .skip(start)
            .take(end.saturating_sub(start))
            .collect()
    }

    /// The previous excerpt selection over `text_range`, kept as the reference.
    fn reference_excerpts(article: &str, terms: &BTreeSet<String>) -> Vec<(usize, usize, String)> {
        let length = chars(article);
        let windows: Vec<(usize, usize)> = (0..length)
            .step_by(800)
            .map(|i| (i, (i + 800).min(length)))
            .collect();
        let mut selected = BTreeSet::from([0, windows.len() - 1]);
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
        selected
            .iter()
            .map(|&i| {
                let (start, end) = windows[i];
                (start, end, text_range(article, start, end))
            })
            .collect()
    }

    fn excerpts(compacted: &str) -> Vec<(usize, usize, String)> {
        let value: Value = serde_json::from_str(compacted).unwrap();
        value["preview"]["excerpts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    e["start_offset"].as_u64().unwrap() as usize,
                    e["end_offset"].as_u64().unwrap() as usize,
                    e["text"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    #[test]
    fn character_slices_match_the_reference_scan() {
        for text in ["", "a", "雪🌲e\u{301}x", &"Ünïcödé 雪🌲 ".repeat(37)] {
            let slices = CharSlices::new(text);
            let length = chars(text);
            for start in 0..=length + 2 {
                for end in 0..=length + 2 {
                    assert_eq!(slices.get(start, end), text_range(text, start, end));
                }
            }
        }
    }

    #[test]
    fn large_research_excerpts_match_the_reference_and_stay_linear() {
        let config = Config::new(json!({"llms":{"main":{"base_url":"http://model.invalid", "model_name":"fixture"}}, "workflow":{"_type":"daedalus_rust_agent", "llm_name":"main"}}), Default::default()).unwrap();
        let settings = Settings::new(&config);
        let query = "summarize glacier telemetry";
        let terms = terms(query);
        let document = |filler: usize| {
            format!(
                "{}Glacier telemetry 雪🌲 failed calibration.{}glacier TELEMETRY again{}",
                "Neutral 雪🌲 prose. ".repeat(filler),
                "More 🌲 context here. ".repeat(filler),
                "Closing ü notes. ".repeat(filler / 2)
            )
        };
        // A small article: identical offsets and text to the previous scan.
        let small = document(300);
        let source = json!({"success":true, "source":{"url":"https://source.test/a"},
            "output_mode":"research", "content":small});
        let (_, compacted) = preview(&source.to_string(), "webscrape_tool", query, &settings);
        assert_eq!(
            excerpts(&compacted.unwrap()),
            reference_excerpts(&small, &terms)
        );
        // About a million multibyte characters, within the default size cap.
        let large = document(22_000);
        assert!(chars(&large) > 1_000_000);
        let source = json!({"success":true, "source":{"url":"https://source.test/b"},
            "output_mode":"research", "content":large});
        let content = source.to_string();
        let started = Instant::now();
        let (_, compacted) = preview(&content, "webscrape_tool", query, &settings);
        let elapsed = started.elapsed();
        let selected = excerpts(&compacted.unwrap());
        for (start, end, text) in &selected {
            assert_eq!(text, &text_range(&large, *start, *end));
        }
        assert!(
            selected
                .iter()
                .any(|(_, _, text)| text.contains("failed calibration")),
            "the caution window is selected"
        );
        // The previous scan took about 13 seconds here in a debug build.
        assert!(
            elapsed < Duration::from_secs(8),
            "excerpt ranking must stay linear: {elapsed:?}"
        );
    }

    #[test]
    fn lossless_compaction_preserves_numbers_that_float_would_change() {
        let config = Config::new(json!({"llms":{"main":{"base_url":"http://model.invalid", "model_name":"fixture"}}, "workflow":{"_type":"daedalus_rust_agent", "llm_name":"main"}}), Default::default()).unwrap();
        let settings = Settings::new(&config);
        for token in [
            "1e-999",
            "-1e-999",
            "1.000000000000000000001",
            "1e999",
            "-1e999",
        ] {
            let number: Value = serde_json::from_str(token).unwrap();
            assert_eq!(
                compact(&number),
                number.to_string(),
                "direct serializer: {token}"
            );
            let body = format!("{{\n{}\"value\":{token}\n}}", " ".repeat(300));
            for original in [
                body.clone(),
                format!("<result>{body}</result>"),
                format!("```json\n{body}\n```"),
            ] {
                let (result, reversible) =
                    preview(&original, "numeric_result", "exact values", &settings);
                assert_eq!(result, original, "{token}");
                assert!(reversible.is_none());
            }
        }
    }

    #[test]
    fn exact_numeric_values_still_allow_lossless_minification() {
        let config = Config::new(json!({"llms":{"main":{"base_url":"http://model.invalid", "model_name":"fixture"}}, "workflow":{"_type":"daedalus_rust_agent", "llm_name":"main"}}), Default::default()).unwrap();
        let settings = Settings::new(&config);
        for (token, expected) in [
            ("1.2500", "1.25"),
            ("1.25e+04", "12500.0"),
            ("1e+20", "1e+20"),
            ("0e-999", "0.0"),
            ("-0.0000", "-0.0"),
            (
                "1234567890123456789012345678901234567890",
                "1234567890123456789012345678901234567890",
            ),
        ] {
            let original = format!("{{\n{}\"value\":{token}\n}}", " ".repeat(300));
            let (result, reversible) =
                preview(&original, "numeric_result", "exact values", &settings);
            assert_eq!(result, format!("{{\"value\":{expected}}}"));
            assert!(reversible.is_none());
        }
    }

    #[test]
    fn research_preview_is_explicit_and_recovers_unicode_evidence() {
        let config = Config::new(json!({"llms":{"main":{"base_url":"http://model.invalid", "model_name":"fixture"}}, "workflow":{"_type":"daedalus_rust_agent", "llm_name":"main"}}), Default::default()).unwrap();
        let settings = Settings::new(&config);
        let article = format!(
            "{}雪🌲HIDDEN_MARKER{}",
            "Neutral material. ".repeat(1400),
            "More context. ".repeat(1200)
        );
        let mut source = json!({"success":true, "source":{"url":"https://source.test/article"}, "output_mode":"research", "content":article});
        let original = source.to_string();
        let (_, compacted) = preview(&original, "webscrape_tool", "summarize article", &settings);
        let compacted = compacted.unwrap();
        assert!(
            preview(
                &original,
                "webscrape_tool",
                "Read each URL once and preserve exact Unicode labels",
                &settings
            )
            .1
            .is_some()
        );
        for query in [
            "List each fact",
            "Read each line",
            "Return exact source text",
            "Are there no corrections?",
        ] {
            assert!(
                preview(&original, "webscrape_tool", query, &settings)
                    .1
                    .is_none(),
                "{query}"
            );
        }
        assert!(chars(&compacted) < chars(&original) / 2);
        assert!(!compacted.contains("HIDDEN_MARKER"));
        let value: Value = serde_json::from_str(&compacted).unwrap();
        assert_eq!(value[MARKER]["reference"], reference(&original));
        assert_eq!(value["preview"]["source"], source["source"]);
        for excerpt in value["preview"]["excerpts"].as_array().unwrap() {
            assert_eq!(
                excerpt["text"],
                text_range(
                    &article,
                    excerpt["start_offset"].as_u64().unwrap() as usize,
                    excerpt["end_offset"].as_u64().unwrap() as usize
                )
            );
        }
        assert!(
            preview(
                &original,
                "webscrape_tool",
                "read every word verbatim",
                &settings
            )
            .1
            .is_none()
        );
        assert!(
            preview(&original, "unrelated_tool", "summarize", &settings)
                .1
                .is_none()
        );
        source["output_mode"] = json!("full");
        assert!(
            preview(
                &source.to_string(),
                "webscrape_tool",
                "summarize",
                &settings
            )
            .1
            .is_none()
        );
        assert!(
            preview(&article, "webscrape_tool", "summarize", &settings)
                .1
                .is_none()
        );
    }

    fn encoded(content: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(3));
        encoder.write_all(content).unwrap();
        [b"z1".as_slice(), &encoder.finish().unwrap()].concat()
    }

    #[test]
    fn compressed_reader_checks_version_utf8_checksum_and_stream_end() {
        let text = "雪🌲e\u{301}".repeat(20_000);
        let payload = encoded(text.as_bytes());
        assert_eq!(decode(&payload).unwrap(), Some(text));
        for end in [2, 3, payload.len() / 2, payload.len() - 1] {
            assert!(decode(&payload[..end]).is_err(), "truncated at {end}");
        }
        let mut corrupt = payload.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(decode(&corrupt).is_err());
        assert!(decode(&encoded(b"\xff")).is_err());
        assert_eq!(decode(b"z0legacy").unwrap(), None);
        assert_eq!(decode(b"").unwrap(), None);
        assert_eq!(decode(&encoded(b"")).unwrap(), Some(String::new()));
        let trailing = [encoded(b"compatible"), b"trailing".to_vec()].concat();
        assert_eq!(decode(&trailing).unwrap().as_deref(), Some("compatible"));
    }

    #[test]
    fn only_lowercase_opaque_references_are_accepted() {
        assert!(valid_reference(&reference("雪🌲")));
        for invalid in [
            "tor_".to_string(),
            format!("tor_{}", "A".repeat(32)),
            format!("tor_{}\n", "a".repeat(32)),
            format!("tor_{}", "雪".repeat(32)),
        ] {
            assert!(!valid_reference(&invalid));
        }
    }
}
