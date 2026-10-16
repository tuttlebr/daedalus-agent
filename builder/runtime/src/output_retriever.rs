//! Exact recovery of cached output. Wire schema and Unicode matching are frozen
//! from the retained Python image; character offsets are Unicode scalar indices.

use std::{collections::HashMap, sync::LazyLock};

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::output::{OutputReader, chars, compact};

static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/output-retriever.json")).unwrap()
});
static IGNORECASE: LazyLock<HashMap<char, char>> = LazyLock::new(|| {
    CONTRACT["ignorecase"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(code, canonical)| {
            (
                char::from_u32(code.parse().unwrap()).unwrap(),
                char::from_u32(canonical.as_u64().unwrap() as u32).unwrap(),
            )
        })
        .collect()
});

pub struct Settings {
    pub max_chunk_chars: usize,
    pub max_matches: usize,
    pub context_chars: usize,
}

impl Settings {
    pub fn new(raw: &Value) -> Result<Self> {
        let invalid = || anyhow!("Invalid tool output retriever configuration");
        if raw.as_object().is_none_or(|fields| {
            fields.keys().any(|key| {
                ![
                    "_type",
                    "description",
                    "verbose",
                    "max_chunk_chars",
                    "max_matches",
                    "context_chars",
                ]
                .contains(&key.as_str())
            })
        }) || raw.get("description").is_some_and(|v| !v.is_string())
            || raw.get("verbose").is_some_and(|v| match v {
                Value::Bool(_) => false,
                Value::Number(_) => !matches!(v.as_f64(), Some(0.0 | 1.0)),
                Value::String(s) => ![
                    "0", "1", "f", "t", "false", "true", "n", "y", "no", "yes", "off", "on",
                ]
                .contains(&s.to_ascii_lowercase().as_str()),
                _ => true,
            })
        {
            return Err(invalid());
        }
        let bound = |key, default, minimum, maximum| -> Result<usize> {
            let number = raw
                .get(key)
                .map(|v| {
                    if let Some(text) = v.as_str() {
                        static INTEGER: LazyLock<regex::Regex> = LazyLock::new(|| {
                            regex::Regex::new(r"^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$").unwrap()
                        });
                        if !INTEGER.is_match(text.trim()) {
                            return Err(invalid());
                        }
                        crate::config::number(&json!(text.trim().replace('_', "")))
                    } else {
                        crate::config::number(v)
                    }
                })
                .transpose()
                .map_err(|_| invalid())?
                .unwrap_or(default as f64);
            if number.fract() != 0. || !(minimum as f64..=maximum as f64).contains(&number) {
                return Err(invalid());
            }
            Ok(number as usize)
        };
        Ok(Self {
            max_chunk_chars: bound("max_chunk_chars", 12_000, 1_000, 50_000)?,
            max_matches: bound("max_matches", 10, 1, 50)?,
            context_chars: bound("context_chars", 300, 50, 2_000)?,
        })
    }
}

pub fn schema(name: &str, raw: &Value) -> Value {
    json!({"name":name, "description":raw.get("description").unwrap_or(&CONTRACT["description"]), "parameters":CONTRACT["schema"]})
}

pub fn input_error(args: &Value) -> Option<&'static str> {
    // Pydantic accepts arbitrary integers but bounds conversion from integral
    // floats to i64. JSON Schema considers those floats integers as well.
    let value = args.get("offset")?;
    let token = value.to_string();
    (token.contains(['.', 'e', 'E']) && value.as_f64().is_none_or(|n| n >= i64::MAX as f64))
        .then_some("[{\"type\": \"int_parsing_size\", \"loc\": [\"offset\"], \"msg\": \"Unable to parse input string as an integer, exceeded maximum size\"}]")
}

/// JSON Schema permits integral floats and arbitrary-size integer offsets. A
/// saturated offset still pages at EOF, just as Python's min(offset, len(text)).
fn offset(value: &Value) -> usize {
    value
        .as_u64()
        .map(|n| n as usize)
        .unwrap_or_else(|| value.as_f64().unwrap_or(f64::MAX) as usize)
}

pub fn page(content: &str, reference: &str, start: usize, max_chars: usize) -> String {
    let total = chars(content);
    let start = start.min(total);
    let end = start.saturating_add(max_chars).min(total);
    compact(
        &json!({"reference":reference,"mode":"exact_page","offset":start,
        "end_offset":end,"total_chars":total,"complete":end>=total,
        "next_offset":if end>=total {None} else {Some(end)},
        "content":content.chars().skip(start).take(end-start).collect::<String>()}),
    )
}

pub fn search(content: &str, reference: &str, query: &str, settings: &Settings) -> String {
    let fold = |ch: char| IGNORECASE.get(&ch).copied().unwrap_or(ch);
    let pattern: Vec<_> = query.chars().map(fold).collect();
    // KMP keeps a long repeated query/content linear while retaining Python's
    // non-overlapping matches. No regex syntax or multi-character expansion.
    let mut prefix = vec![0; pattern.len()];
    let mut matched = 0;
    for i in 1..pattern.len() {
        while matched > 0 && pattern[i] != pattern[matched] {
            matched = prefix[matched - 1];
        }
        if pattern[i] == pattern[matched] {
            matched += 1;
        }
        prefix[i] = matched;
    }
    let text: Vec<_> = content.chars().collect();
    let mut matches = Vec::new();
    let mut more = false;
    matched = 0;
    for (i, ch) in text.iter().enumerate() {
        let ch = fold(*ch);
        while matched > 0 && ch != pattern[matched] {
            matched = prefix[matched - 1];
        }
        if ch == pattern[matched] {
            matched += 1;
        }
        if matched == pattern.len() {
            if matches.len() == settings.max_matches {
                more = true;
                break;
            }
            let match_start = i + 1 - matched;
            let start = match_start.saturating_sub(settings.context_chars);
            let end = (i + 1)
                .saturating_add(settings.context_chars)
                .min(text.len());
            matches.push(json!({"match_offset":match_start,"start_offset":start,
                "end_offset":end,"content":text[start..end].iter().collect::<String>()}));
            matched = 0;
        }
    }
    compact(
        &json!({"reference":reference,"mode":"literal_search","query":query,
        "total_chars":text.len(),"matches":matches,"matches_returned":matches.len(),
        "more_matches":more}),
    )
}

pub async fn retrieve(
    store: &OutputReader,
    raw: &Value,
    user: &str,
    args: &Value,
) -> Result<String> {
    let reference = args["reference"]
        .as_str()
        .ok_or_else(|| anyhow!("Invalid retrieval arguments"))?;
    if !crate::output::valid_reference(reference) {
        return Ok(compact(&json!({"error":"invalid_tool_output_reference"})));
    }
    if user.is_empty() {
        return Ok(compact(&json!({"error":"tool_output_retrieval_denied"})));
    }
    let Some(content) = store.get(user, reference).await else {
        return Ok(compact(
            &json!({"error":"tool_output_not_found","reference":reference,
            "message":"The reference expired or belongs to a different user. Repeat the source tool call if the data is still needed."}),
        ));
    };
    let settings = Settings::new(raw)?;
    if let Some(query) = args["query"].as_str() {
        if query.is_empty() {
            bail!("Invalid retrieval arguments");
        }
        Ok(search(&content, reference, query, &settings))
    } else {
        let start = args.get("offset").map(offset).unwrap_or(0);
        let size = args
            .get("max_chars")
            .filter(|v| !v.is_null())
            .map(offset)
            .unwrap_or(settings.max_chunk_chars)
            .min(settings.max_chunk_chars);
        Ok(page(&content, reference, start, size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expand(value: Value) -> Value {
        match value {
            Value::Object(map) if map.len() == 1 && map.contains_key("$string_parts") => {
                json!(
                    map["$string_parts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap())
                        .collect::<String>()
                )
            }
            Value::Object(map) => {
                Value::Object(map.into_iter().map(|(k, v)| (k, expand(v))).collect())
            }
            Value::Array(items) => Value::Array(items.into_iter().map(expand).collect()),
            other => other,
        }
    }

    #[test]
    fn frozen_python_search_and_paging() {
        let fixture = expand(
            serde_json::from_str(include_str!("../tests/fixtures/output-retriever.json")).unwrap(),
        );
        for case in fixture["configurations"].as_array().unwrap() {
            match Settings::new(&case["input"]) {
                Ok(settings) => {
                    assert!(!case["expected"].is_null(), "{case}");
                    assert_eq!(
                        json!(settings.max_chunk_chars),
                        case["expected"]["max_chunk_chars"]
                    );
                    assert_eq!(json!(settings.max_matches), case["expected"]["max_matches"]);
                    assert_eq!(
                        json!(settings.context_chars),
                        case["expected"]["context_chars"]
                    );
                }
                Err(_) => assert!(case["expected"].is_null(), "{case}"),
            }
        }
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let input = &case["input"];
            let content = input["content"].as_str().unwrap();
            let reference = &crate::output::reference(content);
            let actual = if case["operation"] == "page" {
                page(
                    content,
                    reference,
                    offset(&input["offset"]),
                    offset(&input["max_chars"]),
                )
            } else {
                search(
                    content,
                    reference,
                    input["query"].as_str().unwrap(),
                    &Settings {
                        max_chunk_chars: 1000,
                        max_matches: offset(&input["max_matches"]),
                        context_chars: offset(&input["context_chars"]),
                    },
                )
            };
            assert_eq!(actual, case["expected"].as_str().unwrap(), "case {index}");
        }
    }

    #[test]
    fn settings_schema_and_integral_float_offsets() {
        assert_eq!(offset(&json!(1.0)), 1);
        assert!(input_error(&json!({"offset":1e100})).is_some());
        assert!(input_error(&json!({"offset":1.0})).is_none());
        assert_eq!(Settings::new(&json!({})).unwrap().max_chunk_chars, 12000);
        assert_eq!(
            Settings::new(&json!({"max_matches":"2.0"}))
                .unwrap()
                .max_matches,
            2
        );
        for raw in [
            json!({"max_matches":0}),
            json!({"max_matches":1.5}),
            json!({"context_chars":2001}),
            json!({"max_chunk_chars":999}),
            json!({"unknown":true}),
            json!({"description":null}),
        ] {
            assert!(Settings::new(&raw).is_err());
        }
        let catalog: Value =
            serde_json::from_str(include_str!("../tests/fixtures/native-catalog.json")).unwrap();
        assert_eq!(
            schema("renamed", &json!({}))["parameters"],
            catalog["tool_output_retriever_tool"]["schema"]
        );
        assert_eq!(
            schema("renamed", &json!({"description":"Custom"}))["description"],
            "Custom"
        );
    }
}
