//! Milvus indexing lifecycle. Every mutation is awaited; this layer never
//! replays an RPC after a transport failure.
use crate::{document_index, milvus_index_proto as pb, milvus_proto::Status, milvus_writer};
use anyhow::{Result, anyhow, bail};
use prost::Message;
use serde_json::{Value, json};
use std::{future::Future, time::Duration};

/// The retained consumer uses the ORM's default database for its schema/list
/// reads, and its separately configured client database for writes. Keep this
/// distinction explicit until transport acceptance has covered operator URIs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Context {
    Client,
    Orm,
    Connection,
}
pub trait Io: Send {
    fn exchange<I, O>(
        &mut self,
        method: &'static str,
        input: I,
        context: Context,
    ) -> impl Future<Output = Result<O>> + Send
    where
        I: Message + Default + Clone + Send + Sync + 'static,
        O: Message + Default + Send + Sync + 'static;
    fn sleep(&mut self, duration: Duration) -> impl Future<Output = ()> + Send;
    fn record_mutation(&mut self, _collection: &str, _timestamp: u64) {}
}
trait Reply: Message + Default + Send + Sync + 'static {
    fn status(&self) -> Option<&Status>;
}
macro_rules! replies {
    ($($name:ident),*) => {$(impl Reply for pb::$name {
        fn status(&self)->Option<&Status> {self.status.as_ref()}
    })*};
}
replies!(
    ShowCollectionsResponse,
    DescribeCollectionResponse,
    DescribeIndexResponse,
    AllocTimestampResponse,
    GetLoadingProgressResponse,
    MutationResult,
    FlushResponse,
    GetFlushStateResponse,
    GetVersionResponse
);
impl Reply for Status {
    fn status(&self) -> Option<&Status> {
        Some(self)
    }
}
#[derive(Clone, Copy)]
enum Missing {
    None,
    Collection,
    Index,
}
fn missing(status: &Status, allowed: Missing) -> bool {
    match allowed {
        Missing::None => false,
        Missing::Collection => {
            status.code == 100
                || status.error_code == 4
                || (status.error_code == 1 && status.reason.contains("can't find collection"))
        }
        Missing::Index => status.code == 700 || status.error_code == 25,
    }
}
fn server_error(code: i32, reason: &str) -> anyhow::Error {
    anyhow!("<MilvusException: (code={code}, message={reason})>")
}
async fn call<T: Io, I, O: Reply>(
    io: &mut T,
    method: &'static str,
    input: I,
    context: Context,
    allowed: Missing,
) -> Result<O>
where
    I: Message + Default + Clone + Send + Sync + 'static,
{
    let mut backoff = Duration::from_millis(if method == "Flush" { 1000 } else { 10 });
    for attempt in 0..=75 {
        let result: O = io.exchange(method, input.clone(), context).await?;
        if let Some(status) = result.status()
            && (status.code != 0 || status.error_code != 0)
            && !missing(status, allowed)
        {
            if status.code == 8 || status.error_code == 49 {
                // Milvus explicitly rejected this attempt. Retrying this status
                // is distinct from replaying an unconfirmed transport failure.
                if attempt < 75 {
                    io.sleep(backoff).await;
                    backoff = (backoff * 3).min(Duration::from_secs(3));
                    continue;
                }
                let operation = match method {
                    "Insert" => "insert_rows".to_owned(),
                    "ShowCollections" => "list_collections".to_owned(),
                    name => name
                        .chars()
                        .enumerate()
                        .flat_map(|(i, c)| {
                            let mut out = Vec::new();
                            if i > 0 && c.is_ascii_uppercase() {
                                out.push('_');
                            }
                            out.push(c.to_ascii_lowercase());
                            out
                        })
                        .collect(),
                };
                return Err(server_error(
                    status.code,
                    &format!(
                        "[{operation}] Retry run out of 75 retry times, message={}",
                        status.reason
                    ),
                ));
            }
            return Err(server_error(status.code, &status.reason));
        }
        return Ok(result);
    }
    unreachable!("bounded retry loop always returns")
}
async fn describe(
    io: &mut impl Io,
    collection: &str,
    context: Context,
    allow_missing: bool,
) -> Result<pb::DescribeCollectionResponse> {
    call(
        io,
        "DescribeCollection",
        pb::DescribeCollectionRequest {
            collection_name: collection.into(),
            ..Default::default()
        },
        context,
        if allow_missing {
            Missing::Collection
        } else {
            Missing::None
        },
    )
    .await
}
async fn exists(io: &mut impl Io, collection: &str) -> Result<bool> {
    let result = describe(io, collection, Context::Client, true).await?;
    Ok(!result
        .status
        .as_ref()
        .is_some_and(|status| missing(status, Missing::Collection)))
}

/// As in the retained implementation, a failed read probe does not block the
/// subsequent writer. A confirmed dimension mismatch does, before any writes.
pub async fn dimension_probe(
    io: &mut impl Io,
    collection: &str,
    dimension: i64,
    vector_field: &str,
) -> Result<()> {
    let probe = async {
        let list: pb::ShowCollectionsResponse = call(
            io,
            "ShowCollections",
            pb::ShowCollectionsRequest::default(),
            Context::Client,
            Missing::None,
        )
        .await?;
        if !list.collection_names.iter().any(|name| name == collection) {
            return Ok::<_, anyhow::Error>(None);
        }
        Ok(describe(io, collection, Context::Client, false)
            .await?
            .schema)
    }
    .await;
    let Ok(Some(schema)) = probe else {
        return Ok(());
    };
    let fields: Vec<_> = schema
        .fields
        .iter()
        .map(|field| {
            let params: serde_json::Map<_, _> = field
                .type_params
                .iter()
                .map(|p| (p.key.clone(), json!(p.value)))
                .collect();
            json!({"name":field.name,"params":params})
        })
        .collect();
    if let Some(actual) = document_index::dimension(&json!({"fields":fields}), vector_field)?
        && dimension != 0
        && actual != json!(dimension)
    {
        bail!(
            "Embedding dimension mismatch for Milvus collection '{collection}': existing dim={actual}, configured embedder_dim={dimension}. Re-ingesting would corrupt retrieval; use a matching embedder or a different collection."
        );
    }
    Ok(())
}
fn ambiguous_index() -> anyhow::Error {
    anyhow!(
        "<AmbiguousIndexName: (code=1, message=There are multiple indexes, please specify the index_name.)>"
    )
}
async fn indexes(
    io: &mut impl Io,
    collection: &str,
    name: &str,
    timestamp: u64,
    context: Context,
    allowed: Missing,
) -> Result<pb::DescribeIndexResponse> {
    call(
        io,
        "DescribeIndex",
        pb::DescribeIndexRequest {
            collection_name: collection.into(),
            index_name: name.into(),
            timestamp,
            ..Default::default()
        },
        context,
        allowed,
    )
    .await
}
async fn create(
    io: &mut impl Io,
    collection: &str,
    dimension: i64,
    metadata: bool,
    recreate: bool,
) -> Result<()> {
    if recreate && exists(io, collection).await? {
        let _: Status = call(
            io,
            "DropCollection",
            pb::DropCollectionRequest {
                collection_name: collection.into(),
                ..Default::default()
            },
            Context::Client,
            Missing::None,
        )
        .await?;
    }
    if exists(io, collection).await? {
        return Ok(());
    }
    let _: Status = call(
        io,
        "CreateCollection",
        milvus_writer::create_collection(collection, dimension, metadata),
        Context::Client,
        Missing::None,
    )
    .await?;
    let _: Status = call(
        io,
        "CreateIndex",
        milvus_writer::create_index(collection, metadata),
        Context::Client,
        Missing::None,
    )
    .await?;
    let timestamp: pb::AllocTimestampResponse = call(
        io,
        "AllocTimestamp",
        pb::AllocTimestampRequest::default(),
        Context::Client,
        Missing::None,
    )
    .await?;
    loop {
        io.sleep(Duration::from_millis(500)).await;
        let response = indexes(
            io,
            collection,
            "dense_index",
            timestamp.timestamp,
            Context::Client,
            Missing::None,
        )
        .await?;
        let index = if response.index_descriptions.len() == 1 {
            response.index_descriptions.first()
        } else {
            response
                .index_descriptions
                .iter()
                .find(|i| i.field_name == "vector")
        }
        .ok_or_else(ambiguous_index)?;
        match index.state {
            3 => break,
            4 => return Err(server_error(1, &index.index_state_fail_reason)),
            _ => (),
        }
    }
    let _: Status = call(
        io,
        "LoadCollection",
        pb::LoadCollectionRequest {
            collection_name: collection.into(),
            ..Default::default()
        },
        Context::Client,
        Missing::None,
    )
    .await?;
    loop {
        let progress: pb::GetLoadingProgressResponse = call(
            io,
            "GetLoadingProgress",
            pb::GetLoadingProgressRequest {
                collection_name: collection.into(),
                ..Default::default()
            },
            Context::Client,
            Missing::None,
        )
        .await?;
        if progress.progress >= 100 {
            break;
        }
        io.sleep(Duration::from_millis(200)).await;
    }
    Ok(())
}
async fn indexed_rows(io: &mut impl Io, collection: &str, name: &str) -> Result<i64> {
    let response = indexes(io, collection, name, 0, Context::Client, Missing::Index).await?;
    if response
        .status
        .as_ref()
        .is_some_and(|s| missing(s, Missing::Index))
    {
        bail!("'NoneType' object is not subscriptable");
    }
    if response.index_descriptions.len() != 1 {
        return Err(ambiguous_index());
    }
    Ok(response.index_descriptions[0].indexed_rows)
}
async fn flush(io: &mut impl Io, collection: &str) -> Result<()> {
    let result: pb::FlushResponse = call(
        io,
        "Flush",
        pb::FlushRequest {
            collection_names: vec![collection.into()],
            ..Default::default()
        },
        Context::Client,
        Missing::None,
    )
    .await?;
    let request = pb::GetFlushStateRequest {
        // Protobuf maps return a default entry for an absent key in Python.
        segment_i_ds: result
            .coll_seg_i_ds
            .get(collection)
            .map(|v| v.data.clone())
            .unwrap_or_default(),
        flush_ts: result
            .coll_flush_ts
            .get(collection)
            .copied()
            .unwrap_or_default(),
        collection_name: collection.into(),
        ..Default::default()
    };
    loop {
        let state: pb::GetFlushStateResponse = call(
            io,
            "GetFlushState",
            request.clone(),
            Context::Client,
            Missing::None,
        )
        .await?;
        if state.flushed {
            return Ok(());
        }
        io.sleep(Duration::from_millis(500)).await;
    }
}
async fn wait_for_index(
    io: &mut impl Io,
    collection: &str,
    expected: &[(String, i64)],
) -> Result<()> {
    flush(io, collection).await?;
    for (name, expected) in expected {
        let mut indexed = indexed_rows(io, collection, name).await?;
        while indexed < *expected {
            let initial = ((*expected - indexed) as f64 * 0.005).max(10.);
            let mut remaining = initial;
            for _ in 0..20 {
                let previous = indexed;
                indexed = indexed_rows(io, collection, name).await?;
                io.sleep(Duration::from_secs(1)).await;
                if indexed >= *expected {
                    break;
                }
                remaining = if indexed == previous {
                    remaining - 1.
                } else {
                    initial
                };
                if remaining == 0. {
                    bail!("Rows are not getting indexed as expected for: {name} - {collection}");
                }
            }
        }
    }
    Ok(())
}

pub struct Options<'a> {
    pub collection: &'a str,
    pub dimension: i64,
    pub recreate: bool,
    pub timestamp: &'a str,
    pub model: &'a str,
    pub surrogates: &'a crate::document_json::Surrogates,
}
/// NV-Ingest's `vdb_upload` is a local consumer of the completed NV results. It
/// creates the metadata receipt even when cleanup yields no vectors to insert.
pub async fn upload(io: &mut impl Io, options: &Options<'_>, results: &mut Value) -> Result<()> {
    let collection = options.collection;
    let _: pb::GetVersionResponse = call(
        io,
        "GetVersion",
        pb::GetVersionRequest::default(),
        Context::Connection,
        Missing::None,
    )
    .await?;
    create(io, collection, options.dimension, false, options.recreate).await?;
    if !exists(io, "meta").await? {
        create(io, "meta", 2, true, false).await?;
    }
    let schema = describe(io, "meta", Context::Client, false)
        .await?
        .schema
        .unwrap_or_default();
    let row = milvus_writer::metadata_record(
        collection,
        options.dimension,
        options.timestamp,
        options.model,
    );
    let mutation: pb::MutationResult = call(
        io,
        "Insert",
        milvus_writer::insert("meta", &schema, &[row])?,
        Context::Client,
        Missing::None,
    )
    .await?;
    io.record_mutation("meta", mutation.timestamp);
    drop(mutation);

    let _: pb::GetVersionResponse = call(
        io,
        "GetVersion",
        pb::GetVersionRequest::default(),
        Context::Connection,
        Missing::None,
    )
    .await?;
    // Collection(name).schema in the retained ORM checks existence and then
    // describes its schema using the ORM database, independently of the client.
    describe(io, collection, Context::Orm, false).await?;
    describe(io, collection, Context::Orm, false).await?;
    let rows = document_index::records(results)?;
    if rows.is_empty() {
        return Ok(());
    }
    let listed = indexes(io, collection, "", 0, Context::Orm, Missing::Index).await?;
    let mut expected = Vec::new();
    if !listed
        .status
        .as_ref()
        .is_some_and(|s| missing(s, Missing::Index))
    {
        for index in listed.index_descriptions {
            let old = indexed_rows(io, collection, &index.index_name).await?;
            expected.push((index.index_name, old + rows.len() as i64));
        }
    }
    let schema = describe(io, collection, Context::Client, false)
        .await?
        .schema
        .unwrap_or_default();
    for batch in rows.chunks(5000) {
        let mutation: pb::MutationResult = call(
            io,
            "Insert",
            milvus_writer::insert_with_surrogates(collection, &schema, batch, options.surrogates)?,
            Context::Client,
            Missing::None,
        )
        .await?;
        io.record_mutation(collection, mutation.timestamp);
        drop(mutation);
    }
    wait_for_index(io, collection, &expected).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use std::collections::VecDeque;

    struct Replay {
        calls: VecDeque<Value>,
        completed: usize,
        fail_at: Option<usize>,
        delays: Vec<Duration>,
    }
    impl Replay {
        fn new(case: &Value) -> Self {
            Self {
                // Connections are request-owned by the eventual transport.
                calls: case["calls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|c| c["method"] != "Connect")
                    .cloned()
                    .collect(),
                completed: 0,
                fail_at: None,
                delays: Vec::new(),
            }
        }
    }
    impl Io for Replay {
        async fn exchange<I, O>(
            &mut self,
            method: &'static str,
            input: I,
            context: Context,
        ) -> Result<O>
        where
            I: Message + Default + Clone + Send + Sync + 'static,
            O: Message + Default + Send + Sync + 'static,
        {
            let expected = self
                .calls
                .pop_front()
                .expect("Unexpected extra Milvus call");
            assert_eq!(
                method,
                expected["method"].as_str().unwrap(),
                "at call {}",
                self.completed
            );
            assert_eq!(
                input.encode_to_vec(),
                STANDARD
                    .decode(expected["base64"].as_str().unwrap())
                    .unwrap(),
                "{method}: call {}",
                self.completed
            );
            assert_eq!(
                expected["metadata"]["dbname"],
                match context {
                    Context::Orm => json!("default"),
                    Context::Client => json!(""),
                    Context::Connection => Value::Null,
                },
                "{method}"
            );
            let failed = self.fail_at == Some(self.completed);
            self.completed += 1;
            if failed {
                bail!("Synthetic transport failure");
            }
            Ok(O::decode(
                STANDARD
                    .decode(expected["response_base64"].as_str().unwrap())?
                    .as_slice(),
            )?)
        }
        async fn sleep(&mut self, duration: Duration) {
            self.delays.push(duration);
        }
    }
    fn fixture() -> Value {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-index.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        fixture
    }
    async fn run_case(io: &mut Replay, case: &Value) -> Result<()> {
        dimension_probe(io, "private_collection", 2, "vector").await?;
        upload(
            io,
            &Options {
                collection: "private_collection",
                dimension: 2,
                recreate: case["recreate"].as_bool().unwrap(),
                timestamp: "2026-10-13 12:00:00",
                model: "nvidia/llama-nemotron-embed-1b-v2",
                surrogates: &Default::default(),
            },
            &mut case["records"].clone(),
        )
        .await
    }
    #[tokio::test]
    async fn retained_sdk_lifecycle_matches_wire_payloads_and_order() {
        for case in fixture()["cases"].as_array().unwrap() {
            let mut io = Replay::new(case);
            match run_case(&mut io, case).await {
                Ok(()) => assert!(case["expected"].get("rows").is_some()),
                Err(error) => assert_eq!(
                    error.to_string(),
                    case["expected"]["message"].as_str().unwrap()
                ),
            }
            assert!(io.calls.is_empty(), "{} unconsumed calls", io.calls.len());
            let expected: Vec<f64> = serde_json::from_value(case["delays"].clone()).unwrap();
            assert_eq!(
                io.delays
                    .iter()
                    .map(Duration::as_secs_f64)
                    .collect::<Vec<_>>(),
                expected,
                "{}",
                case["mode"]
            );
        }
    }
    #[tokio::test]
    async fn transport_failure_never_replays_mutations_or_advances_the_writer() {
        for case in fixture()["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["expected"].get("rows").is_some())
        {
            let template = Replay::new(case);
            for (index, call) in template.calls.iter().enumerate() {
                if ![
                    "CreateCollection",
                    "DropCollection",
                    "CreateIndex",
                    "LoadCollection",
                    "Insert",
                    "Flush",
                ]
                .contains(&call["method"].as_str().unwrap())
                {
                    continue;
                }
                let mut io = Replay::new(case);
                io.fail_at = Some(index);
                assert_eq!(
                    run_case(&mut io, case).await.unwrap_err().to_string(),
                    "Synthetic transport failure"
                );
                assert_eq!(io.completed, index + 1, "{}", call["method"]);
            }
        }
    }
}
