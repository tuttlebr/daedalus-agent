//! Typed document results for native retrieval and adapter-specific formatting.
use crate::{
    config::truthy,
    milvus_search::{Field, Hit},
    profile_import::identifier,
};
use serde_json::{Value, json};

#[derive(Debug)]
pub struct Failure {
    pub class: &'static str,
    pub validation: Vec<Value>,
}
impl Failure {
    pub(super) fn new(class: &'static str) -> Self {
        Self {
            class,
            validation: Vec::new(),
        }
    }
    fn content(unicode: bool) -> Self {
        let (kind, message) = if unicode {
            (
                "string_unicode",
                "Input should be a valid string, unable to parse raw data as a unicode string",
            )
        } else {
            ("string_type", "Input should be a valid string")
        };
        Self {
            class: "ValidationError",
            validation: vec![json!({"type":kind,"loc":["page_content"],"msg":message})],
        }
    }
}
impl From<crate::milvus_search::Failure> for Failure {
    fn from(error: crate::milvus_search::Failure) -> Self {
        Self::new(error.0)
    }
}
impl From<crate::embeddings::Failure> for Failure {
    fn from(error: crate::embeddings::Failure) -> Self {
        Self {
            class: error.class,
            validation: error.validation,
        }
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Document retrieval failed ({})", self.class)
    }
}
impl std::error::Error for Failure {}

#[derive(Debug)]
pub struct Document {
    pub content: Option<String>,
    pub metadata: Vec<(String, Field)>,
}

/// The retriever consumes the first query, applies the distance cutoff, then
/// constructs each Document. A rejected hit must not raise content validation.
pub fn documents(
    results: Vec<Vec<Hit>>,
    content_field: &str,
    cutoff: Option<f64>,
) -> Result<Vec<Document>, Failure> {
    results
        .into_iter()
        .next()
        .ok_or_else(|| Failure::new("IndexError"))?
        .into_iter()
        .filter(|hit| cutoff.is_none_or(|cutoff| hit.distance <= cutoff))
        .map(|hit| {
            let value = hit
                .entity
                .iter()
                .find(|(key, _)| key == content_field)
                .map(|(_, value)| value)
                .ok_or_else(|| Failure::new("KeyError"))?;
            let content = match value {
                Field::Json(Value::Null) => None,
                Field::Json(Value::String(text)) => Some(text.clone()),
                Field::Bytes(bytes) => {
                    Some(String::from_utf8(bytes.clone()).map_err(|_| Failure::content(true))?)
                }
                _ => return Err(Failure::content(false)),
            };
            let mut metadata = hit
                .entity
                .into_iter()
                .filter(|(key, _)| key != content_field)
                .collect::<Vec<_>>();
            if let Some((_, distance)) = metadata.iter_mut().find(|(k, _)| k == "distance") {
                *distance = Field::Float(hit.distance);
            } else {
                metadata.push(("distance".into(), Field::Float(hit.distance)));
            }
            Ok(Document { content, metadata })
        })
        .collect()
}

fn json_repr(value: &Value) -> String {
    let array = identifier(&json!([value]));
    array[1..array.len() - 1].into()
}
fn bytes_repr(bytes: &[u8]) -> String {
    let quote = if bytes.contains(&b'\'') && !bytes.contains(&b'"') {
        b'"'
    } else {
        b'\''
    };
    let mut text = format!("b{}", char::from(quote));
    for &byte in bytes {
        match byte {
            b'\\' => text.push_str("\\\\"),
            b'\n' => text.push_str("\\n"),
            b'\r' => text.push_str("\\r"),
            b'\t' => text.push_str("\\t"),
            b if b == quote => {
                text.push('\\');
                text.push(char::from(b));
            }
            32..=126 => text.push(char::from(byte)),
            byte => text.push_str(&format!("\\x{byte:02x}")),
        }
    }
    text.push(char::from(quote));
    text
}
fn float_text(value: f64) -> String {
    if value.is_nan() {
        "nan".into()
    } else if value == f64::INFINITY {
        "inf".into()
    } else if value == f64::NEG_INFINITY {
        "-inf".into()
    } else {
        identifier(&json!(value))
    }
}

/// NumPy uses the shortest decimal that rounds back to binary16. Its pinned
/// scalar formatter switches to scientific notation at 1e-4 and 1e3.
fn half_text(value: f64) -> String {
    if !value.is_finite() || value == 0.0 {
        return float_text(value);
    }
    let absolute = value.abs();
    let round_half = |number: f64| {
        if number <= 0.0 {
            return number;
        }
        let scale = 2f64.powi((number.log2().floor() as i32 - 10).max(-24));
        (number / scale).round_ties_even() * scale
    };
    let decimal = (0..=4)
        .flat_map(|precision| {
            let nearest = format!("{absolute:.precision$e}");
            let exponent: i32 = nearest.split_once('e').unwrap().1.parse().unwrap();
            let step = 10f64.powi(exponent - precision as i32);
            let rounded: f64 = nearest.parse().unwrap();
            // At powers of two, the lower rounding interval is narrower.
            // The closest decimal can fail while its neighbor still fits.
            [
                nearest,
                format!("{:.*e}", precision, rounded + step),
                format!("{:.*e}", precision, rounded - step),
            ]
        })
        .find(|text| round_half(text.parse().unwrap()) == absolute)
        .expect("five significant digits distinguish binary16 values");
    let (mantissa, exponent) = decimal.split_once('e').unwrap();
    let exponent: i32 = exponent.parse().unwrap();
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_end_matches('0');
    let sign = if value.is_sign_negative() { "-" } else { "" };
    if !(1e-4..1e3).contains(&absolute) {
        let tail = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        format!("{sign}{}{tail}e{exponent:+03}", &digits[..1])
    } else {
        let point = exponent + 1;
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
fn field_text(value: &Field, repr: bool) -> String {
    match value {
        Field::Json(value) if repr => json_repr(value),
        Field::Json(value) => identifier(value),
        Field::Float(value) => float_text(*value),
        Field::Bytes(value) => bytes_repr(value),
        Field::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(|v| field_text(v, true))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Field::Object(values) => format!(
            "{{{}}}",
            values
                .iter()
                .map(|(key, v)| format!("{}: {}", json_repr(&json!(key)), field_text(v, true)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Field::Sparse(values) => format!(
            "{{{}}}",
            values
                .iter()
                .map(|(key, value)| format!("{key}: {}", float_text(*value)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Field::Numpy(dtype, value) => {
            let text = if let ("float16", Field::Float(value)) = (*dtype, value.as_ref()) {
                half_text(*value)
            } else {
                field_text(value, false)
            };
            if repr {
                format!("np.{dtype}({text})")
            } else {
                text
            }
        }
    }
}
fn field_truthy(value: &Field) -> bool {
    match value {
        Field::Json(value) => truthy(value),
        Field::Float(value) => *value != 0.0,
        Field::Bytes(value) => !value.is_empty(),
        Field::Array(value) => !value.is_empty(),
        Field::Object(value) => !value.is_empty(),
        Field::Sparse(value) => !value.is_empty(),
        Field::Numpy(_, value) => field_truthy(value),
    }
}

pub fn format(documents: &[Document], collection: &str) -> String {
    if documents.is_empty() {
        return format!("No matching uploaded-document passages found in {collection}.");
    }
    let mut parts = vec![
        format!("Collection: {collection}"),
        format!("Passages: {}", documents.len()),
    ];
    for (index, document) in documents.iter().enumerate() {
        let metadata = |name: &str| {
            document
                .metadata
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, v)| v)
        };
        let content = document
            .content
            .as_deref()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "page_content={} metadata={}",
                    json_repr(&json!(document.content)),
                    field_text(&Field::Object(document.metadata.clone()), true)
                )
            });
        let mut heading = vec![format!("{}.", index + 1)];
        if let Some(source) = ["filename", "source", "document_id", "title"]
            .into_iter()
            .filter_map(metadata)
            .find(|v| field_truthy(v))
        {
            heading.push(field_text(source, false));
        }
        if let Some(distance) =
            metadata("distance").filter(|v| !matches!(v, Field::Json(Value::Null)))
        {
            heading.push(format!("distance={}", field_text(distance, false)));
        }
        parts.push(format!("\n{}\n{content}", heading.join(" ")));
    }
    parts.join("\n")
}

/// Domain retrieval returns bounded JSON, while uploaded-document retrieval
/// retains its Markdown envelope. Keep Python's numeric JSON spelling here,
/// including nonfinite metadata values accepted by its standard JSON encoder.
pub fn format_domain(documents: &[Document], domain: &str) -> Result<String, Failure> {
    fn json_number(value: &Field) -> Result<String, Failure> {
        let value = match value {
            Field::Float(value) => *value,
            Field::Numpy(_, value) => return json_number(value),
            Field::Json(Value::Bool(value)) => f64::from(u8::from(*value)),
            Field::Json(Value::Number(value)) => value
                .as_f64()
                .ok_or_else(|| Failure::new("OverflowError"))?,
            Field::Json(Value::String(value)) => {
                let number =
                    crate::document_tools::number(&json!(crate::document_store::decimal(value)))
                        .map_err(|_| Failure::new("ValueError"))?;
                number
                    .as_f64()
                    .or_else(|| number.as_str()?.parse().ok())
                    .ok_or_else(|| Failure::new("ValueError"))?
            }
            Field::Bytes(value) => {
                return json_number(&Field::Json(json!(
                    std::str::from_utf8(value).map_err(|_| Failure::new("ValueError"))?
                )));
            }
            _ => return Err(Failure::new("TypeError")),
        };
        Ok(if value.is_nan() {
            "NaN".into()
        } else if value == f64::INFINITY {
            "Infinity".into()
        } else if value == f64::NEG_INFINITY {
            "-Infinity".into()
        } else {
            float_text(value)
        })
    }
    let mut formatted = Vec::new();
    let mut reranked = false;
    for document in documents.iter().take(20) {
        let metadata = |name: &str| {
            document
                .metadata
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value)
        };
        let content = document
            .content
            .as_deref()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "page_content={} metadata={}",
                    json_repr(&json!(document.content)),
                    field_text(&Field::Object(document.metadata.clone()), true)
                )
            });
        let mut fields = vec![format!(
            "\"content\":{}",
            crate::output::compact(&json!(content.chars().take(12000).collect::<String>()))
        )];
        if let Some(source) = ["source", "url", "title"]
            .into_iter()
            .filter_map(metadata)
            .find(|value| field_truthy(value))
        {
            fields.push(format!(
                "\"source\":{}",
                crate::output::compact(&json!(
                    field_text(source, false)
                        .chars()
                        .take(2048)
                        .collect::<String>()
                ))
            ));
        }
        for name in ["distance", "rerank_score"] {
            if let Some(value) =
                metadata(name).filter(|value| !matches!(value, Field::Json(Value::Null)))
            {
                fields.push(format!("\"{name}\":{}", json_number(value)?));
                reranked |= name == "rerank_score";
            }
        }
        formatted.push(format!("{{{}}}", fields.join(",")));
    }
    let status = if formatted.is_empty() {
        "no_results"
    } else if reranked {
        "reranked"
    } else {
        "vector_only"
    };
    Ok(format!(
        "{{\"domain\":{},\"ranking_status\":\"{status}\",\"retrieved_count\":{},\"results_truncated\":{},\"results\":[{}]}}",
        crate::output::compact(&json!(domain)),
        documents.len(),
        documents.len() > formatted.len(),
        formatted.join(",")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use prost::Message;
    fn observation(result: Result<Vec<Document>, Failure>) -> Value {
        match result {
            Ok(documents) => json!({"ok":format(&documents, "synthetic")}),
            Err(error) if error.class == "ValidationError" => {
                json!({"error":error.class,"validation":error.validation})
            }
            Err(error) => json!({"error":error.class}),
        }
    }
    #[test]
    fn retained_document_results() {
        let mut fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/document-search-results.json"
        ))
        .unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        for case in fixture["bytes"].as_array().unwrap() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(case["value"].as_str().unwrap())
                .unwrap();
            assert_eq!(bytes_repr(&bytes), case["str"].as_str().unwrap());
        }
        for case in fixture["float16"]["samples"].as_array().unwrap() {
            let value = crate::milvus_search::half(case["bits"].as_u64().unwrap() as u16);
            assert_eq!(
                half_text(value),
                case["str"].as_str().unwrap(),
                "half {}",
                case["bits"]
            );
            assert_eq!(
                field_text(
                    &Field::Numpy("float16", Box::new(Field::Float(value))),
                    true
                ),
                case["repr"].as_str().unwrap()
            );
        }
        use sha2::{Digest, Sha256};
        let mut strings = Sha256::new();
        let mut reprs = Sha256::new();
        for bits in 0..=u16::MAX {
            let value = crate::milvus_search::half(bits);
            strings.update(format!("{}\n", half_text(value)));
            reprs.update(format!(
                "{}\n",
                field_text(
                    &Field::Numpy("float16", Box::new(Field::Float(value))),
                    true
                )
            ));
        }
        assert_eq!(
            format!("{:x}", strings.finalize()),
            fixture["float16"]["str_sha256"].as_str().unwrap()
        );
        assert_eq!(
            format!("{:x}", reprs.finalize()),
            fixture["float16"]["repr_sha256"].as_str().unwrap()
        );
        for case in fixture["cases"].as_array().unwrap() {
            let wire = base64::engine::general_purpose::STANDARD
                .decode(case["response"].as_str().unwrap())
                .unwrap();
            let response =
                crate::milvus_index_proto::SearchResults::decode(wire.as_slice()).unwrap();
            let actual = crate::milvus_search::decode(response)
                .map_err(Failure::from)
                .and_then(|results| {
                    documents(
                        results,
                        case["content_field"].as_str().unwrap(),
                        case["distance_cutoff"].as_f64(),
                    )
                });
            assert_eq!(observation(actual), case["expected"], "{}", case["name"]);
        }
    }

    #[tokio::test]
    #[ignore = "requires the real gRPC peer in milvus_search_check.py"]
    async fn actual_document_results() {
        let control = std::env::var("DAEDALUS_SEARCH_PEER_CONTROL").unwrap();
        let uri = std::env::var("DAEDALUS_SEARCH_PEER_URI").unwrap();
        let all = std::env::var("DAEDALUS_SEARCH_PEER_CASES").unwrap() == "all";
        let gzip = std::env::var("DAEDALUS_SEARCH_PEER_GZIP").unwrap() == "true";
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/document-search-results.json"
        ))
        .unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        let wire = base64::engine::general_purpose::STANDARD
            .decode(fixture["search_call"]["base64"].as_str().unwrap())
            .unwrap();
        let request = crate::milvus_index_proto::SearchRequest::decode(wire.as_slice()).unwrap();
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            if !all && index > 0 {
                break;
            }
            let mut call = fixture["search_call"].clone();
            call["response_base64"] = case["response"].clone();
            http.post(format!("{control}/reset"))
                .json(&json!({"uri":uri,"gzip":gzip,"script":[call]}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let config = crate::milvus_index_transport::tests::configured(&uri);
            let mut client = crate::milvus::Client::for_tool(&config, &json!({"uri":uri}))
                .await
                .unwrap();
            let actual = crate::milvus_search::search(&mut client, request.clone())
                .await
                .map_err(Failure::from)
                .and_then(|results| {
                    documents(
                        results,
                        case["content_field"].as_str().unwrap(),
                        case["distance_cutoff"].as_f64(),
                    )
                });
            assert_eq!(observation(actual), case["expected"], "{}", case["name"]);
            let script: Value = http
                .get(format!("{control}/script"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                script,
                json!({"remaining":0,"errors":[]}),
                "{}",
                case["name"]
            );
            let calls: Vec<Value> = http
                .get(format!("{control}/calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                calls.iter().filter(|c| c["method"] == "Connect").count(),
                1,
                "{}",
                case["name"]
            );
            assert_eq!(
                calls.iter().filter(|c| c["method"] == "Search").count(),
                case["search_rpcs"].as_u64().unwrap() as usize,
                "{}",
                case["name"]
            );
            assert!(
                calls
                    .iter()
                    .all(|c| c["deadline"] == false && c["cancelled"] == false),
                "{}",
                case["name"]
            );
            println!("Native document results: {}", case["name"]);
        }
    }
}
