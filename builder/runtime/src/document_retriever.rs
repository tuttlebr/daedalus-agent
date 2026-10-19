//! Metadata caches and embedding/search orchestration for document retrieval.
use crate::{
    config::truthy,
    document_search::{Document, Failure},
    embeddings, milvus, milvus_index_proto as pb, milvus_search,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Cache<T> {
    values: Mutex<VecDeque<(String, Instant, T)>>,
    miss: tokio::sync::Mutex<()>,
}
impl<T: Clone> Cache<T> {
    fn new() -> Self {
        Self {
            values: Mutex::new(VecDeque::new()),
            miss: tokio::sync::Mutex::new(()),
        }
    }
    fn get(&self, key: &str) -> Option<T> {
        let mut values = self.values.lock().expect("retrieval metadata");
        let index = values.iter().position(|(name, _, _)| name == key)?;
        let entry = values.remove(index).unwrap();
        if entry.1 <= Instant::now() {
            return None;
        }
        let result = entry.2.clone();
        values.push_back(entry);
        Some(result)
    }
    fn insert(&self, key: &str, value: T) {
        let mut values = self.values.lock().expect("retrieval metadata");
        values.retain(|(name, _, _)| name != key);
        values.push_back((key.into(), Instant::now() + Duration::from_secs(30), value));
        while values.len() > 128 {
            values.pop_front();
        }
    }
    fn clear(&self) {
        self.values.lock().expect("retrieval metadata").clear();
    }
}

impl milvus::Status for pb::DescribeCollectionResponse {
    fn status(&self) -> Option<&crate::milvus_proto::Status> {
        self.status.as_ref()
    }
}

// DescribeCollection constructs every SDK schema object before exposing names.
// Even unused parameter values can therefore reject the entire lookup.
fn schema_integer(raw: &str) -> bool {
    !raw.chars().any(|c| ('\u{1c}'..='\u{1f}').contains(&c))
        && crate::document_store::integer(raw).is_some()
        && crate::document_store::decimal(raw)
            .bytes()
            .filter(u8::is_ascii_digit)
            .count()
            <= 4300
}

fn schema_json(raw: &str) -> bool {
    let Some(value) = crate::document_json::parse_indexed(raw.as_bytes()) else {
        return false;
    };
    let mut pending = vec![&value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Number(number) if !number.as_f64().is_some_and(f64::is_finite) => {
                return false;
            }
            Value::Array(values) => pending.extend(values),
            Value::Object(values) => pending.extend(values.values()),
            _ => {}
        }
    }
    true
}

fn valid_field(field: &pb::FieldSchema) -> bool {
    [field.data_type, field.element_type]
        .into_iter()
        .all(|kind| matches!(kind, 0..=5 | 10 | 11 | 20..=24 | 26 | 100..=106 | 200 | 201 | 999))
        && field
            .type_params
            .iter()
            .all(|param| match param.key.as_str() {
                "params" => schema_json(&param.value),
                "dim" => schema_integer(&param.value),
                "max_length" if matches!(field.data_type, 21 | 22) => schema_integer(&param.value),
                "max_capacity" if matches!(field.data_type, 22 | 106) => {
                    schema_integer(&param.value)
                }
                _ => true,
            })
        && field
            .index_params
            .iter()
            .all(|param| param.key != "params" || schema_json(&param.value))
}

fn valid_schema(schema: &pb::CollectionSchema) -> bool {
    schema.fields.iter().all(valid_field)
        && schema
            .struct_array_fields
            .iter()
            .all(|nested| nested.fields.iter().all(valid_field))
        && schema
            .functions
            .iter()
            .all(|function| (0..=4).contains(&function.r#type))
    // Struct-array parameters deliberately accept strings after JSON failure.
}

pub struct Retriever {
    client: milvus::Client,
    embedder: Arc<embeddings::Client>,
    settings: Value,
    collections: Cache<bool>,
    schemas: Cache<Vec<String>>,
    slots: tokio::sync::Semaphore,
    reranker: crate::document_reranker::Client,
}
impl Retriever {
    pub fn new(
        config: &crate::config::Config,
        client: milvus::Client,
        embedder: Arc<embeddings::Client>,
        settings: Value,
    ) -> Self {
        Self {
            reranker: crate::document_reranker::Client::new(config, &settings),
            client,
            embedder,
            settings,
            collections: Cache::new(),
            schemas: Cache::new(),
            slots: tokio::sync::Semaphore::new(8),
        }
    }
    fn invalidate(&self) {
        self.collections.clear();
        self.schemas.clear();
    }
    fn read_client(&self) -> milvus::Client {
        self.client
            .with_read_timeout(self.settings["search_timeout"].as_f64())
    }
    fn expired(deadline: Option<tokio::time::Instant>) -> bool {
        deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
    }
    fn read_failure(
        &self,
        error: anyhow::Error,
        describe: bool,
        deadline: Option<tokio::time::Instant>,
    ) -> Failure {
        // Tokio timers can become runnable a fraction of a millisecond after
        // their exact deadline. Preserve the enclosing search timeout when a
        // transport error becomes ready in that interval, including caches.
        if Self::expired(deadline) {
            return Failure::new("TimeoutError");
        }
        self.invalidate();
        let class = match error.downcast_ref::<milvus::ReadFailure>() {
            Some(milvus::ReadFailure::Transport) => "_InactiveRpcError",
            Some(milvus::ReadFailure::Application) if describe => "DescribeCollectionException",
            _ => "MilvusException",
        };
        Failure::new(class)
    }
    /// Whether the client's database lists this collection. Milvus lists
    /// unqualified names within that database.
    async fn exists(
        &self,
        collection: &str,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<bool, Failure> {
        if let Some(value) = self.collections.get(collection) {
            return Ok(value);
        }
        let _miss = self.collections.miss.lock().await;
        if let Some(value) = self.collections.get(collection) {
            return Ok(value);
        }
        let listed = {
            let _slot = self.slots.acquire().await.expect("retriever slots");
            self.read_client()
                .collections()
                .await
                .map_err(|e| self.read_failure(e, false, deadline))?
        };
        let value = listed.iter().any(|v| v == collection);
        self.collections.insert(collection, value);
        Ok(value)
    }
    async fn fields(
        &self,
        collection: &str,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<Vec<String>, Failure> {
        if let Some(value) = self.schemas.get(collection) {
            return Ok(value);
        }
        let _miss = self.schemas.miss.lock().await;
        if let Some(value) = self.schemas.get(collection) {
            return Ok(value);
        }
        let _slot = self.slots.acquire().await.expect("retriever slots");
        let response: pb::DescribeCollectionResponse = self
            .read_client()
            .call(
                "DescribeCollection",
                pb::DescribeCollectionRequest {
                    collection_name: collection.into(),
                    ..Default::default()
                },
                true,
                false,
            )
            .await
            .map_err(|e| self.read_failure(e, true, deadline))?;
        let schema = response.schema.unwrap_or_default();
        if !valid_schema(&schema) {
            self.invalidate();
            return Err(Failure::new("MilvusException"));
        }
        let names = schema
            .fields
            .into_iter()
            .map(|field| field.name)
            .chain(
                schema
                    .struct_array_fields
                    .into_iter()
                    .map(|field| field.name),
            )
            .collect::<Vec<_>>();
        self.schemas.insert(collection, names.clone());
        Ok(names)
    }
    pub async fn search(
        &self,
        query: &str,
        collection: &str,
        input: &Value,
    ) -> Result<Vec<Document>, Failure> {
        self.search_until(query, collection, input, None).await
    }
    pub async fn search_until(
        &self,
        query: &str,
        collection: &str,
        input: &Value,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<Vec<Document>, Failure> {
        if !self.exists(collection, deadline).await? {
            return Err(Failure::new("CollectionNotFoundError"));
        }
        let fields = self.fields(collection, deadline).await?;
        let content = self.settings["content_field"].as_str().unwrap();
        let vector = self.settings["vector_field"].as_str().unwrap();
        if !fields.iter().any(|v| v == content) || !fields.iter().any(|v| v == vector) {
            return Err(Failure::new("ValueError"));
        }
        let mut output = if truthy(&self.settings["output_fields"]) {
            self.settings["output_fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        } else {
            fields.into_iter().filter(|v| v != vector).collect()
        };
        if !output.iter().any(|v| v == content) {
            output.push(content.into());
        }
        let embedded = self.embedder.query(query).await?;
        let limit = if truthy(&input["top_k"]) {
            &input["top_k"]
        } else {
            &self.settings["top_k"]
        };
        let params = if truthy(&self.settings["search_params"]) {
            self.settings["search_params"].clone()
        } else {
            json!({"metric_type":"L2"})
        };
        let args = json!({"collection_name":collection,"output_fields":output,"anns_field":vector,"filter":input["filters"],"limit":limit,"search_params":params});
        let result = {
            let _slot = self.slots.acquire().await.expect("retriever slots");
            let timestamp = self.client.mutation_timestamp(collection);
            match milvus_search::request(&args, &[embedded], timestamp) {
                Ok(request) => milvus_search::search(&mut self.read_client(), request).await,
                Err(error) => Err(error),
            }
        };
        let results = result.map_err(|error| {
            if Self::expired(deadline) {
                return Failure::new("TimeoutError");
            }
            if error.1 {
                self.invalidate();
            }
            Failure::from(error)
        })?;
        let documents = crate::document_search::documents(
            results,
            content,
            self.settings["distance_cutoff"]
                .as_f64()
                .or_else(|| self.settings["distance_cutoff"].as_str()?.parse().ok()),
        )?;
        Ok(self.reranker.apply(query, documents).await)
    }
}
