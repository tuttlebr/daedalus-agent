//! Perplexity Search's provider request and shared frontend SearchResults contract.
use crate::{
    authorization::fold,
    config::truthy,
    document_search::Failure,
    memory_tools::{json_text, trim},
    profile_import::identifier,
};
use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::LazyLock};

static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/perplexity-search.json")).unwrap()
});
const KEY_VARIABLE: &str = "PERPLEXITY_SEARCH_API_KEY";
const NO_KEY: &str = "Error: No Perplexity Search API key configured. Set the PERPLEXITY_SEARCH_API_KEY environment variable.";

pub struct Settings {
    pub values: Value,
    key: String,
}
impl Settings {
    pub async fn call(&self, raw: &Value) -> Result<String> {
        let payload = match self.request(raw)? {
            Ok(payload) => payload,
            Err(message) => return Ok(message),
        };
        let (status, body) = match self.post(&payload).await {
            Ok(response) => response,
            Err(error) if error.downcast_ref::<Failure>().is_some() => return Err(error),
            Err(_) => return Ok("Error: Could not reach Perplexity Search.".into()),
        };
        let data = response_json(&body);
        if !(200..300).contains(&status) {
            return Ok(http_error(status, &data.unwrap_or(Value::Null)));
        }
        match data {
            Some(data) => render(
                &data,
                &payload["query"],
                payload["max_results"].as_u64().unwrap() as usize,
            ),
            None => Ok("Error: Perplexity Search returned invalid JSON.".into()),
        }
    }

    async fn post(&self, payload: &Value) -> Result<(u16, Vec<u8>)> {
        use std::time::Duration;
        let timeout = self.values["timeout"]
            .as_f64()
            .or_else(|| self.values["timeout"].as_str()?.parse().ok())
            .unwrap();
        if timeout <= 0.0 {
            bail!("Search timeout expired");
        }
        let mut builder = reqwest::Client::builder()
            .http1_only()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .cookie_store(true)
            .pool_idle_timeout(Duration::from_secs(5));
        if let Ok(timeout) = Duration::try_from_secs_f64(timeout) {
            builder = builder.connect_timeout(timeout).read_timeout(timeout);
        }
        if let Ok(path) = std::env::var("SSL_CERT_FILE") {
            let pem = std::fs::read(path).map_err(|_| Failure::new("FileNotFoundError"))?;
            let certificates = reqwest::Certificate::from_pem_bundle(&pem)
                .map_err(|_| Failure::new("SSLError"))?;
            builder = builder.tls_certs_only(certificates);
        }
        let client = builder.build()?;
        if !self.key.is_ascii() {
            return Err(Failure::new("UnicodeEncodeError").into());
        }
        if self.key.ends_with([' ', '\t']) || self.key.contains(['\r', '\n', '\0']) {
            bail!("Invalid provider credential header");
        }
        let endpoint = self.values["base_url"].as_str().unwrap();
        let maximum = self.values["rate_limit_max_retries"].as_u64().unwrap();
        let base_delay = self.values["rate_limit_backoff_seconds"].as_f64().unwrap();
        let body = json_text(payload, false, false, false);
        for attempt in 0..=maximum {
            let response = client
                .post(endpoint)
                .header("authorization", format!("Bearer {}", self.key))
                .header("content-type", "application/json")
                .header("accept", "*/*")
                .header("accept-encoding", "gzip, deflate, zstd")
                .body(body.clone())
                .send()
                .await?;
            let status = response.status().as_u16();
            let encoding = response
                .headers()
                .get("content-encoding")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let bytes = response.bytes().await?;
            let decoded = crate::embeddings::decompress(&encoding, bytes.to_vec())
                .map_err(|_| anyhow!("Provider decoding error"))?;
            if status != 429 || attempt == maximum {
                return Ok((status, decoded));
            }
            // Rejection sampling retains secrets.randbelow(1001)'s uniform
            // discrete jitter, using the OS random bytes already used by UUID.
            let jitter = if base_delay == 0.0 {
                0.0
            } else {
                loop {
                    let random = uuid::Uuid::new_v4();
                    let sample =
                        u16::from_le_bytes([random.as_bytes()[0], random.as_bytes()[1]]) & 1023;
                    if sample <= 1000 {
                        break base_delay * f64::from(sample) / 1000.0;
                    }
                }
            };
            tokio::time::sleep(Duration::from_secs_f64(
                base_delay * (1_u32 << attempt) as f64 + jitter,
            ))
            .await;
        }
        unreachable!("bounded search retries")
    }

    pub fn new(raw: &Value, env: &HashMap<String, String>) -> Result<Self> {
        let properties = CONTRACT["configuration_schema"]["properties"]
            .as_object()
            .unwrap();
        let mut values = CONTRACT["defaults"].clone();
        values["api_key"] = json!(
            env.get(KEY_VARIABLE)
                .map(String::as_str)
                .unwrap_or_default()
        );
        for (name, value) in raw
            .as_object()
            .ok_or_else(|| anyhow!("Invalid search configuration"))?
        {
            if name == "_type" && value == "perplexity_search" {
                continue;
            }
            let schema = properties
                .get(name)
                .ok_or_else(|| anyhow!("Unknown search configuration field"))?;
            let value = crate::document_tools::coerce(value, schema)?;
            if schema["enum"]
                .as_array()
                .is_some_and(|options| !options.contains(&value))
            {
                bail!("Invalid search configuration literal");
            }
            if schema.get("minimum").is_some() || schema.get("maximum").is_some() {
                let n = value
                    .as_f64()
                    .ok_or_else(|| anyhow!("Invalid search configuration number"))?;
                if schema["minimum"].as_f64().is_some_and(|min| n < min)
                    || schema["maximum"].as_f64().is_some_and(|max| n > max)
                    || !n.is_finite()
                {
                    bail!("Search configuration number out of bounds");
                }
            }
            values[name] = value;
        }
        let key = values["api_key"].as_str().unwrap();
        let key = if key.is_empty() {
            env.get(KEY_VARIABLE).cloned().unwrap_or_default()
        } else {
            key.into()
        };
        Ok(Self { values, key })
    }

    pub fn schema(&self, name: &str) -> Result<Value> {
        let mut schema = CONTRACT["schema"].clone();
        schema["name"] = json!(name);
        if let Some(description) = self.values["description"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            if trim(description).is_empty() {
                bail!("Tool requires a nonempty model-facing description");
            }
            schema["description"] = json!(description);
        }
        Ok(schema)
    }

    /// Public validation precedes credential checks, and credentials precede
    /// semantic query/country/date checks, matching the retained factory.
    fn request(&self, raw: &Value) -> Result<std::result::Result<Value, String>> {
        let mut input = arguments(raw)?;
        if self.key.is_empty() {
            return Ok(Err(NO_KEY.into()));
        }
        input["query"] = match normalize_query(&input["query"]) {
            Ok(value) => value,
            Err(message) => return Ok(Err(format!("Error: {message}"))),
        };
        let country = trim(input["country"].as_str().unwrap());
        if !country.is_empty() && country.chars().count() != 2 {
            return Ok(Err(
                "Error: country must be a two-letter ISO 3166-1 alpha-2 code.".into(),
            ));
        }
        input["default_max_results"] = self.values["default_max_results"].clone();
        if input["search_context_size"] == "" {
            input["search_context_size"] = self.values["default_search_context_size"].clone();
        }
        Ok(request_payload(&input).map_err(|message| format!("Error: {message}")))
    }
}

/// json.loads(bytes), used by HTTPX, detects Unicode BOMs and UTF-16/32
/// null-byte patterns independently of the HTTP Content-Type charset.
fn response_json(raw: &[u8]) -> Option<Value> {
    let encoding = if raw.starts_with(b"\xff\xfe\0\0") || raw.starts_with(b"\0\0\xfe\xff") {
        "utf_32"
    } else if raw.starts_with(b"\xff\xfe") || raw.starts_with(b"\xfe\xff") {
        "utf_16"
    } else if raw.starts_with(b"\xef\xbb\xbf") {
        return serde_json::from_slice(&raw[3..]).ok();
    } else if raw.len() >= 4 && raw[0] == 0 {
        if raw[1] == 0 {
            "utf_32_be"
        } else {
            "utf_16_be"
        }
    } else if raw.len() >= 4 && raw[1] == 0 {
        if raw[2] == 0 && raw[3] == 0 {
            "utf_32_le"
        } else {
            "utf_16_le"
        }
    } else if raw.len() == 2 && raw[0] == 0 {
        "utf_16_be"
    } else if raw.len() == 2 && raw[1] == 0 {
        "utf_16_le"
    } else {
        return serde_json::from_slice(raw).ok();
    };
    let text = crate::document_codecs::decode(encoding, raw, false).ok()?;
    serde_json::from_str(&text).ok()
}

fn arguments(raw: &Value) -> Result<Value> {
    static INPUT: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
        jsonschema::options()
            .should_validate_formats(false)
            .build(&CONTRACT["schema"]["parameters"])
            .unwrap()
    });
    let mut errors: Vec<_> = INPUT.iter_errors(raw).collect();
    errors.sort_by_key(|error| {
        let mut schema = &CONTRACT["schema"]["parameters"];
        error
            .schema_path()
            .to_string()
            .split('/')
            .skip(1)
            .map(|part| {
                let rank = schema
                    .as_object()
                    .and_then(|map| map.keys().position(|key| key == part))
                    .unwrap_or(0);
                schema = &schema[part];
                rank
            })
            .collect::<Vec<_>>()
    });
    let validation: Vec<_> = errors
        .into_iter()
        .take(8)
        .map(|error| {
            let location: Vec<_> = error
                .instance_path()
                .to_string()
                .split('/')
                .skip(1)
                .map(|part| json!(part.replace("~1", "/").replace("~0", "~")))
                .collect();
            json!({"type":"value_error", "loc":location,
            "msg":format!("Value error, Argument contract: {}", error.kind().keyword())})
        })
        .collect();
    if !validation.is_empty() {
        return Err(Failure {
            class: "ValidationError",
            validation,
        }
        .into());
    }
    let mut output = raw.clone();
    for (key, field) in CONTRACT["schema"]["parameters"]["properties"]
        .as_object()
        .unwrap()
    {
        if let Some(value) = raw.get(key) {
            if key == "max_results" {
                output[key] = crate::document_tools::coerce(value, field).map_err(|_| Failure {
                    class: "ValidationError",
                    validation: vec![json!({"type":"int_parsing_size", "loc":[key],
                        "msg":"Unable to parse input string as an integer, exceeded maximum size"})],
                })?;
            }
        } else if let Some(default) = field.get("default") {
            output[key] = default.clone();
        }
    }
    Ok(output)
}

fn normalize_query(raw: &Value) -> std::result::Result<Value, &'static str> {
    if let Some(text) = raw.as_str() {
        return if trim(text).is_empty() {
            Err("query is required.")
        } else {
            Ok(json!(trim(text)))
        };
    }
    let list = raw
        .as_array()
        .ok_or("query must be a string or a list of query strings.")?;
    if !(2..=5).contains(&list.len()) {
        return Err(
            "query lists must contain 2 to 5 distinct subqueries; use a string for a single search.",
        );
    }
    let mut seen = std::collections::HashSet::new();
    let mut output = Vec::new();
    for item in list {
        let text = item
            .as_str()
            .map(trim)
            .filter(|s| !s.is_empty())
            .ok_or("each query list item must be a non-empty string.")?;
        if !seen.insert(fold(text)) {
            return Err("query list items must be distinct subqueries.");
        }
        output.push(json!(text));
    }
    Ok(Value::Array(output))
}

fn lower(text: &str) -> String {
    crate::document_detection::lowercase(&text.chars().map(u32::from).collect::<Vec<_>>())
        .into_iter()
        .filter_map(char::from_u32)
        .collect()
}

fn date(value: &str, field: &str) -> std::result::Result<String, String> {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        CONTRACT["date_patterns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| Regex::new(&format!("^(?:{})$", v.as_str().unwrap())).unwrap())
            .collect()
    });
    let text = trim(value);
    if text.is_empty() {
        return Ok(String::new());
    }
    for (index, pattern) in PATTERNS.iter().enumerate() {
        if let Some(parts) = pattern.captures(text) {
            let number = |key: &str| {
                crate::document_store::decimal(&parts[key])
                    .parse::<u32>()
                    .ok()
            };
            if let (Some(year), Some(month), Some(day)) = (number("Y"), number("m"), number("d"))
                && (1..=9999).contains(&year)
                && chrono::NaiveDate::from_ymd_opt(year as i32, month, day).is_some()
            {
                return Ok(if index == 0 {
                    text.into()
                } else {
                    format!("{month:02}/{day:02}/{year}")
                });
            }
        }
    }
    Err(format!(
        "{field} must be a valid date in MM/DD/YYYY or YYYY-MM-DD format."
    ))
}

fn request_payload(input: &Value) -> std::result::Result<Value, String> {
    let text = |name: &str| input[name].as_str().unwrap_or_default();
    let maximum = input
        .get("max_results")
        .filter(|v| truthy(v))
        .or_else(|| input.get("default_max_results"))
        .cloned()
        .unwrap_or(json!(5));
    let maximum = maximum.as_i64().map(|n| n.clamp(1, 20)).unwrap_or_else(|| {
        if maximum.to_string().starts_with('-') {
            1
        } else {
            20
        }
    });
    let mut output = json!({"query":input["query"], "max_results":maximum});
    let country = trim(text("country"));
    if !country.is_empty() {
        output["country"] = json!(
            country
                .chars()
                .map(|c| {
                    CONTRACT["uppercase"][c.to_string()]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| c.to_string())
                })
                .collect::<String>()
        );
    }
    let context = lower(trim(
        input["search_context_size"].as_str().unwrap_or("medium"),
    ));
    if ["low", "medium", "high"].contains(&context.as_str()) {
        output["search_context_size"] = json!(context);
    }
    for key in ["search_domain_filter", "search_language_filter"] {
        let values: Vec<_> = text(key)
            .split(',')
            .map(trim)
            .filter(|v| !v.is_empty())
            .take(20)
            .map(|v| {
                if key == "search_language_filter" {
                    lower(v)
                } else {
                    v.into()
                }
            })
            .collect();
        if !values.is_empty() {
            output[key] = json!(values);
        }
    }
    let mut exact = false;
    for key in [
        "search_after_date_filter",
        "search_before_date_filter",
        "last_updated_after_filter",
        "last_updated_before_filter",
    ] {
        let value = date(text(key), key)?;
        if !value.is_empty() {
            exact = true;
            output[key] = json!(value);
        }
    }
    let recency = lower(trim(text("search_recency_filter")));
    if !exact && ["hour", "day", "week", "month", "year"].contains(&recency.as_str()) {
        output["search_recency_filter"] = json!(recency);
    }
    Ok(output)
}

// urlparse preserves case, credentials and explicit ports; URL normalization
// would change the SearchResults displayed_link field.
fn displayed_link(url: &str) -> Result<String> {
    let cleaned = url
        .trim_start_matches(|c: char| c <= ' ')
        .replace(['\r', '\n', '\t'], "");
    let mut rest = cleaned.as_str();
    if let Some((scheme, tail)) = rest.split_once(':')
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ['+', '-', '.'].contains(&c))
    {
        rest = tail;
    }
    let Some(rest) = rest.strip_prefix("//") else {
        return Ok(url.into());
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.contains('[') != host.contains(']') {
        return Err(Failure::new("ValueError").into());
    }
    if let Some((_, tail)) = host.split_once('[') {
        let address = tail.split(']').next().unwrap();
        let valid = if let Some(versioned) = address.strip_prefix('v') {
            versioned.split_once('.').is_some_and(|(version, name)| {
                !version.is_empty()
                    && version.chars().all(|c| c.is_ascii_hexdigit())
                    && !name.is_empty()
            })
        } else {
            let (address, zone) = address
                .split_once('%')
                .map_or((address, None), |(ip, zone)| (ip, Some(zone)));
            address.parse::<std::net::Ipv6Addr>().is_ok()
                && zone.is_none_or(|v| !v.is_empty() && !v.contains('%'))
        };
        if !valid {
            return Err(Failure::new("ValueError").into());
        }
    }
    if host.chars().any(|c| {
        CONTRACT["invalid_netloc"]
            .as_array()
            .unwrap()
            .contains(&json!(u32::from(c)))
    }) {
        return Err(Failure::new("ValueError").into());
    }
    Ok(if host.is_empty() {
        url
    } else {
        host.strip_prefix("www.").unwrap_or(host)
    }
    .into())
}

fn render(data: &Value, query: &Value, maximum: usize) -> Result<String> {
    let object = data
        .as_object()
        .ok_or_else(|| Failure::new("AttributeError"))?;
    let mut results = Vec::new();
    if let Some(raw) = object.get("results") {
        if let Some(items) = raw.as_array() {
            for item in items.iter().take(maximum).filter(|item| item.is_object()) {
                let title = identifier(
                    item.get("title")
                        .filter(|v| truthy(v))
                        .unwrap_or(&json!("")),
                );
                let url = identifier(
                    item.get("url")
                        .filter(|v| truthy(v))
                        .or_else(|| item.get("link").filter(|v| truthy(v)))
                        .unwrap_or(&json!("")),
                );
                let (title, url) = (trim(&title), trim(&url));
                if title.is_empty() || url.is_empty() {
                    continue;
                }
                let mut entry = json!({"position":results.len()+1, "title":title, "link":url, "displayed_link":displayed_link(url)?});
                for key in ["snippet", "date", "last_updated"] {
                    if let Some(value) = item.get(key).filter(|v| truthy(v)) {
                        entry[key] = json!(identifier(value));
                    }
                }
                results.push(entry);
            }
        } else if !raw.is_string() {
            return Err(Failure::new(if raw.is_object() {
                "KeyError"
            } else {
                "TypeError"
            })
            .into());
        }
    }
    let query_text = query.as_str().map(str::to_owned).unwrap_or_else(|| {
        query
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>()
            .join("; ")
    });
    let mut payload = json!({"query":query_text, "search_info":{"total_results":results.len(), "query_displayed":query_text}});
    let mut lines = if let Some(queries) = query.as_array() {
        payload["queries"] = query.clone();
        let mut lines = vec![format!(
            "## Perplexity Search Results for {} related queries",
            queries.len()
        )];
        lines.extend(queries.iter().map(|v| format!("- {}", v.as_str().unwrap())));
        lines
    } else {
        vec![format!("## Perplexity Search Results for \"{query_text}\"")]
    };
    for (source, target) in [("id", "search_id"), ("server_time", "server_time")] {
        if let Some(value) = data.get(source).filter(|v| truthy(v)) {
            payload[target] = value.clone();
        }
    }
    if results.is_empty() {
        lines.push("No results returned.".into());
    } else {
        lines.push(String::new());
        for result in &results {
            let date = result["date"]
                .as_str()
                .map(|s| format!(" ({s})"))
                .unwrap_or_default();
            lines.push(format!(
                "{}. [{}]({}){date}",
                result["position"],
                result["title"].as_str().unwrap(),
                result["link"].as_str().unwrap()
            ));
            if let Some(snippet) = result["snippet"].as_str() {
                lines.push(format!("   {snippet}"));
            }
            if let Some(updated) = result["last_updated"].as_str() {
                lines.push(format!("   Last updated: {updated}"));
            }
        }
        payload["organic_results"] = json!(results);
    }
    Ok(format!(
        "{}\n\n<searchresults>{}</searchresults>",
        lines.join("\n"),
        json_text(&payload, false, true, true)
    ))
}

fn http_error(status: u16, body: &Value) -> String {
    let error = body.get("error").unwrap_or(body);
    let text = |name: &str| {
        error
            .get(name)
            .filter(|v| truthy(v))
            .map(identifier)
            .unwrap_or_default()
    };
    let message = text("message")
        .split(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if fold(&text("code")) == "insufficient_quota"
        || fold(&text("type")) == "insufficient_quota"
        || fold(&message).contains("quota")
    {
        return "Error: Perplexity Search is unavailable because the server-side API quota is exhausted. Report this limitation to the user. It requires an operator billing or quota change; do not retry this tool in the same turn.".into();
    }
    match status {
        429 => "Error: Perplexity Search is temporarily unavailable because the server-side rate limit was reached. Report this limitation to the user and do not retry this tool in the same turn.".into(),
        401 | 403 => "Error: Perplexity Search is unavailable because its operator-managed server credential was rejected. Report this limitation to the user; user authorization cannot fix it, and this tool must not be retried in the same turn.".into(),
        400 if !message.is_empty() => format!("Error: Perplexity Search rejected the request arguments: {} Correct the arguments before retrying.", message.chars().take(400).collect::<String>()),
        400 => "Error: Perplexity Search rejected the request arguments. Correct the arguments before retrying.".into(),
        _ => format!("Error: Perplexity Search failed with provider status {status}. Report the provider failure to the user and do not retry this tool unchanged in the same turn."),
    }
}

#[test]
fn retained_contracts() {
    let mut fixture: Value =
        serde_json::from_str(include_str!("../tests/fixtures/perplexity-search.json")).unwrap();
    crate::document_codecs::tests::expand(&mut fixture);
    for case in fixture["configuration"].as_array().unwrap() {
        let actual = match Settings::new(&case["input"], &HashMap::new()) {
            Ok(settings) => {
                let mut value = json!({"ok":settings.values});
                match settings.schema("configured_search") {
                    Ok(schema) => value["schema"] = schema,
                    Err(_) => value["schema_error"] = json!("ValueError"),
                }
                value
            }
            Err(_) => json!({"error":true}),
        };
        assert_eq!(actual, case["expected"], "configuration {}", case["input"]);
    }
    let settings = Settings::new(&json!({}), &HashMap::new()).unwrap();
    assert_eq!(
        settings.schema("perplexity_search").unwrap(),
        CONTRACT["schema"]
    );
    for case in fixture["inputs"].as_array().unwrap() {
        let actual = match settings.request(&case["input"]) {
            Ok(Err(text)) => json!({"ok":text}),
            Ok(Ok(_)) => panic!("Offline fixture must not dispatch"),
            Err(error) => {
                let error = error.downcast_ref::<Failure>().unwrap();
                json!({"error":error.class,"validation":error.validation})
            }
        };
        assert_eq!(actual, case["expected"], "input {}", case["input"]);
    }
    for case in fixture["queries"].as_array().unwrap() {
        match normalize_query(&case["input"]) {
            Ok(value) => assert_eq!(json!({"ok":value}), case["expected"]),
            Err(message) => assert_eq!(json!(message), case["expected"]["message"]),
        }
    }
    for case in fixture["requests"].as_array().unwrap() {
        match request_payload(&case["input"]) {
            Ok(value) => assert_eq!(
                json!({"ok":value}),
                case["expected"],
                "request {}",
                case["input"]
            ),
            Err(message) => assert_eq!(
                json!(message),
                case["expected"]["message"],
                "request {}",
                case["input"]
            ),
        }
    }
    for case in fixture["results"].as_array().unwrap() {
        match render(
            &case["input"],
            &case["query"],
            case["max_results"].as_u64().unwrap() as usize,
        ) {
            Ok(value) => assert_eq!(
                json!({"ok":value}),
                case["expected"],
                "result {}",
                case["input"]
            ),
            Err(error) => assert_eq!(
                json!(error.downcast_ref::<Failure>().unwrap().class),
                case["expected"]["error"],
                "result {}",
                case["input"]
            ),
        }
    }
    for case in fixture["errors"].as_array().unwrap() {
        assert_eq!(
            json!(http_error(
                case["status"].as_u64().unwrap() as u16,
                &case["body"]
            )),
            case["expected"]
        );
    }
}

#[tokio::test]
#[ignore = "requires the local Python/Rust Perplexity acceptance provider"]
async fn actual_service() {
    let cases: Vec<Value> = serde_json::from_slice(
        &std::fs::read(std::env::var("DAEDALUS_SEARCH_INPUT").unwrap()).unwrap(),
    )
    .unwrap();
    let client = reqwest::Client::new();
    let mut observations = Vec::new();
    for case in cases {
        let control = case["control"].as_str().unwrap();
        client
            .post(format!("{control}/__reset"))
            .json(&case["peer"])
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let mut config = json!({"api_key":"synthetic-key", "base_url":format!("{}/search", case["endpoint"].as_str().unwrap()), "rate_limit_backoff_seconds":0});
        config
            .as_object_mut()
            .unwrap()
            .extend(case["config"].as_object().unwrap().clone());
        let settings = Settings::new(&config, &HashMap::new()).unwrap();
        let start = std::time::Instant::now();
        let result = match settings.call(&case["input"]).await {
            Ok(value) => json!({"ok":value}),
            Err(error) => {
                let error = error.downcast_ref::<Failure>().unwrap();
                let mut value = json!({"error":error.class});
                if error.class == "ValidationError" {
                    value["validation"] = json!(error.validation);
                }
                value
            }
        };
        if let Some(duration) = case["duration"].as_array() {
            let elapsed = start.elapsed().as_secs_f64();
            assert!(
                elapsed >= duration[0].as_f64().unwrap()
                    && elapsed <= duration[1].as_f64().unwrap(),
                "{} took {elapsed}s",
                case["name"]
            );
        }
        let calls: Value = client
            .get(format!("{control}/__calls"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        observations.push(json!({"name":case["name"], "result":result, "calls":calls}));
        println!("Rust Perplexity: {}", case["name"]);
    }
    std::fs::write(
        std::env::var("DAEDALUS_SEARCH_OUTPUT").unwrap(),
        serde_json::to_vec_pretty(&observations).unwrap(),
    )
    .unwrap();
}
