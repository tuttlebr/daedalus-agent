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

fn scalar(text: String, style: TScalarStyle, tag: Option<yaml_rust2::parser::Tag>) -> Result<Node> {
    let tag = tag.map(|t| format!("{}{}", t.handle, t.suffix));
    let kind = tag.as_deref().unwrap_or("");
    if !kind.is_empty() && !kind.starts_with("tag:yaml.org,2002:") {
        bail!("Unsupported YAML tag");
    }
    if kind == "tag:yaml.org,2002:str" || (style != TScalarStyle::Plain && kind.is_empty()) {
        return Ok(Node {
            value: json!(text),
            merge: false,
        });
    }
    let merge = (text == "<<" && kind.is_empty()) || kind == "tag:yaml.org,2002:merge";
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
    ) -> Result<Node> {
        if depth > 128 {
            bail!("Configuration nesting exceeds limit");
        }
        let mut anchor = 0;
        let result = match events.next().ok_or_else(|| anyhow!("Invalid YAML"))? {
            Event::Scalar(text, style, id, tag) => {
                anchor = id;
                scalar(text, style, tag)?
            }
            Event::Alias(id) => anchors
                .get(&id)
                .cloned()
                .ok_or_else(|| anyhow!("Invalid or recursive YAML alias"))?,
            Event::SequenceStart(id, tag) => {
                if tag.is_some() {
                    bail!("Unsupported sequence tag");
                }
                anchor = id;
                let mut items = vec![];
                while events.peek() != Some(&Event::SequenceEnd) {
                    items.push(node(events, anchors, depth + 1)?.value);
                }
                events.next();
                Node {
                    value: json!(items),
                    merge: false,
                }
            }
            Event::MappingStart(id, tag) => {
                if tag.is_some() {
                    bail!("Unsupported mapping tag");
                }
                anchor = id;
                let mut values = Vec::new();
                let mut merged = serde_json::Map::new();
                while events.peek() != Some(&Event::MappingEnd) {
                    let key = node(events, anchors, depth + 1)?;
                    let value = node(events, anchors, depth + 1)?.value;
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
                    value: Value::Object(merged),
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
    let value = node(&mut events, &mut HashMap::new(), 0)?.value;
    if events.next() != Some(Event::DocumentEnd) || events.next() != Some(Event::StreamEnd) {
        bail!("Expected one configuration document");
    }
    Ok(value)
}
