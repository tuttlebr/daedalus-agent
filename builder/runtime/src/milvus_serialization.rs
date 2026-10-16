//! The pinned PyMilvus writer's string/JSON boundary, including orjson's
//! rejection rules and its fallback to Python JSON for deeply nested values.
use crate::{document_json::Surrogates, milvus_index_proto::FieldSchema};
use anyhow::{Result, anyhow};
use serde_json::Value;

pub fn mismatch(message: &str) -> anyhow::Error {
    anyhow!("<DataNotMatchException: (code=1, message={message})>")
}
pub fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.to_string().contains(['.', 'e', 'E']) => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}
pub fn field_error(field: &str, expected: &str, value: &Value, detail: &str) -> anyhow::Error {
    mismatch(&format!(
        "The Input data type is inconsistent with defined schema, {{{field}}} field should be a {expected}, but got a {{<class '{}'>}} instead. Detail: {detail}",
        kind(value)
    ))
}
pub fn varchar(value: &Value, field: &FieldSchema, markers: &Surrogates) -> Result<String> {
    if let Some(text) = value.as_str() {
        let points: Vec<_> = text.chars().collect();
        if let Some(start) = points.iter().position(|c| markers.contains_key(c)) {
            let count = points[start..]
                .iter()
                .take_while(|c| markers.contains_key(c))
                .count();
            let range = if count == 1 {
                format!(
                    "character '\\u{:04x}' in position {start}",
                    markers[&points[start]]
                )
            } else {
                format!("characters in position {start}-{}", start + count - 1)
            };
            return Err(field_error(
                &field.name,
                "varchar",
                value,
                &format!("'utf-8' codec can't encode {range}: surrogates not allowed"),
            ));
        }
        return Ok(text.into());
    }
    let keys;
    let items: Vec<_> = match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(object) => {
            keys = object
                .keys()
                .cloned()
                .map(Value::String)
                .collect::<Vec<_>>();
            keys.iter().collect()
        }
        _ => {
            return Err(field_error(
                &field.name,
                "varchar",
                value,
                &format!("'{}' object is not iterable", kind(value)),
            ));
        }
    };
    let maximum = field
        .type_params
        .iter()
        .find(|p| p.key == "max_length")
        .and_then(|p| p.value.parse::<usize>().ok())
        .unwrap_or(65535);
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(anyhow!(
                "<ParamError: (code=1, message=field ({}) expects string input, got: <class '{}'>)>",
                field.name,
                kind(item)
            ));
        };
        if text.chars().count() > maximum {
            return Err(anyhow!(
                "<ParamError: (code=1, message=invalid input of field ({}), length of string exceeds max length. length: {}, max length: {maximum})>",
                field.name,
                text.chars().count()
            ));
        }
    }
    Err(field_error(
        &field.name,
        "varchar",
        value,
        "bad argument type for built-in operation",
    ))
}

fn quote(text: &str, ascii: bool, markers: &Surrogates) -> String {
    use std::fmt::Write;
    let mut out = String::from("\"");
    for c in text.chars() {
        let point = markers.get(&c).copied().unwrap_or(u32::from(c));
        match point {
            8 => out.push_str("\\b"),
            9 => out.push_str("\\t"),
            10 => out.push_str("\\n"),
            12 => out.push_str("\\f"),
            13 => out.push_str("\\r"),
            34 => out.push_str("\\\""),
            92 => out.push_str("\\\\"),
            0..=31 => write!(out, "\\u{point:04x}").unwrap(),
            _ if ascii && point > 126 => {
                if point <= 0xffff {
                    write!(out, "\\u{point:04x}").unwrap();
                } else {
                    let n = point - 0x10000;
                    write!(
                        out,
                        "\\u{:04x}\\u{:04x}",
                        0xd800 + (n >> 10),
                        0xdc00 + (n & 1023)
                    )
                    .unwrap();
                }
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}
fn encode(value: &Value, markers: &Surrogates, fallback: bool) -> Result<Vec<u8>> {
    enum Token<'a> {
        Value(&'a Value, usize),
        Text(&'a str),
        Key(&'a str),
    }
    let mut stack = vec![Token::Value(value, 0)];
    let mut out = String::new();
    while let Some(token) = stack.pop() {
        let (value, depth) = match token {
            Token::Text(text) => {
                out.push_str(text);
                continue;
            }
            Token::Key(key) => {
                if !fallback && key.chars().any(|c| markers.contains_key(&c)) {
                    return Err(anyhow!("str is not valid UTF-8: surrogates not allowed"));
                }
                out.push_str(&quote(key, fallback, markers));
                continue;
            }
            Token::Value(value, depth) => (value, depth),
        };
        match value {
            Value::Object(_) | Value::Array(_) if !fallback && depth >= 254 => {
                return Err(anyhow!("Recursion limit reached"));
            }
            Value::Object(map) => {
                out.push('{');
                stack.push(Token::Text("}"));
                for (i, (key, value)) in map.iter().enumerate().rev() {
                    stack.push(Token::Value(value, depth + 1));
                    stack.push(Token::Text(if fallback { ": " } else { ":" }));
                    stack.push(Token::Key(key));
                    if i > 0 {
                        stack.push(Token::Text(if fallback { ", " } else { "," }));
                    }
                }
            }
            Value::Array(items) => {
                out.push('[');
                stack.push(Token::Text("]"));
                for (i, value) in items.iter().enumerate().rev() {
                    stack.push(Token::Value(value, depth + 1));
                    if i > 0 {
                        stack.push(Token::Text(if fallback { ", " } else { "," }));
                    }
                }
            }
            Value::String(text) => {
                if !fallback && text.chars().any(|c| markers.contains_key(&c)) {
                    return Err(anyhow!("str is not valid UTF-8: surrogates not allowed"));
                }
                out.push_str(&quote(text, fallback, markers));
            }
            Value::Number(number) if !fallback => {
                let raw = number.to_string();
                if raw.contains(['.', 'e', 'E']) {
                    let n = number.as_f64().unwrap_or(f64::INFINITY);
                    out.push_str(
                        &serde_json::Number::from_f64(n)
                            .map(|n| n.to_string())
                            .unwrap_or_else(|| "null".into()),
                    );
                } else {
                    if number.as_i64().is_none() && number.as_u64().is_none() {
                        return Err(anyhow!("Integer exceeds 64-bit range"));
                    }
                    out.push_str(&raw);
                }
            }
            _ => out.push_str(&crate::memory_tools::json_text(value, false, true, true)),
        }
    }
    Ok(out.into_bytes())
}
fn serialized(value: &Value, markers: &Surrogates) -> Result<Vec<u8>> {
    match encode(value, markers, false) {
        Err(error) if error.to_string() == "Recursion limit reached" => {
            encode(value, markers, true)
        }
        result => result,
    }
}

struct Syntax<'a> {
    raw: &'a str,
    at: usize,
}
type SyntaxResult = std::result::Result<(), (&'static str, usize)>;
impl Syntax<'_> {
    fn byte(&self) -> Option<u8> {
        self.raw.as_bytes().get(self.at).copied()
    }
    fn space(&mut self) {
        while self
            .byte()
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.at += 1;
        }
    }
    fn error(&self) -> (&'static str, usize) {
        (
            if self.at == self.raw.len() {
                "unexpected end of data"
            } else {
                "unexpected character"
            },
            self.at,
        )
    }
    fn string(&mut self) -> SyntaxResult {
        self.at += 1;
        while let Some(byte) = self.byte() {
            match byte {
                b'"' => {
                    self.at += 1;
                    return Ok(());
                }
                0..=31 => return Err(("unexpected control character in string", self.at)),
                b'\\' => {
                    let start = self.at;
                    self.at += 1;
                    match self.byte() {
                        Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => {
                            self.at += 1
                        }
                        Some(b'u') => {
                            let unit = self.unit()?;
                            if (0xdc00..=0xdfff).contains(&unit) {
                                return Err(("invalid high surrogate in string", start));
                            }
                            if (0xd800..=0xdbff).contains(&unit) {
                                if self.raw.as_bytes().get(self.at..self.at + 2) != Some(b"\\u") {
                                    return Err(("no low surrogate in string", self.at));
                                }
                                self.at += 1;
                                let low = self.unit()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err(("invalid low surrogate in string", self.at - 6));
                                }
                            }
                        }
                        _ => return Err(("invalid escaped character in string", self.at)),
                    }
                }
                _ => self.at += 1,
            }
        }
        Err(("unexpected end of data", self.at))
    }
    fn unit(&mut self) -> std::result::Result<u32, (&'static str, usize)> {
        let escape = self.at - 1;
        self.at += 1;
        let digits = self
            .raw
            .as_bytes()
            .get(self.at..self.at + 4)
            .and_then(|s| std::str::from_utf8(s).ok())
            .and_then(|s| u32::from_str_radix(s, 16).ok())
            .ok_or(("invalid escaped sequence in string", escape))?;
        self.at += 4;
        Ok(digits)
    }
    fn value(&mut self, depth: usize) -> SyntaxResult {
        self.space();
        match self.byte() {
            Some(b'"') => self.string(),
            Some(b'[' | b'{') => {
                if depth >= 1024 {
                    return Err(("array and object recursion depth exceeded", self.at));
                }
                let object = self.byte() == Some(b'{');
                let end = if object { b'}' } else { b']' };
                self.at += 1;
                self.space();
                if self.byte() == Some(end) {
                    self.at += 1;
                    return Ok(());
                }
                loop {
                    if object {
                        if self.byte() != Some(b'"') {
                            return Err(self.error());
                        }
                        self.string()?;
                        self.space();
                        if self.byte() != Some(b':') {
                            return Err(self.error());
                        }
                        self.at += 1;
                    }
                    self.value(depth + 1)?;
                    self.space();
                    if self.byte() == Some(end) {
                        self.at += 1;
                        return Ok(());
                    }
                    if self.byte() != Some(b',') {
                        return Err(self.error());
                    }
                    let comma = self.at;
                    self.at += 1;
                    self.space();
                    if self.byte() == Some(end) {
                        return Err(("trailing comma is not allowed", comma));
                    }
                }
            }
            Some(b'n' | b't' | b'f') => {
                let token = match self.byte().unwrap() {
                    b'n' => "null",
                    b't' => "true",
                    _ => "false",
                };
                if !self.raw[self.at..].starts_with(token) {
                    if token.starts_with(&self.raw[self.at..]) {
                        return Err(("unexpected end of data", self.raw.len()));
                    }
                    return Err(self.error());
                }
                self.at += token.len();
                Ok(())
            }
            Some(b'-' | b'0'..=b'9') => {
                let start = self.at;
                if self.byte() == Some(b'-') {
                    self.at += 1;
                    if !self.byte().is_some_and(|b| b.is_ascii_digit()) {
                        return Err(("no digit after minus sign", self.at));
                    }
                }
                if self.byte() == Some(b'0') {
                    self.at += 1;
                    if self.byte().is_some_and(|b| b.is_ascii_digit()) {
                        return Err(("number with leading zero is not allowed", start));
                    }
                } else {
                    while self.byte().is_some_and(|b| b.is_ascii_digit()) {
                        self.at += 1;
                    }
                }
                if self.byte() == Some(b'.') {
                    self.at += 1;
                    if !self.byte().is_some_and(|b| b.is_ascii_digit()) {
                        return Err(("no digit after decimal point", self.at));
                    }
                    while self.byte().is_some_and(|b| b.is_ascii_digit()) {
                        self.at += 1;
                    }
                }
                if self.byte().is_some_and(|b| matches!(b, b'e' | b'E')) {
                    self.at += 1;
                    if self.byte().is_some_and(|b| matches!(b, b'+' | b'-')) {
                        self.at += 1;
                    }
                    if !self.byte().is_some_and(|b| b.is_ascii_digit()) {
                        return Err(("no digit after exponent sign", self.at));
                    }
                    while self.byte().is_some_and(|b| b.is_ascii_digit()) {
                        self.at += 1;
                    }
                }
                let token = &self.raw[start..self.at];
                if serde_json::from_str::<serde_json::Number>(token).is_err() {
                    return Err(("unexpected character", start));
                }
                if token.parse::<f64>().map_or(true, |n| !n.is_finite()) {
                    return Err(("number is infinity when parsed as double", start));
                }
                Ok(())
            }
            _ => Err(self.error()),
        }
    }
}
fn raw_json(raw: &str, markers: &Surrogates) -> std::result::Result<(), String> {
    let mut parser = Syntax { raw, at: 0 };
    let result = if raw.is_empty() {
        Err(("Input is a zero-length, empty document", 0))
    } else if raw
        .bytes()
        .all(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
    {
        Err(("input data is empty", 0))
    } else if raw.chars().any(|c| markers.contains_key(&c)) {
        Err(("str is not valid UTF-8: surrogates not allowed", 0))
    } else {
        parser.value(0).and_then(|()| {
            parser.space();
            if parser.at == raw.len() {
                Ok(())
            } else {
                Err(("unexpected content after document", parser.at))
            }
        })
    };
    result.map_err(|(message, at)| {
        let prefix = &raw[..at];
        let line = prefix.bytes().filter(|b| *b == b'\n').count() + 1;
        let column = prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1;
        format!(
            "{message}: line {line} column {column} (char {})",
            prefix.chars().count()
        )
    })
}
pub fn json_field(value: &Value, field: &str, markers: &Surrogates) -> Result<Vec<u8>> {
    if let Some(raw) = value.as_str() {
        if let Err(error) = raw_json(raw, markers) {
            let mut display = raw.chars().take(200).collect::<String>();
            if raw.chars().count() > 200 {
                display.push_str("...");
            }
            let repr = crate::profile_import::identifier(&serde_json::json!([display]));
            let mut repr = repr[1..repr.len() - 1].to_owned();
            for (marker, unit) in markers {
                let escaped = if u32::from(*marker) <= 0xffff {
                    format!("\\u{:04x}", u32::from(*marker))
                } else {
                    format!("\\U{:08x}", u32::from(*marker))
                };
                repr = repr.replace(&escaped, &format!("\\u{unit:04x}"));
            }
            return Err(mismatch(&format!(
                "Invalid JSON string: {error}. Input string: {repr}"
            )));
        }
        return Ok(raw.as_bytes().to_vec());
    }
    serialized(value, markers)
        .map_err(|error| field_error(field, "json", value, &error.to_string()))
}
pub fn dynamic(value: &Value, markers: &Surrogates) -> Result<Vec<u8>> {
    serialized(value, markers).map_err(|_| {
        mismatch("The Input data type is inconsistent with defined schema, please check it.")
    })
}

/// Search parameters use orjson directly, without the writer's JSON fallback.
pub(super) fn search_json(value: &Value) -> Result<String> {
    Ok(String::from_utf8(encode(
        value,
        &Surrogates::new(),
        false,
    )?)?)
}
