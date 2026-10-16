//! PyYAML SafeLoader scalar/merge compatibility using the YAML event parser.
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::collections::HashMap;
use yaml_rust2::{
    parser::{Event, Parser},
    scanner::TScalarStyle,
};

#[derive(Clone)]
struct Node {
    value: Value,
    merge: bool,
}

fn scalar(
    text: String,
    style: TScalarStyle,
    tag: Option<yaml_rust2::parser::Tag>,
    non_string: Option<&regex::Regex>,
) -> Result<Node> {
    let tag = tag.map(|t| format!("{}{}", t.handle, t.suffix));
    let kind = tag.as_deref().unwrap_or("");
    if !kind.is_empty() && !kind.starts_with("tag:yaml.org,2002:") {
        bail!("Unsupported YAML tag");
    }
    if non_string.is_some()
        && !kind.is_empty()
        && ![
            "str",
            "bool",
            "int",
            "float",
            "null",
            "timestamp",
            "binary",
            "merge",
            "value",
        ]
        .iter()
        .any(|name| kind == format!("tag:yaml.org,2002:{name}"))
    {
        bail!("Unsupported YAML scalar tag");
    }
    if kind == "tag:yaml.org,2002:str" || (style != TScalarStyle::Plain && kind.is_empty()) {
        return Ok(Node {
            value: json!(text),
            merge: false,
        });
    }
    let merge = (text == "<<" && kind.is_empty()) || kind == "tag:yaml.org,2002:merge";
    if let Some(pattern) = non_string
        && (kind.is_empty() && pattern.is_match(&text)
            || ["bool", "int", "float", "null", "timestamp", "binary"]
                .iter()
                .any(|name| kind == format!("tag:yaml.org,2002:{name}")))
    {
        return Ok(Node {
            value: Value::Null,
            merge: false,
        });
    }
    let value = match text.as_str() {
        "yes" | "Yes" | "YES" | "true" | "True" | "TRUE" | "on" | "On" | "ON" => json!(true),
        "no" | "No" | "NO" | "false" | "False" | "FALSE" | "off" | "Off" | "OFF" => json!(false),
        "" | "~" | "null" | "Null" | "NULL" => Value::Null,
        _ => {
            let clean = text.replace('_', "");
            let unsigned = clean.trim_start_matches(['-', '+']);
            let sign = if clean.starts_with('-') { -1_i64 } else { 1 };
            let integer = if let Some(v) = unsigned.strip_prefix("0x") {
                i64::from_str_radix(v, 16)
                    .ok()
                    .and_then(|n| n.checked_mul(sign))
            } else if let Some(v) = unsigned.strip_prefix("0b") {
                i64::from_str_radix(v, 2)
                    .ok()
                    .and_then(|n| n.checked_mul(sign))
            } else if unsigned.len() > 1 && unsigned.starts_with('0') {
                i64::from_str_radix(&unsigned[1..], 8)
                    .ok()
                    .and_then(|n| n.checked_mul(sign))
            } else if unsigned.contains(':')
                && unsigned
                    .split(':')
                    .all(|p| p.parse::<u32>().is_ok_and(|n| n < 60))
                && !unsigned.starts_with('0')
            {
                unsigned
                    .split(':')
                    .try_fold(0_i64, |a, b| {
                        a.checked_mul(60)?.checked_add(b.parse::<i64>().ok()?)
                    })
                    .and_then(|n| n.checked_mul(sign))
            } else {
                clean.parse::<i64>().ok()
            };
            if let Some(n) = integer {
                json!(n)
            } else if clean.contains('.') && !clean.contains(':') {
                match clean.parse::<f64>() {
                    Ok(f) if f.is_finite() => json!(f),
                    _ => json!(text),
                }
            } else {
                json!(text)
            }
        }
    };
    Ok(Node { value, merge })
}

pub fn parse(text: &str) -> Result<Value> {
    parse_with_strings(text, None)
}

/// Skill metadata only consumes string fields. Preserve YAML's distinction
/// between a string and non-JSON scalar types such as dates, bytes and NaN.
pub fn string_mapping(text: &str, non_string: &regex::Regex) -> Result<Value> {
    parse_with_strings(text, Some(non_string))
}

fn parse_with_strings(text: &str, non_string: Option<&regex::Regex>) -> Result<Value> {
    let mut parser = Parser::new_from_str(text);
    let mut events = Vec::new();
    loop {
        let (event, _) = parser
            .next_token()
            .map_err(|_| anyhow!("Invalid configuration YAML"))?;
        let done = event == Event::StreamEnd;
        events.push(event);
        if done {
            break;
        }
    }
    let mut events = events.into_iter().peekable();
    fn node(
        events: &mut std::iter::Peekable<std::vec::IntoIter<Event>>,
        anchors: &mut HashMap<usize, Node>,
        depth: usize,
        non_string: Option<&regex::Regex>,
    ) -> Result<Node> {
        if depth > 128 {
            bail!("Configuration nesting exceeds limit");
        }
        let mut anchor = 0;
        let result = match events.next().ok_or_else(|| anyhow!("Invalid YAML"))? {
            Event::Scalar(text, style, id, tag) => {
                anchor = id;
                scalar(text, style, tag, non_string)?
            }
            Event::Alias(id) => anchors
                .get(&id)
                .cloned()
                .ok_or_else(|| anyhow!("Invalid or recursive YAML alias"))?,
            Event::SequenceStart(id, tag) => {
                let kind = tag.map(|t| format!("{}{}", t.handle, t.suffix));
                if kind.as_ref().is_some_and(|kind| {
                    non_string.is_none()
                        || !["seq", "omap", "pairs"]
                            .iter()
                            .any(|name| kind == &format!("tag:yaml.org,2002:{name}"))
                }) {
                    bail!("Unsupported sequence tag");
                }
                anchor = id;
                let mut items = vec![];
                while events.peek() != Some(&Event::SequenceEnd) {
                    items.push(node(events, anchors, depth + 1, non_string)?.value);
                }
                events.next();
                if kind.is_some_and(|kind| kind.ends_with(":omap") || kind.ends_with(":pairs"))
                    && items
                        .iter()
                        .any(|item| item.as_object().is_none_or(|map| map.len() != 1))
                {
                    bail!("Invalid YAML pair");
                }
                Node {
                    value: json!(items),
                    merge: false,
                }
            }
            Event::MappingStart(id, tag) => {
                let kind = tag.map(|t| format!("{}{}", t.handle, t.suffix));
                if kind.as_ref().is_some_and(|kind| {
                    non_string.is_none()
                        || !["map", "set"]
                            .iter()
                            .any(|name| kind == &format!("tag:yaml.org,2002:{name}"))
                }) {
                    bail!("Unsupported mapping tag");
                }
                anchor = id;
                let mut values = Vec::new();
                let mut merged = serde_json::Map::new();
                while events.peek() != Some(&Event::MappingEnd) {
                    let key = node(events, anchors, depth + 1, non_string)?;
                    let value = node(events, anchors, depth + 1, non_string)?.value;
                    if key.merge {
                        let maps = if value.is_object() {
                            vec![value]
                        } else {
                            value
                                .as_array()
                                .ok_or_else(|| anyhow!("Invalid YAML merge"))?
                                .clone()
                        };
                        for map in maps.into_iter().rev() {
                            for (k, v) in map
                                .as_object()
                                .ok_or_else(|| anyhow!("Invalid YAML merge"))?
                            {
                                merged.insert(k.clone(), v.clone());
                            }
                        }
                    } else {
                        if non_string.is_some()
                            && !key.value.is_string()
                            && !key.value.is_array()
                            && !key.value.is_object()
                        {
                            continue;
                        }
                        let key = key
                            .value
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| anyhow!("Configuration keys must be strings"))?;
                        values.push((key, value));
                    }
                }
                events.next();
                for (k, v) in values {
                    merged.insert(k, v);
                }
                Node {
                    value: if kind.is_some_and(|kind| kind.ends_with(":set")) {
                        Value::Null
                    } else {
                        Value::Object(merged)
                    },
                    merge: false,
                }
            }
            _ => bail!("Invalid configuration YAML"),
        };
        if anchor > 0 {
            anchors.insert(anchor, result.clone());
        }
        Ok(result)
    }
    if events.next() != Some(Event::StreamStart) {
        bail!("Invalid YAML stream");
    }
    if events.peek() == Some(&Event::StreamEnd) {
        return Ok(Value::Null);
    }
    if events.next() != Some(Event::DocumentStart) {
        bail!("Invalid YAML document");
    }
    let value = node(&mut events, &mut HashMap::new(), 0, non_string)?.value;
    if events.next() != Some(Event::DocumentEnd) || events.next() != Some(Event::StreamEnd) {
        bail!("Expected one configuration document");
    }
    Ok(value)
}
