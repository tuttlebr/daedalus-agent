//! Python JSON permits isolated UTF-16 surrogates, which Rust strings cannot
//! contain. Reserve unused private-use characters while rendering (one scalar,
//! non-word, non-whitespace). Reject UTF-8 output if any survives cleanup and
//! truncation, just as Python's response encoder does.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub type Surrogates = BTreeMap<char, u32>;
pub type Decoder = fn(&[u8]) -> Option<(Value, Surrogates)>;

/// A Python tool result may contain code units that can be stored in ASCII JSON
/// but cannot cross a UTF-8 stream. Keep that distinction until after receipt
/// completion; an encoding failure must not leave an accepted write pending.
#[derive(Clone, Debug)]
pub struct Text {
    value: String,
    surrogates: Surrogates,
}
impl Text {
    pub fn new(value: String, mut surrogates: Surrogates) -> Self {
        surrogates.retain(|marker, _| value.contains(*marker));
        Self { value, surrogates }
    }

    pub fn ascii_json(&self) -> String {
        ascii_string(&self.value, &self.surrogates)
    }

    pub fn into_utf8(self) -> anyhow::Result<String> {
        if !self.surrogates.is_empty() {
            anyhow::bail!("Document result cannot be UTF-8 encoded");
        }
        Ok(self.value)
    }

    /// Fixture observation only. Never send internal placeholder characters to
    /// a caller, including when comparison data itself must be valid UTF-8.
    #[cfg(test)]
    pub fn observation(self) -> Value {
        let points = self
            .value
            .chars()
            .map(|c| self.surrogates.get(&c).copied().unwrap_or(u32::from(c)))
            .collect::<Vec<_>>();
        match self.into_utf8() {
            Ok(value) => Value::String(value),
            Err(_) => serde_json::json!({"$codepoints":points}),
        }
    }
}
impl From<String> for Text {
    fn from(value: String) -> Self {
        Self::new(value, Surrogates::new())
    }
}
impl From<&str> for Text {
    fn from(value: &str) -> Self {
        value.to_owned().into()
    }
}

/// Python's ensure_ascii string encoding, restoring only markers belonging to
/// this decoded string. Literal escape sequences and unrelated text stay intact.
pub fn ascii_string(text: &str, surrogates: &Surrogates) -> String {
    let mut output = String::from("\"");
    for c in text.chars() {
        if let Some(unit) = surrogates.get(&c) {
            output.push_str(&format!("\\u{unit:04x}"));
            continue;
        }
        match c {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            ' '..='~' => output.push(c),
            _ => {
                for unit in c.encode_utf16(&mut [0; 2]) {
                    output.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    output.push('"');
    output
}

pub fn decode(raw: &[u8]) -> Option<(Value, Surrogates)> {
    decode_with(raw, |bytes| serde_json::from_slice(bytes).ok())
}

pub fn decode_indexed(raw: &[u8]) -> Option<(Value, Surrogates)> {
    decode_with(raw, parse_indexed)
}

pub fn decode_with_depth(raw: &[u8], limit: usize) -> Option<(Value, Surrogates)> {
    decode_with(raw, |bytes| parse_indexed_depth(bytes, limit))
}

pub fn parse_indexed(raw: &[u8]) -> Option<Value> {
    parse_indexed_depth(raw, 1024)
}

fn parse_indexed_depth(raw: &[u8], limit: usize) -> Option<Value> {
    parse_indexed_with(raw, limit, Some)
}

pub(crate) fn parse_indexed_with(
    raw: &[u8],
    limit: usize,
    scalar: impl Fn(Value) -> Option<Value>,
) -> Option<Value> {
    // The SDK accepts JSON fields deeper than serde's default 128. Containers
    // live on a bounded heap stack; serde only decodes nonrecursive tokens.
    enum Phase {
        Value(bool),
        Key(bool),
        Colon,
        After,
    }
    struct Frame {
        value: Value,
        key: Option<String>,
        phase: Phase,
    }
    fn string(raw: &[u8], at: &mut usize) -> Option<String> {
        let start = *at;
        if raw.get(start) != Some(&b'"') {
            return None;
        }
        *at += 1;
        while let Some(&byte) = raw.get(*at) {
            *at += 1;
            if byte == b'\\' {
                *at += 1;
            } else if byte == b'"' {
                return serde_json::from_slice(&raw[start..*at]).ok();
            }
        }
        None
    }
    fn add(value: Value, frames: &mut [Frame], root: &mut Option<Value>) -> Option<()> {
        if let Some(frame) = frames.last_mut() {
            match &mut frame.value {
                Value::Array(items) => items.push(value),
                Value::Object(items) => {
                    items.insert(frame.key.take()?, value);
                }
                _ => return None,
            }
            frame.phase = Phase::After;
        } else {
            *root = Some(value)
        }
        Some(())
    }
    let (mut at, mut frames, mut root) = (0usize, Vec::<Frame>::new(), None);
    loop {
        while raw
            .get(at)
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        {
            at += 1;
        }
        if frames.is_empty() && root.is_some() {
            return if at == raw.len() { root } else { None };
        }
        let byte = *raw.get(at)?;
        let close = if let Some(frame) = frames.last_mut() {
            let end = if frame.value.is_array() { b']' } else { b'}' };
            match frame.phase {
                Phase::After if byte == b',' => {
                    frame.phase = if end == b']' {
                        Phase::Value(false)
                    } else {
                        Phase::Key(false)
                    };
                    at += 1;
                    continue;
                }
                Phase::After => {
                    if byte != end {
                        return None;
                    }
                    true
                }
                Phase::Key(allow_end) => {
                    if byte == end && allow_end {
                        true
                    } else {
                        frame.key = Some(string(raw, &mut at)?);
                        frame.phase = Phase::Colon;
                        continue;
                    }
                }
                Phase::Colon => {
                    if byte != b':' {
                        return None;
                    }
                    at += 1;
                    frame.phase = Phase::Value(false);
                    continue;
                }
                Phase::Value(allow_end) => allow_end && byte == end,
            }
        } else {
            false
        };
        if close {
            let value = frames.pop()?.value;
            at += 1;
            add(value, &mut frames, &mut root)?;
            continue;
        }
        let value = match byte {
            b'[' | b'{' => {
                if frames.len() >= limit {
                    return None;
                }
                frames.push(Frame {
                    value: if byte == b'[' {
                        Value::Array(Vec::new())
                    } else {
                        Value::Object(Default::default())
                    },
                    key: None,
                    phase: if byte == b'[' {
                        Phase::Value(true)
                    } else {
                        Phase::Key(true)
                    },
                });
                at += 1;
                continue;
            }
            b'"' => Value::String(string(raw, &mut at)?),
            _ => {
                let start = at;
                while raw.get(at).is_some_and(|b| {
                    !matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}')
                }) {
                    at += 1;
                }
                scalar(serde_json::from_slice(&raw[start..at]).ok()?)?
            }
        };
        add(value, &mut frames, &mut root)?;
    }
}

pub(crate) fn decode_with(
    raw: &[u8],
    parse: impl Fn(&[u8]) -> Option<Value>,
) -> Option<(Value, Surrogates)> {
    if let Some(value) = parse(raw) {
        return Some((value, Surrogates::new()));
    }
    let text = std::str::from_utf8(raw).ok()?;
    let mut used: BTreeSet<u32> = text.chars().map(u32::from).collect();
    // Cleanup can materialize a private-use scalar from an HTML entity.
    used.extend(crate::document_text::clean(text).chars().map(u32::from));
    let mut replacements = Vec::new();
    let mut units = BTreeSet::new();
    let hex = |i| {
        raw.get(i..i + 6)
            .filter(|s| s.starts_with(b"\\u"))
            .and_then(|s| std::str::from_utf8(&s[2..]).ok())
            .and_then(|s| u32::from_str_radix(s, 16).ok())
    };
    let (mut i, mut string) = (0, false);
    while i < raw.len() {
        if raw[i] == b'"' {
            string = !string;
            i += 1;
        } else if string && raw[i] == b'\\' {
            if let Some(point) = hex(i) {
                if (0xd800..=0xdbff).contains(&point)
                    && let Some(low) = hex(i + 6).filter(|n| (0xdc00..=0xdfff).contains(n))
                {
                    used.insert(0x10000 + ((point - 0xd800) << 10) + low - 0xdc00);
                    i += 12;
                    continue;
                }
                if (0xd800..=0xdfff).contains(&point) {
                    units.insert(point);
                    replacements.push((i, point));
                } else {
                    used.insert(point);
                }
                i += 6;
            } else {
                i += 2;
            }
        } else {
            i += 1;
        }
    }
    if replacements.is_empty() {
        return None;
    }
    let mut available = (0xf0000..=0xffffd)
        .chain(0x100000..=0x10fffd)
        .chain(0xe000..=0xf8ff)
        .filter(|n| !used.contains(n));
    let mut mapping = BTreeMap::new();
    for point in units {
        mapping.insert(point, char::from_u32(available.next()?)?);
    }
    let mut converted = String::with_capacity(text.len());
    let mut previous = 0;
    for (offset, point) in replacements {
        converted.push_str(&text[previous..offset]);
        converted.push(mapping[&point]);
        previous = offset + 6;
    }
    converted.push_str(&text[previous..]);
    parse(converted.as_bytes()).map(|value| {
        (
            value,
            mapping
                .into_iter()
                .map(|(unit, marker)| (marker, unit))
                .collect(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn surrogate_markers_are_distinct_and_do_not_collide_with_document_text() {
        let (value, markers) =
            decode(br#"{"content":"\ud800A\udfff\ud800\ud83c\udf32\udb80\udc00\\ud800"}"#).unwrap();
        let text = value["content"].as_str().unwrap();
        assert_eq!(markers.len(), 2);
        let keys: Vec<_> = markers.keys().copied().collect();
        assert_eq!(markers[&keys[0]], 0xd800);
        assert_eq!(markers[&keys[1]], 0xdfff);
        assert_eq!(
            text.chars().take(4).collect::<Vec<_>>(),
            vec![keys[0], 'A', keys[1], keys[0]]
        );
        assert_eq!(
            text.chars().skip(4).collect::<String>(),
            "🌲\u{f0000}\\ud800"
        );
        assert!(markers.keys().all(|c| *c != '\u{f0000}'));
        assert!(decode(br#"{"bad":"\ud800",}"#).is_none());
    }
}
