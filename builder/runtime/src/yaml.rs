//! PyYAML SafeLoader scalar/merge compatibility using the YAML event parser.
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::LazyLock};
use yaml_rust2::{
    parser::{Event, Parser},
    scanner::TScalarStyle,
};

// PyYAML's YAML 1.1 resolvers. Base-60 limits only the later components, and
// a decimal exponent needs its sign (`1.5e3` stays a string).
static SEXAGESIMAL_INT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$").unwrap());
static SEXAGESIMAL_FLOAT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$").unwrap());
static FLOAT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"^(?:[-+]?[0-9][0-9_]*\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?)$",
    )
    .unwrap()
});

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
            } else if SEXAGESIMAL_INT.is_match(&text) {
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
            } else if SEXAGESIMAL_FLOAT.is_match(&text) {
                // PyYAML sums the parts from the least significant upward.
                let mut value = 0.0;
                let mut base = 1.0;
                for part in unsigned.rsplit(':') {
                    value += part.parse::<f64>().unwrap_or(f64::NAN) * base;
                    base *= 60.0;
                }
                match value * sign as f64 {
                    f if f.is_finite() => json!(f),
                    _ => json!(text),
                }
            } else if FLOAT.is_match(&text) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_scalars_resolve_like_pyyaml_safe_loader() {
        // Expected values were produced by PyYAML 6 safe_load, not by Rust.
        for (text, expected) in [
            ("1.5e3", json!("1.5e3")),
            ("1e+3", json!("1e+3")),
            ("+.5", json!("+.5")),
            ("-.5", json!("-.5")),
            ("1.5e+3", json!(1500.0)),
            (".5", json!(0.5)),
            ("1.", json!(1.0)),
            ("1_0.5", json!(10.5)),
            ("12.5_0", json!(12.5)),
            ("1.5E-2", json!(0.015)),
            ("-0.0", json!(-0.0)),
        ] {
            assert_eq!(
                parse(&format!("a: {text}")).unwrap()["a"],
                expected,
                "{text}"
            );
        }
    }

    #[test]
    fn sexagesimal_scalars_resolve_like_pyyaml_safe_loader() {
        // Expected values were produced by PyYAML 6 safe_load, not by Rust.
        for (text, expected) in [
            ("190:20:30", json!(685230)),
            ("90:00", json!(5400)),
            ("-1:30", json!(-90)),
            ("+2:05", json!(125)),
            ("12:34:56", json!(45296)),
            ("1_0:30", json!(630)),
            ("10:30", json!(630)),
            ("1:2.5", json!(62.5)),
            ("61:0.5", json!(3660.5)),
            ("1:2:3.25", json!(3723.25)),
            ("-1:30.5", json!(-90.5)),
            ("1:005", json!("1:005")),
            ("8080:80", json!("8080:80")),
            ("0:30", json!("0:30")),
            ("1:60", json!("1:60")),
            ("1:0_5", json!("1:0_5")),
        ] {
            assert_eq!(
                parse(&format!("a: {text}")).unwrap()["a"],
                expected,
                "{text}"
            );
        }
    }
}
