//! Pinned Python document rendering rules, independent of storage and transport.
use crate::{
    memory_tools::trim,
    output::{chars, clip},
};
use anyhow::{Result, anyhow, bail};
use regex::{Captures, Regex};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};

static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/document-text.json")).unwrap()
});
static ALNUM: LazyLock<Vec<(u32, u32)>> = LazyLock::new(|| {
    CONTRACT["alnum_ranges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (v[0].as_u64().unwrap() as u32, v[1].as_u64().unwrap() as u32))
        .collect()
});
static HTML: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"</?(?:span|div|p|font)[^>]*>").unwrap());
static BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<br[\s\x1c-\x1f]*/?>").unwrap());
static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").unwrap());
static SPACE_NL: LazyLock<Regex> = LazyLock::new(|| Regex::new(" +\n").unwrap());
static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new("\n{3,}").unwrap());
static EMPTY_ROW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\|[\s\x1c-\x1f|]*$").unwrap());
fn alnum(c: char) -> bool {
    let n = c as u32;
    let index = ALNUM.partition_point(|(start, _)| *start <= n);
    index > 0 && n <= ALNUM[index - 1].1
}
pub(crate) fn unescape(text: &str) -> String {
    static ENTITY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\x0c <&#;]{1,32};?)").unwrap()
    });
    ENTITY
        .replace_all(text, |capture: &Captures<'_>| {
            let value = &capture[1];
            if let Some(number) = value.strip_prefix('#') {
                let number = number.trim_end_matches(';');
                let radix = if number.starts_with(['x', 'X']) {
                    16
                } else {
                    10
                };
                let number = if radix == 16 { &number[1..] } else { number };
                let n = u32::from_str_radix(number, radix).unwrap_or(u32::MAX);
                if let Some(value) = CONTRACT["invalid_charrefs"].get(n.to_string()) {
                    return value.as_str().unwrap().to_owned();
                }
                if (0xd800..=0xdfff).contains(&n) || n > 0x10ffff {
                    return "�".into();
                }
                if (1..=8).contains(&n)
                    || n == 11
                    || (14..=31).contains(&n)
                    || (0x7f..=0x9f).contains(&n)
                    || (0xfdd0..=0xfdef).contains(&n)
                    || n & 0xffff == 0xfffe
                    || n & 0xffff == 0xffff
                {
                    return String::new();
                }
                return char::from_u32(n).unwrap().to_string();
            }
            if let Some(entity) = CONTRACT["html_entities"].get(value) {
                return entity.as_str().unwrap().into();
            }
            let boundaries: Vec<_> = value.char_indices().map(|(i, _)| i).collect();
            for &end in boundaries.iter().skip(2).rev() {
                if let Some(entity) = CONTRACT["html_entities"].get(&value[..end]) {
                    return format!("{}{}", entity.as_str().unwrap(), &value[end..]);
                }
            }
            format!("&{value}")
        })
        .into_owned()
}
pub fn clean(text: &str) -> String {
    let text = unescape(text);
    let text = BREAK.replace_all(&text, "\n");
    let text = HTML.replace_all(&text, "");
    let text: String = text
        .chars()
        .map(|c| match c {
            '\u{a0}' => " ".into(),
            '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}' => String::new(),
            '\u{2028}' | '\u{2029}' => "\n".into(),
            '‘' | '’' => "'".into(),
            '“' | '”' => "\"".into(),
            '–' => "-".into(),
            '—' => "--".into(),
            '…' => "...".into(),
            c => c.to_string(),
        })
        .collect();
    // re.sub consumes both word characters, so adjacent matches cannot overlap.
    let source: Vec<_> = text.chars().collect();
    let mut text = String::new();
    let mut i = 0;
    while i < source.len() {
        if i + 3 < source.len()
            && (alnum(source[i]) || source[i] == '_')
            && source[i + 1] == '-'
            && source[i + 2] == '\n'
            && (alnum(source[i + 3]) || source[i + 3] == '_')
        {
            text.push(source[i]);
            text.push(source[i + 3]);
            i += 4;
        } else {
            text.push(source[i]);
            i += 1;
        }
    }
    let text = WS.replace_all(&text, " ");
    let text = SPACE_NL.replace_all(&text, "\n");
    trim(&LINES.replace_all(&text, "\n\n")).into()
}
pub fn table(text: &str) -> String {
    let text = unescape(text);
    let text = HTML.replace_all(&text, "").replace('\u{a0}', " ");
    let mut lines: Vec<_> = trim(&text).split('\n').collect();
    while lines.last().is_some_and(|line| EMPTY_ROW.is_match(line)) {
        lines.pop();
    }
    if lines.is_empty() {
        return text;
    }
    let columns = lines[0].matches('|').count().saturating_sub(1);
    if columns == 0 {
        return lines.join("\n");
    }
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            if !trim(line).starts_with('|') {
                return (*line).to_string();
            }
            let mut cells: Vec<_> = trim(line).trim_matches('|').split('|').collect();
            if i == 1
                && cells
                    .iter()
                    .all(|cell| trim(cell).replace('-', "").is_empty())
            {
                cells = vec![" --- "; columns];
            } else {
                cells.resize(columns, "");
            }
            format!(
                "| {} |",
                cells.into_iter().map(trim).collect::<Vec<_>>().join(" | ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
pub fn limit(text: &str, limit: Option<usize>) -> (String, bool) {
    let Some(limit) = limit.filter(|limit| chars(text) > *limit) else {
        return (text.into(), false);
    };
    let marker = "\n\n[... middle omitted to fit inline document limit ...]\n\n";
    if limit <= marker.len() {
        return (clip(text, limit), true);
    }
    let remaining = limit - marker.len();
    let tail = remaining / 2;
    (
        format!(
            "{}{}{}",
            clip(text, remaining.div_ceil(2)),
            marker,
            text.chars().skip(chars(text) - tail).collect::<String>()
        ),
        true,
    )
}
pub fn filename(source: &str) -> String {
    static UNSAFE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9._-]+").unwrap());
    let base = trim(source).rsplit('/').next().unwrap();
    let stem = base.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(base);
    let safe = UNSAFE.replace_all(stem, "_");
    let safe = safe.trim_matches(['.', '_', '-']);
    format!(
        "{}.md",
        if safe.is_empty() {
            "document".into()
        } else {
            clip(safe, 128)
        }
    )
}
pub(super) fn attribute_error(value: &Value, attribute: &str) -> anyhow::Error {
    let kind = match value {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.to_string().contains(['.', 'e', 'E']) => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    };
    anyhow!("'{kind}' object has no attribute '{attribute}'")
}
fn field<'a>(value: &'a Value, key: &str, default: &'a Value) -> Result<&'a Value> {
    Ok(value
        .as_object()
        .ok_or_else(|| attribute_error(value, "get"))?
        .get(key)
        .unwrap_or(default))
}
fn text(value: &Value) -> Result<&str> {
    value
        .as_str()
        .map(trim)
        .ok_or_else(|| anyhow!("Invalid extraction text"))
}
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Bool(v) => Some(if *v { 1. } else { 0. }),
        _ => value.as_f64(),
    }
}
fn integer(value: &Value) -> Option<String> {
    match value {
        Value::Bool(value) => Some(u8::from(*value).to_string()),
        Value::Number(value) => {
            let value = value.to_string();
            (!value.contains(['.', 'e', 'E'])).then(
                || {
                    if value == "-0" { "0".into() } else { value }
                },
            )
        }
        _ => None,
    }
}
fn compare(a: &Value, b: &Value) -> Option<Ordering> {
    if a == b {
        return Some(Ordering::Equal);
    }
    if let (Some(a), Some(b)) = (integer(a), integer(b)) {
        let negative_a = a.starts_with('-');
        let negative_b = b.starts_with('-');
        let magnitude = a
            .trim_start_matches('-')
            .len()
            .cmp(&b.trim_start_matches('-').len())
            .then_with(|| a.trim_start_matches('-').cmp(b.trim_start_matches('-')));
        return Some(match (negative_a, negative_b) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (true, true) => magnitude.reverse(),
            _ => magnitude,
        });
    }
    if let (Some(a), Some(b)) = (number(a), number(b)) {
        return a.partial_cmp(&b);
    }
    if let (Some(a), Some(b)) = (a.as_str(), b.as_str()) {
        return Some(a.cmp(b));
    }
    if let (Some(a), Some(b)) = (a.as_array(), b.as_array()) {
        for (a, b) in a.iter().zip(b) {
            let order = compare(a, b)?;
            if order != Ordering::Equal {
                return Some(order);
            }
        }
        return Some(a.len().cmp(&b.len()));
    }
    None
}
fn page_key(value: &Value) -> Result<String> {
    if value.is_object() || value.is_array() {
        bail!("Invalid extraction page");
    }
    Ok(integer(value)
        .map(|n| format!("number:{n}"))
        .or_else(|| {
            number(value).map(|n| {
                if n == 0. {
                    "number:0".into()
                } else if n.fract() == 0. {
                    format!("number:{n:.0}")
                } else {
                    format!("number:{n}")
                }
            })
        })
        .unwrap_or_else(|| value.to_string()))
}
fn words(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .chars()
        .filter(|c| {
            c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || c.is_whitespace()
                || ('\u{1c}'..='\u{1f}').contains(c)
        })
        .collect::<String>()
        .split(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn quality(text: &str) -> f64 {
    if text.is_empty() {
        return 0.;
    }
    text.chars()
        .filter(|c| alnum(*c) || c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(c))
        .count() as f64
        / chars(text) as f64
}
/// Stable merge sort. Python's sorted() raises TypeError for an incomparable
/// pair and the renderer keeps the extraction order. Treating that pair as
/// equal is not a total order, which the standard sort may reject with a
/// panic, so stop and report false at the first pair that cannot be ordered.
fn stable_sort(items: &mut [usize], order: impl Fn(usize, usize) -> Option<Ordering>) -> bool {
    let mut buffer = items.to_vec();
    let mut width = 1;
    while width < items.len() {
        for start in (0..items.len()).step_by(2 * width) {
            let middle = (start + width).min(items.len());
            let end = (start + 2 * width).min(items.len());
            let (mut left, mut right) = (start, middle);
            for slot in &mut buffer[start..end] {
                let first = if left == middle {
                    false
                } else if right == end {
                    true
                } else {
                    match order(items[left], items[right]) {
                        Some(ordering) => ordering != Ordering::Greater,
                        None => return false,
                    }
                };
                if first {
                    *slot = items[left];
                    left += 1;
                } else {
                    *slot = items[right];
                    right += 1;
                }
            }
        }
        items.copy_from_slice(&buffer);
        width *= 2;
    }
    true
}
pub fn markdown(results: &Value) -> Result<(String, usize)> {
    if !crate::config::truthy(results) {
        return Ok((String::new(), 0));
    }
    let Some(result) = results
        .as_array()
        .ok_or_else(|| anyhow!("Invalid extraction result"))?
        .first()
    else {
        return Ok((String::new(), 0));
    };
    if !crate::config::truthy(result) {
        return Ok((String::new(), 0));
    }
    let entries = result
        .as_array()
        .ok_or_else(|| anyhow!("Invalid extraction entries"))?;
    let empty = json!({});
    let zero = json!(0);
    let blank = json!("");
    let unknown = json!(-1);
    let mut keys = Vec::new();
    for entry in entries {
        if entry
            .get("document_type")
            .is_some_and(|kind| kind.is_array() || kind.is_object())
        {
            bail!("Unhashable extraction document type");
        }
        let meta = field(entry, "metadata", &empty)?;
        let content = field(meta, "content_metadata", &empty)?;
        let content = if crate::config::truthy(content) {
            content
        } else {
            &empty
        };
        let hierarchy = field(content, "hierarchy", &empty)?;
        let hierarchy = if crate::config::truthy(hierarchy) {
            hierarchy
        } else {
            &empty
        };
        keys.push([
            field(content, "page_number", &zero)?,
            field(hierarchy, "y0", &zero)?,
            field(hierarchy, "x0", &zero)?,
        ]);
    }
    let mut indices: Vec<_> = (0..entries.len()).collect();
    let order = |a: usize, b: usize| {
        for (a, b) in keys[a].iter().zip(keys[b].iter()) {
            match compare(a, b) {
                Some(Ordering::Equal) => {}
                order => return order,
            }
        }
        Some(Ordering::Equal)
    };
    if !stable_sort(&mut indices, order) {
        indices = (0..entries.len()).collect();
    }
    type TextCandidate<'a> = (usize, &'a str, BTreeSet<String>);
    let mut groups: BTreeMap<String, Vec<TextCandidate<'_>>> = BTreeMap::new();
    let dedup_indices = if entries.len() > 1 {
        indices.as_slice()
    } else {
        &[]
    };
    for &i in dedup_indices {
        let entry = &entries[i];
        if field(entry, "document_type", &blank)? != "text" {
            continue;
        }
        let meta = field(entry, "metadata", &empty)?;
        let page = field(
            field(meta, "content_metadata", &empty)?,
            "page_number",
            &unknown,
        )?;
        let content = text(field(meta, "content", &blank)?)?;
        if content.is_empty() {
            continue;
        }
        let words = words(content);
        if words.is_empty() {
            continue;
        }
        groups
            .entry(page_key(page)?)
            .or_default()
            .push((i, content, words));
    }
    let mut dropped = BTreeSet::new();
    for group in groups.values() {
        for (i, (index, a, words_a)) in group.iter().enumerate() {
            if dropped.contains(index) {
                continue;
            }
            for (other, b, words_b) in &group[i + 1..] {
                if dropped.contains(other) {
                    continue;
                }
                if words_a.intersection(words_b).count() * 2 >= words_a.union(words_b).count() {
                    dropped.insert(if quality(a) >= quality(b) {
                        *other
                    } else {
                        *index
                    });
                }
            }
        }
    }
    let mut current = Value::Null;
    let mut pages = BTreeSet::new();
    let mut parts = Vec::new();
    for i in indices.into_iter().filter(|i| !dropped.contains(i)) {
        let entry = &entries[i];
        let meta = field(entry, "metadata", &empty)?;
        let page = field(
            field(meta, "content_metadata", &empty)?,
            "page_number",
            &Value::Null,
        )?;
        if integer(page).is_some() {
            pages.insert(page_key(page)?);
        }
        if !page.is_null() && compare(page, &current) != Some(Ordering::Equal) {
            if !current.is_null() {
                parts.extend([String::new(), "---".into(), String::new()]);
            }
            current = page.clone();
        }
        let kind = field(entry, "document_type", &blank)?
            .as_str()
            .unwrap_or("");
        let value = match kind {
            "text" => clean(text(field(meta, "content", &blank)?)?),
            "structured" => table(text(field(
                field(meta, "table_metadata", &empty)?,
                "table_content",
                &blank,
            )?)?),
            "image" | "audio" => {
                let content = text(field(
                    field(
                        meta,
                        if kind == "image" {
                            "image_metadata"
                        } else {
                            "audio_metadata"
                        },
                        &empty,
                    )?,
                    if kind == "image" {
                        "caption"
                    } else {
                        "audio_transcript"
                    },
                    &blank,
                )?)?;
                if content.is_empty() {
                    String::new()
                } else if kind == "image" {
                    format!("*[Image: {content}]*")
                } else {
                    format!("> {content}")
                }
            }
            _ => String::new(),
        };
        if !value.is_empty() {
            parts.extend([value, String::new()]);
        }
    }
    Ok((
        LINES
            .replace_all(trim(&parts.join("\n")), "\n\n")
            .into_owned(),
        pages.len(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn expand(value: Value) -> Value {
        match value {
            Value::Object(map) if map.len() == 1 && map.contains_key("$string_parts") => json!(
                map["$string_parts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<String>()
            ),
            Value::Object(map) => {
                Value::Object(map.into_iter().map(|(k, v)| (k, expand(v))).collect())
            }
            Value::Array(values) => Value::Array(values.into_iter().map(expand).collect()),
            other => other,
        }
    }
    #[test]
    fn incomparable_page_numbers_keep_extraction_order() {
        // Python's sorted() raises TypeError for int/str page numbers and the
        // renderer keeps NV-Ingest's order. Treating those pairs as equal is
        // not a total order, and the standard sort panicked on this input.
        let pages = json!([
            8, "s", 0, 0, 4, 5, 2, 5, 6, "s", 2, 1, 6, 8, 5, "s", 0, "s", 0, 4, 2
        ]);
        let entries: Vec<Value> = pages
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, page)| {
                json!({"document_type":"text","metadata":{"content":format!("Entry{i}"),
                    "content_metadata":{"page_number":page}}})
            })
            .collect();
        let (rendered, pages) = std::panic::catch_unwind(|| markdown(&json!([entries])))
            .expect("rendering must not panic")
            .unwrap();
        let order: Vec<_> = rendered
            .split('\n')
            .filter(|line| line.starts_with("Entry"))
            .collect();
        let expected: Vec<_> = (0..entries.len()).map(|i| format!("Entry{i}")).collect();
        assert_eq!(order, expected);
        assert_eq!(pages, 7);
    }
    #[test]
    fn pinned_document_rendering() {
        let fixture =
            expand(serde_json::from_str(include_str!("../tests/fixtures/documents.json")).unwrap());
        for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let input = &case["input"];
            let actual: Result<Value> = match case["kind"].as_str().unwrap() {
                "clean" => Ok(json!(clean(input.as_str().unwrap()))),
                "table" => Ok(json!(table(input.as_str().unwrap()))),
                "limit" => Ok(json!(limit(
                    input[0].as_str().unwrap(),
                    input[1].as_u64().map(|n| n as usize)
                ))),
                "filename" => Ok(json!(filename(input.as_str().unwrap_or("")))),
                "markdown" => markdown(input).map(|v| json!(v)),
                _ => continue,
            };
            if let Some(expected) = case["expected"].get("ok") {
                assert_eq!(&actual.unwrap(), expected, "case {i}");
            } else {
                assert!(actual.is_err(), "case {i}");
            }
        }
    }
}
