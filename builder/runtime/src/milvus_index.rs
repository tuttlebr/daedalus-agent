//! Milvus indexing lifecycle. Every mutation is awaited; this layer never
//! replays an RPC after a transport failure.
use crate::{document_index, milvus_index_proto as pb, milvus_proto::Status, milvus_writer};
use anyhow::{Result, anyhow, bail};
use prost::Message;
use serde_json::{Value, json};
use std::{future::Future, sync::Arc, time::Duration};

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
    Load,
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
        Missing::Load => status.code == 101 || status.reason.contains("not loaded"),
    }
}
// These waits run while the write owns its collection. Each polls Milvus until
// it reports progress, and fails once that many consecutive polls show none,
// so a stalled server releases the collection instead of holding it forever.
const INDEX_STALL_POLLS: usize = 600; // 500 ms apart: five minutes
const LOAD_STALL_POLLS: usize = 600; // 200 ms apart: two minutes
const FLUSH_POLLS: usize = 600; // 500 ms apart: five minutes
/// A non-transport failure after this upload's row inserts were acknowledged.
/// Those rows remain in Milvus, so the document runner must not replay the
/// pipeline: it would insert them again. The message is the underlying error's.
#[derive(Debug)]
pub struct CommittedWrite(Box<dyn std::error::Error + Send + Sync + 'static>);
impl CommittedWrite {
    pub fn new(error: anyhow::Error) -> Self {
        Self(error.into())
    }
}
impl std::fmt::Display for CommittedWrite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for CommittedWrite {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.source()
    }
}
/// gRPC failures already carry their own no-replay classification; keep that
/// type directly downcastable for the runner.
fn after_commit(committed: bool, error: anyhow::Error) -> anyhow::Error {
    if !committed
        || error
            .downcast_ref::<crate::milvus_index_transport::TransportFailure>()
            .is_some()
    {
        return error;
    }
    CommittedWrite::new(error).into()
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
        return repair(io, collection, metadata).await;
    }
    let _: Status = call(
        io,
        "CreateCollection",
        milvus_writer::create_collection(collection, dimension, metadata),
        Context::Client,
        Missing::None,
    )
    .await?;
    build_index(io, collection, metadata).await?;
    load(io, collection).await
}
/// A failure between CreateCollection and the end of loading leaves a
/// collection without its index or unloaded. Existence alone is not
/// readiness: uploads would succeed while searches fail. Complete whichever
/// step is missing.
async fn repair(io: &mut impl Io, collection: &str, metadata: bool) -> Result<()> {
    // Any vector index serves: a collection created elsewhere may name its
    // index differently, and Milvus allows only one index per field.
    let listed = indexes(io, collection, "", 0, Context::Client, Missing::Index).await?;
    let indexed = !listed
        .status
        .as_ref()
        .is_some_and(|status| missing(status, Missing::Index))
        && listed
            .index_descriptions
            .iter()
            .any(|index| index.field_name == "vector");
    if !indexed {
        build_index(io, collection, metadata).await?;
    }
    let progress = loading(io, collection, Missing::Load).await?;
    // Loading an already loading collection is idempotent. Some servers
    // report an unloaded collection as zero progress rather than an error.
    if progress.progress == 0
        || progress
            .status
            .as_ref()
            .is_some_and(|status| missing(status, Missing::Load))
    {
        return load(io, collection).await;
    }
    if progress.progress < 100 {
        return loaded(io, collection).await;
    }
    Ok(())
}
async fn build_index(io: &mut impl Io, collection: &str, metadata: bool) -> Result<()> {
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
    let mut observed = None;
    let mut stalled = 0;
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
            3 => return Ok(()),
            4 => return Err(server_error(1, &index.index_state_fail_reason)),
            _ => (),
        }
        let current = Some((index.state, index.indexed_rows, index.pending_index_rows));
        stalled = if current == observed { stalled + 1 } else { 0 };
        observed = current;
        if stalled >= INDEX_STALL_POLLS {
            bail!("Index is not getting built as expected for: dense_index - {collection}");
        }
    }
}
async fn loading(
    io: &mut impl Io,
    collection: &str,
    allowed: Missing,
) -> Result<pb::GetLoadingProgressResponse> {
    call(
        io,
        "GetLoadingProgress",
        pb::GetLoadingProgressRequest {
            collection_name: collection.into(),
            ..Default::default()
        },
        Context::Client,
        allowed,
    )
    .await
}
async fn load(io: &mut impl Io, collection: &str) -> Result<()> {
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
    loaded(io, collection).await
}
async fn loaded(io: &mut impl Io, collection: &str) -> Result<()> {
    let mut best = i64::MIN;
    let mut stalled = 0;
    loop {
        let progress = loading(io, collection, Missing::None).await?;
        if progress.progress >= 100 {
            return Ok(());
        }
        if progress.progress > best {
            best = progress.progress;
            stalled = 0;
        } else {
            stalled += 1;
            if stalled >= LOAD_STALL_POLLS {
                bail!("Collection is not getting loaded as expected: {collection}");
            }
        }
        io.sleep(Duration::from_millis(200)).await;
    }
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
    for _ in 0..FLUSH_POLLS {
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
    bail!("Collection is not getting flushed as expected: {collection}")
}
async fn wait_for_index(
    io: &mut impl Io,
    collection: &str,
    expected: &[(String, i64)],
) -> Result<()> {
    flush(io, collection).await?;
    for (name, expected) in expected {
        let mut indexed = indexed_rows(io, collection, name).await?;
        // NV-Ingest allows max(0.5% of the missing rows, 10) polls without
        // progress. Its budget restarts every 20 polls and only ends at exactly
        // zero, so a stalled index with a fractional budget or more than 4,000
        // missing rows was polled forever while this write owned the collection.
        // Carry an unchanged budget across rounds and stop once it is spent.
        let mut remaining = f64::INFINITY;
        while indexed < *expected {
            let initial = ((*expected - indexed) as f64 * 0.005).max(10.);
            remaining = remaining.min(initial);
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
                if remaining <= 0. {
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
// Row conversion and protobuf packing are CPU-bound: roughly 0.3 s per thousand
// 2048-dimension chunks in an optimized build. Run them on the blocking pool so
// a large upload does not stall async workers that also stream chat responses.
// Neither closure performs I/O, and each result is awaited in the SDK's order.
async fn records_off_runtime(results: &mut Value) -> Result<Vec<Value>> {
    let mut owned = std::mem::take(results);
    let (owned, rows) = tokio::task::spawn_blocking(move || {
        // The SDK's content_metadata mutations are kept even on failure.
        let rows = document_index::records(&mut owned);
        (owned, rows)
    })
    .await?;
    *results = owned;
    rows
}
async fn insert_off_runtime(
    collection: &str,
    schema: &Arc<pb::CollectionSchema>,
    rows: &Arc<Vec<Value>>,
    batch: std::ops::Range<usize>,
    surrogates: &crate::document_json::Surrogates,
) -> Result<pb::InsertRequest> {
    let (collection, schema, rows, surrogates) = (
        collection.to_owned(),
        schema.clone(),
        rows.clone(),
        surrogates.clone(),
    );
    tokio::task::spawn_blocking(move || {
        milvus_writer::insert_with_surrogates(&collection, &schema, &rows[batch], &surrogates)
    })
    .await?
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
    let rows = records_off_runtime(results).await?;
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
    let schema = Arc::new(
        describe(io, collection, Context::Client, false)
            .await?
            .schema
            .unwrap_or_default(),
    );
    let rows = Arc::new(rows);
    let mut committed = false;
    for start in (0..rows.len()).step_by(5000) {
        let batch = start..rows.len().min(start + 5000);
        let request = insert_off_runtime(collection, &schema, &rows, batch, options.surrogates)
            .await
            .map_err(|error| after_commit(committed, error))?;
        let mutation: pb::MutationResult =
            call(io, "Insert", request, Context::Client, Missing::None)
                .await
                .map_err(|error| after_commit(committed, error))?;
        io.record_mutation(collection, mutation.timestamp);
        drop(mutation);
        committed = true;
    }
    wait_for_index(io, collection, &expected)
        .await
        .map_err(|error| after_commit(committed, error))
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
        grpc: bool,
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
                grpc: false,
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
            if failed && self.grpc {
                return Err(crate::milvus_index_transport::TransportFailure {
                    method,
                    code: tonic::Code::Unavailable,
                }
                .into());
            }
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

    #[tokio::test]
    async fn failures_after_committed_rows_are_marked_without_changing_messages() {
        // Row inserts are acknowledged before Flush/index waits. A later
        // explicit rejection must not let the document runner replay them.
        for case in fixture()["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["expected"].get("rows").is_none())
        {
            let mut io = Replay::new(case);
            let error = run_case(&mut io, case).await.unwrap_err();
            assert_eq!(error.to_string(), case["expected"]["message"]);
            // The ambiguous-index case fails while counting indexes before any
            // row insert, so the runner may still retry it.
            let committed =
                ["reject-Flush", "stalled-index"].contains(&case["mode"].as_str().unwrap());
            assert_eq!(
                error.downcast_ref::<CommittedWrite>().is_some(),
                committed,
                "{}",
                case["mode"]
            );
        }
        // A gRPC failure keeps its own no-replay classification unchanged.
        let case = fixture()["cases"][0].clone();
        let flush = Replay::new(&case)
            .calls
            .iter()
            .position(|c| c["method"] == "Flush")
            .unwrap();
        let mut io = Replay::new(&case);
        io.fail_at = Some(flush);
        io.grpc = true;
        let error = run_case(&mut io, &case).await.unwrap_err();
        assert!(
            error
                .downcast_ref::<crate::milvus_index_transport::TransportFailure>()
                .is_some()
        );
        assert!(error.downcast_ref::<CommittedWrite>().is_none());
    }

    struct Stalled {
        indexed: i64,
        polls: usize,
        sleeps: usize,
    }
    impl Io for Stalled {
        async fn exchange<I, O>(
            &mut self,
            method: &'static str,
            _input: I,
            _context: Context,
        ) -> Result<O>
        where
            I: Message + Default + Clone + Send + Sync + 'static,
            O: Message + Default + Send + Sync + 'static,
        {
            let reply = match method {
                "Flush" => pb::FlushResponse::default().encode_to_vec(),
                "GetFlushState" => pb::GetFlushStateResponse {
                    flushed: true,
                    ..Default::default()
                }
                .encode_to_vec(),
                "DescribeIndex" => {
                    self.polls += 1;
                    assert!(self.polls <= 1000, "stalled index wait did not terminate");
                    pb::DescribeIndexResponse {
                        index_descriptions: vec![pb::IndexDescription {
                            index_name: "dense_index".into(),
                            indexed_rows: self.indexed,
                            ..Default::default()
                        }],
                        ..Default::default()
                    }
                    .encode_to_vec()
                }
                _ => panic!("Unexpected Milvus call {method}"),
            };
            Ok(O::decode(reply.as_slice())?)
        }
        async fn sleep(&mut self, duration: Duration) {
            assert_eq!(duration, Duration::from_secs(1));
            self.sleeps += 1;
        }
    }

    #[tokio::test]
    async fn stalled_index_wait_honours_its_no_progress_budget() {
        // NV-Ingest allows max(0.5% of the missing rows, 10) polls without
        // progress. Fractional budgets and budgets above its 20-poll round
        // previously never reached exactly zero, so the owned write (and its
        // collection lock) waited forever on a stalled index.
        for (missing, stalled_polls) in [(10, 10), (2001, 11), (5000, 25), (100_000, 500)] {
            let mut io = Stalled {
                indexed: 7,
                polls: 0,
                sleeps: 0,
            };
            let error = wait_for_index(
                &mut io,
                "private_collection",
                &[("dense_index".into(), 7 + missing)],
            )
            .await
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Rows are not getting indexed as expected for: dense_index - private_collection"
            );
            assert_eq!(io.polls, stalled_polls + 1, "{missing}");
            assert_eq!(io.sleeps, stalled_polls, "{missing}");
        }
    }

    /// Answers each RPC from a closure and records the sequence of methods.
    struct Scripted<F> {
        respond: F,
        calls: Vec<&'static str>,
        sleeps: usize,
    }
    impl<F: FnMut(&'static str) -> Vec<u8> + Send> Scripted<F> {
        fn new(respond: F) -> Self {
            Self {
                respond,
                calls: Vec::new(),
                sleeps: 0,
            }
        }
    }
    impl<F: FnMut(&'static str) -> Vec<u8> + Send> Io for Scripted<F> {
        async fn exchange<I, O>(
            &mut self,
            method: &'static str,
            _input: I,
            _context: Context,
        ) -> Result<O>
        where
            I: Message + Default + Clone + Send + Sync + 'static,
            O: Message + Default + Send + Sync + 'static,
        {
            self.calls.push(method);
            assert!(self.calls.len() < 5000, "wait did not terminate");
            Ok(O::decode((self.respond)(method).as_slice())?)
        }
        async fn sleep(&mut self, _duration: Duration) {
            self.sleeps += 1;
        }
    }
    fn failed(code: i32) -> Status {
        Status {
            code,
            reason: "Synthetic status".into(),
            ..Default::default()
        }
    }
    fn index(state: i32) -> Vec<u8> {
        pb::DescribeIndexResponse {
            status: Some(Status::default()),
            index_descriptions: vec![pb::IndexDescription {
                index_name: "dense_index".into(),
                field_name: "vector".into(),
                state,
                ..Default::default()
            }],
        }
        .encode_to_vec()
    }
    fn progress(status: Status, progress: i64) -> Vec<u8> {
        pb::GetLoadingProgressResponse {
            status: Some(status),
            progress,
            ..Default::default()
        }
        .encode_to_vec()
    }

    #[tokio::test]
    async fn half_created_collections_are_indexed_and_loaded_before_use() {
        // (index exists, first loading answer) -> calls after the existence check
        let cases = [
            (
                false,
                progress(failed(101), 0),
                vec![
                    "DescribeIndex",
                    "CreateIndex",
                    "AllocTimestamp",
                    "DescribeIndex",
                    "GetLoadingProgress",
                    "LoadCollection",
                    "GetLoadingProgress",
                ],
            ),
            (
                true,
                progress(Status::default(), 0),
                vec![
                    "DescribeIndex",
                    "GetLoadingProgress",
                    "LoadCollection",
                    "GetLoadingProgress",
                ],
            ),
            (
                true,
                progress(Status::default(), 100),
                vec!["DescribeIndex", "GetLoadingProgress"],
            ),
        ];
        for (indexed, first_progress, expected) in cases {
            let mut built = indexed;
            let mut loads = 0;
            let mut io = Scripted::new(|method| match method {
                "DescribeCollection" => pb::DescribeCollectionResponse::default().encode_to_vec(),
                "DescribeIndex" if !built => pb::DescribeIndexResponse {
                    status: Some(failed(700)),
                    ..Default::default()
                }
                .encode_to_vec(),
                "DescribeIndex" => index(3),
                "CreateIndex" => {
                    built = true;
                    Status::default().encode_to_vec()
                }
                "AllocTimestamp" | "LoadCollection" => Vec::new(),
                "GetLoadingProgress" => {
                    loads += 1;
                    if loads == 1 {
                        first_progress.clone()
                    } else {
                        progress(Status::default(), 100)
                    }
                }
                method => panic!("Unexpected Milvus call {method}"),
            });
            create(&mut io, "private_collection", 2, false, false)
                .await
                .unwrap();
            assert_eq!(io.calls[0], "DescribeCollection");
            assert_eq!(io.calls[1..], expected, "indexed={indexed}");
        }
    }

    #[tokio::test]
    async fn stalled_index_load_and_flush_waits_release_the_collection() {
        let new_collection = |method| match method {
            "DescribeCollection" => pb::DescribeCollectionResponse {
                status: Some(failed(100)),
                ..Default::default()
            }
            .encode_to_vec(),
            "CreateCollection" | "CreateIndex" | "AllocTimestamp" | "LoadCollection" => Vec::new(),
            method => panic!("Unexpected Milvus call {method}"),
        };
        let mut io = Scripted::new(|method| match method {
            "DescribeIndex" => index(2),
            method => new_collection(method),
        });
        let error = create(&mut io, "private_collection", 2, false, false)
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Index is not getting built as expected for: dense_index - private_collection"
        );
        assert_eq!(io.sleeps, INDEX_STALL_POLLS + 1);
        let mut io = Scripted::new(|method| match method {
            "DescribeIndex" => index(3),
            "GetLoadingProgress" => progress(Status::default(), 50),
            method => new_collection(method),
        });
        let error = create(&mut io, "private_collection", 2, false, false)
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Collection is not getting loaded as expected: private_collection"
        );
        let polls = io
            .calls
            .iter()
            .filter(|m| **m == "GetLoadingProgress")
            .count();
        assert_eq!(polls, LOAD_STALL_POLLS + 1);
        let mut io = Scripted::new(|method| match method {
            "Flush" => pb::FlushResponse::default().encode_to_vec(),
            "GetFlushState" => pb::GetFlushStateResponse::default().encode_to_vec(),
            method => panic!("Unexpected Milvus call {method}"),
        });
        let error = flush(&mut io, "private_collection").await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Collection is not getting flushed as expected: private_collection"
        );
        assert_eq!(io.sleeps, FLUSH_POLLS);
    }
}
