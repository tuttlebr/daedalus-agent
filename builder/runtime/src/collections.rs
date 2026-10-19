//! Tenant-scoped Milvus names and the frontend's collection metadata contract.
use crate::{config::Config, memory_tools::trim, output::clip};
use anyhow::{Result, bail};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::LazyLock};

pub const SHARED: [&str; 5] = [
    "kubernetes",
    "mentalhealth",
    "nvidia",
    "semianalysis",
    "vetpartner",
];
fn normalize(value: Option<&str>, fallback: &str, maximum: usize) -> String {
    static UNSAFE: LazyLock<Regex> = LazyLock::new(|| Regex::new("[^a-zA-Z0-9_]+").unwrap());
    static UNDERSCORES: LazyLock<Regex> = LazyLock::new(|| Regex::new("_+").unwrap());
    let raw = value
        .map(trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);
    let normalized = UNSAFE.replace_all(raw, "_");
    let normalized = UNDERSCORES.replace_all(&normalized, "_");
    let mut normalized = normalized.trim_matches('_').to_ascii_lowercase();
    if normalized.is_empty() {
        normalized = fallback.into();
    }
    if normalized.starts_with(|c: char| c.is_ascii_digit()) {
        normalized = format!("u_{normalized}");
    }
    clip(&normalized, maximum)
}
pub fn private_part(user: Option<&str>) -> String {
    let user = user
        .map(trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("anonymous");
    let readable = clip(&normalize(Some(user), "anonymous", 64), 24);
    format!("{readable}_{:x}", Sha256::digest(user.as_bytes()))
}
pub fn user_name(user: Option<&str>, base: Option<&str>) -> String {
    format!("{}_{}", upload_base(base), private_part(user))
}
/// The private-collection prefix a configured upload base resolves to.
pub fn upload_base(base: Option<&str>) -> String {
    normalize(base, "user_uploads", 64)
}
/// Whether a Milvus database setting selects Milvus's default database.
pub fn default_database(value: &str) -> bool {
    matches!(trim(value), "" | "default")
}
// Ingestion and metadata share the retained collection naming rules.
pub(super) fn resolve(collection: Option<&str>, user: Option<&str>, base: Option<&str>) -> String {
    let Some(collection) = collection.filter(|s| !s.is_empty()) else {
        return user_name(user, base);
    };
    let collection = normalize(Some(collection), "user_uploads", 255);
    let part = private_part(user);
    let legacy = normalize(user, "anonymous", 64);
    if SHARED.contains(&collection.as_str())
        || collection == part
        || collection.ends_with(&format!("_{part}"))
    {
        return collection;
    }
    let base = collection
        .strip_suffix(&format!("_{legacy}"))
        .unwrap_or(&collection);
    user_name(user, Some(base))
}
pub(super) fn scope(collection: &str, requested: Option<&str>, write: bool) -> Result<String> {
    let actual = if SHARED.contains(&normalize(Some(collection), "", 255).as_str()) {
        "shared"
    } else {
        "user"
    };
    if let Some(requested) = requested.filter(|s| !s.is_empty()) {
        let requested = trim(requested).to_lowercase();
        if !["user", "shared"].contains(&requested.as_str()) {
            bail!("collection_scope must be 'shared' or 'user'.");
        }
        if requested != actual {
            bail!(
                "collection_scope '{requested}' does not match collection '{collection}' ({actual})."
            );
        }
    }
    if write && actual == "shared" {
        bail!(
            "Shared collection writes are not permitted through user-facing document ingestion. Ingest into your private collection instead."
        );
    }
    Ok(actual.into())
}
pub fn metadata(config: &Config, user: &str, existing: &[String]) -> Value {
    let existing: HashSet<_> = existing.iter().map(String::as_str).collect();
    let name = user_name(
        Some(user),
        Some(&config.variable("DOCUMENT_INGEST_DEFAULT_COLLECTION", "user_uploads")),
    );
    let user = json!({"name":name, "displayName":"My documents", "scope":"user", "exists":existing.contains(name.as_str()), "readable":true, "writable":true});
    let database = config.variable("MILVUS_DATABASE", "default");
    json!({
        "databaseName": if trim(&database).is_empty() { "default" } else { trim(&database) },
        "userCollection":user,
        "sharedCollections":SHARED.into_iter().map(|name| json!({"name":name, "displayName":name, "scope":"shared", "exists":existing.contains(name), "readable":true, "writable":false})).collect::<Vec<_>>(),
        "writableCollections":[user],
    })
}
pub fn kwargs(config: &Config) -> Value {
    let mut result = json!({"uri":config.variable("MILVUS_URI", "http://milvus.daedalus.svc.cluster.local:19530")});
    let token = config.variable("MILVUS_TOKEN", "");
    let user = config.variable("MILVUS_USERNAME", "");
    let user = if user.is_empty() {
        config.variable("MILVUS_USER", "")
    } else {
        user
    };
    let password = config.variable("MILVUS_PASSWORD", "");
    if !trim(&token).is_empty() {
        result["token"] = json!(trim(&token));
    } else if !trim(&user).is_empty() || !trim(&password).is_empty() {
        result["user"] = json!(trim(&user));
        result["password"] = json!(trim(&password));
    }
    let database = config.variable("MILVUS_DATABASE", "default");
    if !trim(&database).is_empty() && trim(&database) != "default" {
        result["db_name"] = json!(trim(&database));
    }
    result
}
pub fn timeout(config: &Config) -> Result<f64> {
    if config
        .env
        .get("MILVUS_METADATA_TIMEOUT_SECONDS")
        .is_some_and(|s| trim(s).is_empty())
    {
        bail!("Invalid metadata timeout");
    }
    let value = crate::document_processor::number(config, "MILVUS_METADATA_TIMEOUT_SECONDS", 3.)?;
    // Python min(10, NaN) keeps its first argument.
    Ok(if value.is_nan() {
        10.
    } else {
        value.clamp(0.5, 10.)
    })
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub fn fixture() -> Value {
        let mut value =
            serde_json::from_str(include_str!("../tests/fixtures/collections.json")).unwrap();
        crate::document_codecs::tests::expand(&mut value);
        value
    }
    fn config(env: &Value) -> Config {
        Config {
            raw: json!({}),
            policy_raw: json!({}),
            env: serde_json::from_value(env.clone()).unwrap(),
            python_tools: false,
        }
    }
    #[test]
    fn retained_names_scopes_and_metadata() {
        let data = fixture();
        for case in data["cases"].as_array().unwrap() {
            let a = &case["args"];
            let actual = match case["kind"].as_str().unwrap() {
                "part" => Ok(normalize(a[0].as_str(), a[1].as_str().unwrap(), 64)),
                "name" => Ok(normalize(a[0].as_str(), a[1].as_str().unwrap(), 255)),
                "private_part" => Ok(private_part(a[0].as_str())),
                "user_name" => Ok(user_name(a[0].as_str(), a[1].as_str())),
                "resolve" => Ok(resolve(a[0].as_str(), a[1].as_str(), a[2].as_str())),
                "scope" | "write_scope" => scope(
                    a[0].as_str().unwrap(),
                    a[1].as_str(),
                    case["kind"] == "write_scope",
                ),
                _ => unreachable!(),
            };
            if let Some(value) = case["expected"].get("ok") {
                assert_eq!(json!(actual.unwrap()), *value, "{case}");
            } else {
                assert_eq!(
                    actual.unwrap_err().to_string(),
                    case["expected"]["message"].as_str().unwrap(),
                    "{case}"
                );
            }
        }
        for case in data["metadata"].as_array().unwrap() {
            assert_eq!(
                metadata(
                    &config(&case["env"]),
                    case["user"].as_str().unwrap(),
                    &serde_json::from_value::<Vec<String>>(case["existing"].clone()).unwrap()
                ),
                case["expected"]
            );
        }
        for case in data["configs"].as_array().unwrap() {
            assert_eq!(kwargs(&config(&case["env"])), case["expected"]);
        }
        for case in data["timeouts"].as_array().unwrap() {
            let env = if case["value"].is_null() {
                json!({})
            } else {
                json!({"MILVUS_METADATA_TIMEOUT_SECONDS":case["value"]})
            };
            let actual = timeout(&config(&env));
            if let Some(value) = case["expected"].get("ok") {
                assert_eq!(json!(actual.unwrap()), *value, "{case}");
            } else {
                assert!(actual.is_err(), "{case}");
            }
        }
    }
}
