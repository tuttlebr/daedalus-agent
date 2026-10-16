//! Native curated-domain retrieval with bounded results and search deadlines.
use crate::{config::truthy, document_tools::coerce, memory_tools::trim};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
};

static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/domain-retriever.json")).unwrap()
});

pub struct Settings {
    pub values: Value,
}

fn field(input: &Value, schema: &Value) -> Result<Value> {
    if let Some(options) = schema["anyOf"].as_array() {
        return options
            .iter()
            .find_map(|option| field(input, option).ok())
            .ok_or_else(|| anyhow!("Invalid domain tool configuration"));
    }
    let mut value = coerce(input, schema)?;
    // Both integer settings have small, explicit bounds. Arbitrary-precision
    // integers outside i64 must fail even when they cannot convert to f64.
    if schema["type"] == "integer" && value.as_i64().is_none() {
        bail!("Invalid bounded domain tool integer");
    }
    if schema["format"] == "uri" {
        let raw = value.as_str().unwrap();
        if raw.chars().count() > 2083 {
            bail!("Invalid domain tool URI");
        }
        let url = reqwest::Url::parse(raw)?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            bail!("Invalid domain tool URI");
        }
        value = json!(url.as_str());
    }
    if schema["additionalProperties"].is_object() {
        for item in value.as_object().unwrap().values() {
            field(item, &schema["additionalProperties"])?;
        }
    }
    if let Some(number) = value.as_f64().or_else(|| {
        (schema["type"] == "number")
            .then(|| value.as_str()?.parse().ok())
            .flatten()
    }) {
        for (key, allowed) in [
            (
                "minimum",
                schema["minimum"].as_f64().is_none_or(|v| number >= v),
            ),
            (
                "maximum",
                schema["maximum"].as_f64().is_none_or(|v| number <= v),
            ),
            (
                "exclusiveMinimum",
                schema["exclusiveMinimum"]
                    .as_f64()
                    .is_none_or(|v| number > v),
            ),
        ] {
            if !allowed {
                bail!("Domain tool value violates {key}");
            }
        }
    }
    Ok(value)
}

impl Settings {
    pub fn new(raw: &Value, env: &HashMap<String, String>) -> Result<Self> {
        let raw = raw
            .as_object()
            .ok_or_else(|| anyhow!("Invalid domain tool configuration"))?;
        for name in ["uri", "embedding_model"] {
            if !raw.contains_key(name) {
                bail!("Missing domain tool {name}");
            }
        }
        if raw.contains_key("vector_field") && raw.contains_key("vector_field_name") {
            bail!("Duplicate domain tool vector field");
        }
        let mut values = CONTRACT["defaults"].clone();
        let variable = |name: &str| env.get(name).map(String::as_str).unwrap_or("");
        let token = trim(variable("MILVUS_TOKEN"));
        let mut connection = json!({});
        if !token.is_empty() {
            connection["token"] = json!(token);
        } else {
            let username = variable("MILVUS_USERNAME");
            for (key, value) in [
                (
                    "user",
                    if username.is_empty() {
                        variable("MILVUS_USER")
                    } else {
                        username
                    },
                ),
                ("password", variable("MILVUS_PASSWORD")),
            ] {
                if !trim(value).is_empty() {
                    connection[key] = json!(trim(value));
                }
            }
        }
        values["connection_args"] = connection;
        let fields = &CONTRACT["configuration_schema"]["properties"];
        for (name, value) in raw {
            if name == "_type" && value == "domain_retriever" {
                continue;
            }
            let name = if name == "vector_field_name" {
                "vector_field"
            } else {
                name
            };
            let schema = fields
                .get(name)
                .ok_or_else(|| anyhow!("Unknown domain tool field"))?;
            values[name] = field(value, schema)?;
        }
        Ok(Self { values })
    }

    pub fn schema(&self, name: &str) -> Value {
        let mut schema = CONTRACT["schema"].clone();
        schema["name"] = json!(name);
        if truthy(&self.values["description"]) {
            schema["description"] = self.values["description"].clone();
        }
        schema
    }
}

pub struct Adapter {
    config: crate::config::Config,
    settings: Settings,
    embedders: Arc<crate::embeddings::Registry>,
    retriever: tokio::sync::OnceCell<crate::document_retriever::Retriever>,
}
impl Adapter {
    pub fn schema(&self, name: &str) -> Value {
        self.settings.schema(name)
    }
    pub fn with_embedders(
        config: &crate::config::Config,
        raw: &Value,
        embedders: Arc<crate::embeddings::Registry>,
    ) -> Result<Self> {
        Ok(Self {
            config: config.clone(),
            settings: Settings::new(raw, &config.env)?,
            embedders,
            retriever: tokio::sync::OnceCell::new(),
        })
    }
    pub async fn search(&self, input: &Value) -> Result<String> {
        use crate::document_search::Failure;
        static VALIDATOR: LazyLock<jsonschema::Validator> =
            LazyLock::new(|| jsonschema::validator_for(&CONTRACT["schema"]["parameters"]).unwrap());
        let errors: Vec<Value> = VALIDATOR.iter_errors(input).take(8).map(|error| {
            let kind = error.kind().keyword();
            let location: Vec<_> = error.instance_path().to_string().split('/').skip(1).map(|part| json!(part.replace("~1", "/").replace("~0", "~"))).collect();
            json!({"type":"value_error","loc":location,"msg":format!("Value error, Argument contract: {kind}"),"ctx":{"error":format!("Argument contract: {kind}")}})
        }).collect();
        if !errors.is_empty() {
            return Err(Failure {
                class: "ValidationError",
                validation: errors,
            }
            .into());
        }
        let domain = input["domain"].as_str().unwrap();
        let normalized = trim(domain).to_lowercase();
        let collection = self.settings.values["domain_collections"][&normalized]
            .as_str()
            .filter(|value| !value.is_empty());
        let Some(collection) = collection else {
            let mut domains = self.settings.values["domain_collections"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>();
            domains.sort();
            return Ok(format!(
                "Error: unknown domain '{domain}'. Available domains: {}",
                domains.join(", ")
            ));
        };
        let retriever = self
            .retriever
            .get_or_try_init(|| async {
                let embedder = self
                    .embedders
                    .get(self.settings.values["embedding_model"].as_str().unwrap())
                    .map_err(Failure::from)?;
                let mut args = self.settings.values["connection_args"].clone();
                if args.get("uri").is_some() {
                    return Err(Failure::new("TypeError"));
                }
                args["uri"] = self.settings.values["uri"].clone();
                let client = crate::milvus::Client::for_domain(&self.config, &args)
                    .await
                    .map_err(|error| {
                        if error.is::<Failure>() {
                            return error.downcast::<Failure>().unwrap();
                        }
                        Failure::new(match error.downcast_ref::<crate::milvus::ReadFailure>() {
                            Some(crate::milvus::ReadFailure::Configuration) => {
                                "ConnectionConfigException"
                            }
                            Some(crate::milvus::ReadFailure::Transport) => "_InactiveRpcError",
                            _ => "MilvusException",
                        })
                    })?;
                Ok::<_, Failure>(crate::document_retriever::Retriever::new(
                    &self.config,
                    client,
                    embedder,
                    self.settings.values.clone(),
                ))
            })
            .await?;
        let query = input["query"].as_str().unwrap();
        if query.is_empty() {
            return Err(Failure::new("ValueError").into());
        }
        let mut input = input.clone();
        if input["top_k"].is_number() {
            input["top_k"] = crate::document_tools::integer(&input["top_k"])?;
        }
        let timeout = &self.settings.values["search_timeout"];
        let timeout = timeout
            .as_f64()
            .or_else(|| timeout.as_str()?.parse::<f64>().ok());
        let documents = if let Some(seconds) = timeout.filter(|v| *v != f64::INFINITY) {
            if seconds.is_nan() || seconds <= 0.0 {
                return Err(Failure::new("TimeoutError").into());
            }
            let duration = std::time::Duration::try_from_secs_f64(seconds)
                .map_err(|_| Failure::new("OverflowError"))?;
            let deadline = tokio::time::Instant::now()
                .checked_add(duration)
                .ok_or_else(|| Failure::new("OverflowError"))?;
            let search = retriever.search_until(query, collection, &input, Some(deadline));
            // A simultaneously ready gRPC deadline must not win over the
            // enclosing search deadline and expose a transport exception.
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(deadline) => return Err(Failure::new("TimeoutError").into()),
                result = search => {
                    if result.is_err() && tokio::time::Instant::now() >= deadline {
                        return Err(Failure::new("TimeoutError").into());
                    }
                    result?
                },
            }
        } else {
            retriever.search(query, collection, &input).await?
        };
        Ok(crate::document_search::format_domain(
            &documents,
            &normalized,
        )?)
    }
}

#[test]
fn retained_domain_contracts() {
    fn expand_integers(value: &mut Value) {
        if let Some(parts) = value.get("$integer_parts").and_then(Value::as_array) {
            *value = serde_json::from_str(
                &parts
                    .iter()
                    .map(|part| part.as_str().unwrap())
                    .collect::<String>(),
            )
            .unwrap();
        } else {
            match value {
                Value::Object(map) => map.values_mut().for_each(expand_integers),
                Value::Array(items) => items.iter_mut().for_each(expand_integers),
                _ => {}
            }
        }
    }
    let mut fixture: Value =
        serde_json::from_str(include_str!("../tests/fixtures/domain-retriever.json")).unwrap();
    crate::document_codecs::tests::expand(&mut fixture);
    expand_integers(&mut fixture);
    for case in fixture["configuration"].as_array().unwrap() {
        let env = serde_json::from_value(case["env"].clone()).unwrap();
        let actual = match Settings::new(&case["input"], &env) {
            Ok(settings) => json!({"ok":settings.values}),
            Err(_) => json!({"error":true}),
        };
        assert_eq!(actual, case["expected"], "configuration {}", case["input"]);
    }
    let settings = Settings::new(
        &json!({"uri":"http://milvus:19530", "embedding_model":"synthetic"}),
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(settings.schema("domain_search"), CONTRACT["schema"]);
    for case in fixture["formatting"].as_array().unwrap() {
        let documents = case["documents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| crate::document_search::Document {
                content: d["page_content"].as_str().map(str::to_owned),
                metadata: d["metadata"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, value)| {
                        (
                            key.clone(),
                            crate::milvus_search::Field::Json(value.clone()),
                        )
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        let actual = match crate::document_search::format_domain(
            &documents,
            case["domain"].as_str().unwrap(),
        ) {
            Ok(text) => json!(text),
            Err(error) => json!({"error":error.class}),
        };
        assert_eq!(actual, case["expected"], "formatting {case}");
    }
}
