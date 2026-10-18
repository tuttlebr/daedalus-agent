//! Native NVIDIA documentation search with fixed product routing and one deadline.
use anyhow::{Result, anyhow, bail};
use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, ClientConfig},
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use std::sync::LazyLock;
use std::time::Duration;

static CONTRACT: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../resources/nvidia-docs.json")).unwrap());

/// Normalize the pinned Pydantic models, retaining defaults, field order,
/// aliases and unknown extension fields. Arbitrary metadata is left intact.
fn model(input: &Value, schema: &Value, definitions: &Value) -> Result<Value> {
    if let Some(reference) = schema["$ref"].as_str() {
        let name = reference
            .strip_prefix("#/$defs/")
            .ok_or_else(|| anyhow!("Unknown docs model reference"))?;
        return model(input, &definitions[name], definitions);
    }
    if let Some(options) = schema["anyOf"].as_array() {
        return options
            .iter()
            .find_map(|option| model(input, option, definitions).ok())
            .ok_or_else(|| anyhow!("Invalid docs model union"));
    }
    let mut output = if schema["type"] == "object" && schema["properties"].is_object() {
        let mut source = input
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("Invalid docs model object"))?;
        let mut target = serde_json::Map::new();
        for (key, field) in schema["properties"].as_object().unwrap() {
            let value = match source.shift_remove(key) {
                Some(value) => model(&value, field, definitions)?,
                None => field
                    .get("default")
                    .cloned()
                    .ok_or_else(|| anyhow!("Missing docs model field"))?,
            };
            target.insert(if key == "_meta" { "meta" } else { key }.into(), value);
        }
        if schema["additionalProperties"] == false && !source.is_empty() {
            bail!("Unknown docs model field");
        }
        target.extend(source);
        Value::Object(target)
    } else if schema["type"] == "array" {
        Value::Array(
            input
                .as_array()
                .ok_or_else(|| anyhow!("Invalid docs model array"))?
                .iter()
                .map(|item| model(item, &schema["items"], definitions))
                .collect::<Result<_>>()?,
        )
    } else {
        crate::document_tools::coerce(input, schema)?
    };
    if schema.get("const").is_some_and(|value| value != &output)
        || schema["enum"]
            .as_array()
            .is_some_and(|values| !values.contains(&output))
    {
        bail!("Invalid docs model literal");
    }
    if let Some(text) = output.as_str() {
        let length = text.chars().count() as u64;
        if schema["minLength"].as_u64().is_some_and(|min| length < min)
            || schema["maxLength"].as_u64().is_some_and(|max| length > max)
        {
            bail!("Invalid docs model string length");
        }
        if schema["format"] == "uri" {
            output = json!(reqwest::Url::parse(text)?.as_str());
        }
    }
    if schema["type"] == "number" || schema["type"] == "integer" {
        let number = output
            .as_f64()
            .or_else(|| output.as_str()?.parse::<f64>().ok())
            .ok_or_else(|| anyhow!("Invalid docs model number"))?;
        for (key, allowed) in [
            (
                "minimum",
                schema["minimum"].as_f64().is_none_or(|n| number >= n),
            ),
            (
                "maximum",
                schema["maximum"].as_f64().is_none_or(|n| number <= n),
            ),
            (
                "exclusiveMinimum",
                schema["exclusiveMinimum"]
                    .as_f64()
                    .is_none_or(|n| number > n),
            ),
        ] {
            if !allowed {
                bail!("Invalid docs model {key}");
            }
        }
    }
    Ok(output)
}

pub struct Settings {
    pub values: Value,
}
impl Settings {
    pub fn new(raw: &Value) -> Result<Self> {
        let mut raw = raw.clone();
        if raw["_type"] == "nvidia_docs" {
            raw.as_object_mut().unwrap().shift_remove("_type");
        }
        Ok(Self {
            values: model(&raw, &CONTRACT["configuration_schema"], &Value::Null)?,
        })
    }
    pub fn schema(&self, name: &str) -> Result<Value> {
        if crate::memory_tools::trim(self.values["description"].as_str().unwrap()).is_empty() {
            bail!("Tool requires a nonempty model-facing description");
        }
        let mut schema = CONTRACT["schema"].clone();
        schema["name"] = json!(name);
        schema["description"] = self.values["description"].clone();
        Ok(schema)
    }
    pub async fn call(&self, raw: &Value, max_bytes: usize) -> Result<String> {
        let (product, query) = arguments(raw)?;
        Ok(search_endpoint(
            product,
            query,
            CONTRACT["endpoints"][product].as_str().unwrap(),
            self.values["timeout"].as_f64().unwrap(),
            max_bytes,
        )
        .await)
    }
}

pub fn result_payload(raw: &Value) -> Result<Value> {
    model(
        raw,
        &CONTRACT["result_schema"],
        &CONTRACT["result_schema"]["$defs"],
    )
}

fn arguments(raw: &Value) -> Result<(&str, &str), crate::document_search::Failure> {
    static INPUT: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
        jsonschema::options()
            .should_validate_formats(false)
            .build(&CONTRACT["schema"]["parameters"])
            .unwrap()
    });
    let mut errors: Vec<_> = INPUT.iter_errors(raw).collect();
    // Python's validator visits schema keywords in their captured order.
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
        return Err(crate::document_search::Failure {
            class: "ValidationError",
            validation,
        });
    }
    Ok((
        raw["product"].as_str().unwrap(),
        crate::memory_tools::trim(raw["query"].as_str().unwrap()),
    ))
}

async fn search_endpoint(
    product: &str,
    query: &str,
    endpoint: &str,
    timeout: f64,
    max_bytes: usize,
) -> String {
    use crate::memory_tools::json_text;
    if query.is_empty() {
        return json_text(
            &json!({"error":"query_required", "product":product}),
            false,
            true,
            true,
        );
    }
    let timeout = Duration::from_secs_f64(timeout);
    let deadline = tokio::time::Instant::now() + timeout;
    let mut connection = None;
    let result = {
        let request = async {
            let mut builder = reqwest::Client::builder()
                .timeout(timeout)
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never());
            if let Ok(path) = std::env::var("SSL_CERT_FILE") {
                let pem = std::fs::read(path).map_err(|_| "FileNotFoundError")?;
                let certificates =
                    reqwest::Certificate::from_pem_bundle(&pem).map_err(|_| "SSLError")?;
                if certificates.is_empty() {
                    return Err("SSLError");
                }
                builder = builder.tls_certs_only(certificates);
            }
            let http = builder.build().map_err(|_| "ExceptionGroup")?;
            let http = crate::mcp_http::BoundedHttp::for_docs(http, max_bytes);
            let transport = StreamableHttpClientTransportConfig::with_uri(endpoint.to_owned())
                .max_concurrent_requests(1)
                .control_request_timeout(timeout)
                .reinit_on_expired_session(false);
            let client: ClientConfig =
                serde_json::from_value(json!({"protocolVersion":"2025-11-25",
            "capabilities":{},"clientInfo":{"name":"mcp","version":"0.1.0"}}))
                .unwrap();
            connection = Some(
                client
                    .serve(StreamableHttpClientTransport::with_client(
                        http.clone(),
                        transport,
                    ))
                    .await
                    .map_err(|_| "ExceptionGroup")?,
            );
            let session = connection.as_mut().unwrap();
            let _reply = session
                .peer()
                .call_tool_once(
                    CallToolRequestParams::new("searchDocs")
                        .with_arguments(serde_json::from_value(json!({"query":query})).unwrap()),
                )
                .await;
            // The retained SDK accepts a few scalar coercions that rmcp rejects.
            // Validate the captured correlated result using its pinned model rules.
            let result = async {
                let raw = http.take_result().ok_or("ExceptionGroup")?;
                let result = result_payload(&raw).map_err(|_| "ExceptionGroup")?;
                if result["isError"] != true {
                    let tools = session
                        .list_tools(None)
                        .await
                        .map_err(|_| "ExceptionGroup")?;
                    if let Some(schema) = tools
                        .tools
                        .iter()
                        .rev()
                        .find(|tool| tool.name == "searchDocs")
                        .and_then(|tool| tool.output_schema.as_ref())
                        && (result["structuredContent"].is_null()
                            || !jsonschema::options()
                                .should_validate_formats(false)
                                .build(&json!(&**schema))
                                .map_err(|_| "ExceptionGroup")?
                                .is_valid(&result["structuredContent"]))
                    {
                        return Err("ExceptionGroup");
                    }
                }
                Ok::<_, &str>(json_text(
                    &json!({"endpoint":endpoint,"product":product,"result":result}),
                    false,
                    false,
                    true,
                ))
            }
            .await;
            session.close().await.map_err(|_| "ExceptionGroup")?;
            result
        };
        tokio::pin!(request);
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => Err("TimeoutError"),
            result = &mut request => if result.is_err() && tokio::time::Instant::now() >= deadline {
                Err("TimeoutError")
            } else {result},
        }
    };
    if result == Err("TimeoutError")
        && let Some(session) = &mut connection
    {
        // Keep the session outside the timed future so cancellation can finish
        // its bounded DELETE before the result is exposed or the next run starts.
        let _ = session.close_with_timeout(timeout).await;
    }
    match result {
        Ok(value) => value,
        Err("TimeoutError") => json_text(
            &json!({"error":"docs_timeout","product":product}),
            false,
            true,
            true,
        ),
        Err(class) => json_text(
            &json!({"error":"docs_unavailable","error_class":class,"product":product}),
            false,
            true,
            true,
        ),
    }
}

#[tokio::test]
#[ignore = "opt-in real MCP peer acceptance"]
async fn actual_docs() {
    let input = std::env::var("DAEDALUS_DOCS_INPUT").unwrap();
    let output = std::env::var("DAEDALUS_DOCS_OUTPUT").unwrap();
    let cases: Vec<Value> = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    let control = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut results = Vec::new();
    for case in cases {
        let endpoint = case["endpoint"].as_str().unwrap();
        let control_endpoint = case["control"].as_str().unwrap_or(endpoint);
        control
            .post(format!("{control_endpoint}/__reset"))
            .json(&case["peer"])
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let result = match arguments(&case["input"]) {
            Ok((product, query)) => {
                let target = if case["fixed_endpoints"] == true {
                    CONTRACT["endpoints"][product].as_str().unwrap().to_owned()
                } else {
                    format!("{endpoint}/{product}")
                };
                json!({"ok":search_endpoint(product, query, &target, case["timeout"].as_f64().unwrap(), 64 * 1024 * 1024).await})
            }
            Err(error) => json!({"error":error.class}),
        };
        if let Some(settle) = case["settle"].as_f64() {
            tokio::time::sleep(Duration::from_secs_f64(settle)).await;
        }
        let calls: Value = control
            .get(format!("{control_endpoint}/__calls"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        println!("Native NVIDIA docs: {}", case["name"]);
        results.push(json!({"name":case["name"], "result":result, "calls":calls}));
    }
    std::fs::write(output, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
}

#[test]
fn retained_docs_contracts() {
    let mut fixture: Value =
        serde_json::from_str(include_str!("../tests/fixtures/nvidia-docs.json")).unwrap();
    crate::document_codecs::tests::expand(&mut fixture);
    for case in fixture["configuration"].as_array().unwrap() {
        let actual = match Settings::new(&case["input"]) {
            Ok(settings) => {
                let mut value = json!({"ok":settings.values});
                match settings.schema("configured_docs") {
                    Ok(schema) => value["schema"] = schema,
                    Err(_) => value["schema_error"] = json!("ValueError"),
                }
                value
            }
            Err(_) => json!({"error":true}),
        };
        assert_eq!(actual, case["expected"], "configuration {}", case["input"]);
    }
    assert_eq!(
        Settings::new(&json!({}))
            .unwrap()
            .schema("nvidia_docs")
            .unwrap(),
        CONTRACT["schema"]
    );
    for case in fixture["results"].as_array().unwrap() {
        let actual = match result_payload(&case["input"]) {
            Ok(value) => json!({"ok":value}),
            Err(_) => json!({"error":true}),
        };
        assert_eq!(actual, case["expected"], "result {}", case["input"]);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let settings = Settings::new(&json!({})).unwrap();
    for case in fixture["inputs"].as_array().unwrap() {
        let actual = match arguments(&case["input"]) {
            Ok((_, query)) => {
                assert!(
                    query.is_empty(),
                    "Valid fixtures must not contact public services"
                );
                // Blank queries return before any client or session exists.
                json!({"ok":runtime.block_on(settings.call(&case["input"], 1024)).unwrap()})
            }
            Err(error) => json!({"error":error.class,"validation":error.validation}),
        };
        assert_eq!(actual, case["expected"], "input {}", case["input"]);
    }
}
