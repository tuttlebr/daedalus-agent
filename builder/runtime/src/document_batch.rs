//! Owned batch futures and the ingestion progress contract.
use crate::{
    collections,
    config::truthy,
    document_index::{Failure, Success, Summary, dedup},
};
use anyhow::{Result, anyhow};
use futures::{future::BoxFuture, future::join_all};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

pub type Progress = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<()>> + Send + Sync>;
/// The document runner reports every failure as an outcome; it never raises.
pub type Process =
    Arc<dyn Fn(DocumentRequest, Progress) -> BoxFuture<'static, Outcome> + Send + Sync>;

#[derive(Deserialize)]
pub struct Request {
    #[serde(rename = "documentRefs")]
    pub references: Value,
    pub username: String,
    pub collection_name: Option<String>,
    pub collection_scope: Option<String>,
    pub chunk_size: Option<Value>,
    pub chunk_overlap: Option<Value>,
}
#[derive(Clone, Serialize)]
pub struct DocumentRequest {
    #[serde(skip)]
    pub append_to_collection: bool,
    #[serde(rename = "documentRef")]
    pub reference: Value,
    pub username: String,
    pub collection_name: String,
    pub collection_scope: String,
    pub chunk_size: Option<Value>,
    pub chunk_overlap: Option<Value>,
}
#[derive(Deserialize)]
pub struct Outcome {
    pub status: String,
    pub filename: Value,
    pub chunks: usize,
    pub pages: usize,
    pub failures: usize,
    pub error: String,
}
#[derive(Deserialize)]
#[serde(default)]
pub struct Options {
    pub max_documents_per_batch: i64,
    pub batch_concurrency: i64,
    pub recreate_collection: bool,
    pub default_collection_name: String,
    pub chunk_size: Value,
    pub chunk_overlap: Value,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            max_documents_per_batch: 20,
            batch_concurrency: 1,
            recreate_collection: false,
            default_collection_name: "user_uploads".into(),
            chunk_size: json!(1024),
            chunk_overlap: json!(150),
        }
    }
}

#[derive(Clone)]
struct Reporter {
    callback: Option<Progress>,
    total: usize,
    completed: Arc<AtomicUsize>,
}
impl Reporter {
    async fn emit(&self, current: Value, index: Option<usize>, phase: &str, mut extra: Value) {
        let Some(callback) = &self.callback else {
            return;
        };
        let completed = self.completed.load(Ordering::Relaxed);
        let weight = match phase {
            "fetching" => 0.04,
            "fetched" => 0.08,
            "waiting" => 0.12,
            "preparing" => 0.16,
            "submitting" => 0.24,
            "processing" => 0.42,
            "indexing" => 0.70,
            "postprocessing" => 0.86,
            "postprocessed" => 0.94,
            "retrying" => 0.20,
            _ => 0.0,
        };
        let percent = if self.total == 0 {
            0
        } else if completed >= self.total {
            100
        } else {
            (((completed as f64 + weight) / self.total as f64 * 100.) as usize).min(99)
        };
        let mut event = json!({"completed":completed,"total":self.total,"current":current,"percent":percent,"phase":phase});
        if let Some(index) = index {
            event["currentIndex"] = json!(index);
        }
        if let Some(extra) = extra.as_object_mut() {
            if extra.get("message").is_some_and(|v| !truthy(v)) {
                extra.remove("message");
            }
            event.as_object_mut().unwrap().append(extra);
        }
        if callback(event).await.is_err() {
            // A disconnected progress consumer must not turn a confirmed write
            // into a document failure or cause a retry.
            tracing::warn!("Ingestion progress callback failed; continuing");
        }
    }
    fn document(&self, filename: Value, index: usize) -> Progress {
        let reporter = self.clone();
        Arc::new(move |mut stage| {
            let reporter = reporter.clone();
            let filename = filename.clone();
            Box::pin(async move {
                let current = stage
                    .get("current")
                    .filter(|v| truthy(v))
                    .cloned()
                    .unwrap_or(filename);
                let phase = stage["phase"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("processing")
                    .to_owned();
                if let Some(extra) = stage.as_object_mut() {
                    for key in [
                        "completed",
                        "total",
                        "current",
                        "currentIndex",
                        "percent",
                        "phase",
                    ] {
                        extra.remove(key);
                    }
                }
                reporter.emit(current, Some(index), &phase, stage).await;
                Ok(())
            })
        })
    }
}

fn filename(reference: &Value, index: usize) -> Result<Value> {
    let object = reference.as_object().ok_or_else(|| {
        let kind = match reference {
            Value::Null => "NoneType",
            Value::Array(_) => "list",
            Value::String(_) => "str",
            Value::Bool(_) => "bool",
            _ => "int",
        };
        anyhow!("'{kind}' object has no attribute 'get'")
    })?;
    Ok(object
        .get("filename")
        .or_else(|| object.get("documentId"))
        .cloned()
        .unwrap_or_else(|| json!(format!("Document_{index}"))))
}
fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        _ => value.to_string(),
    }
}
fn short_error(message: &str) -> String {
    if message.chars().count() <= 100 {
        message.into()
    } else {
        format!("{}...", crate::output::clip(message, 100))
    }
}
fn timeout(result: &Outcome) -> bool {
    result.status == "failure" && result.error.to_lowercase().contains("timed out")
}

struct State {
    reporter: Reporter,
    successful: Vec<Success>,
    failed: Vec<Failure>,
    chunks: usize,
    pages: usize,
}
impl State {
    fn update_completed(&self) {
        self.reporter
            .completed
            .store(self.successful.len() + self.failed.len(), Ordering::Relaxed);
    }
    async fn accumulate(&mut self, fallback: Value, index: usize, result: Outcome) {
        let filename = if truthy(&result.filename) {
            result.filename.clone()
        } else {
            fallback
        };
        let name = text(&filename);
        let (phase, extra) = match result {
            result if result.status == "success" || result.status == "partial" => {
                self.chunks += result.chunks;
                self.pages += result.pages;
                let extra = json!({
                    "message":format!("Indexed {name}: {} chunks, {} pages",result.chunks,result.pages),
                    "chunks":result.chunks,"pages":result.pages,"failures":result.failures,
                });
                self.successful.push(Success {
                    id: name,
                    chunks: result.chunks,
                    pages: result.pages,
                });
                ("completed", extra)
            }
            result => {
                let error = result.error;
                let message = format!("Failed {name}: {}", short_error(&error));
                self.failed.push(Failure { id: name, error });
                ("failed", json!({"message":message}))
            }
        };
        self.update_completed();
        self.reporter
            .emit(filename, Some(index), phase, extra)
            .await;
    }
    async fn skip(&mut self, refs: &[Value], start: usize) -> Result<()> {
        for (index, reference) in refs.iter().enumerate().skip(start) {
            self.failed.push(Failure {
                id: text(&filename(reference,index+1)?),
                error: "Skipped because a prior document ingest timed out; NV-Ingest or Milvus may be unavailable.".into(),
            });
        }
        self.update_completed();
        self.reporter.emit(Value::Null,None,"skipped",json!({"message":format!("Skipped {} remaining documents after timeout",refs.len()-start)})).await;
        Ok(())
    }
}

/// Each document future stays owned by its batch. Dropping the batch cancels its
/// queued work; the document processor owns any retained ambiguous write work.
pub async fn run(
    options: &Options,
    request: Request,
    process: Process,
    progress: Option<Progress>,
) -> Result<String> {
    let Some(refs) = request.references.as_array().filter(|r| !r.is_empty()) else {
        return Ok(
            "Error: Invalid document references provided. Expected a list of document references."
                .into(),
        );
    };
    if request.username.is_empty() {
        return Ok("Error: Valid username required for document processing.".into());
    }
    let refs = dedup(refs)?;
    let collection = collections::resolve(
        request.collection_name.as_deref(),
        Some(&request.username),
        Some(&options.default_collection_name),
    );
    let scope = match collections::scope(&collection, request.collection_scope.as_deref(), true) {
        Ok(scope) => scope,
        Err(error) => return Ok(format!("Error: {error}")),
    };
    let total = refs.len();
    // Clamping to the request length preserves unbounded Python capacity
    // values without overflowing Tokio's semaphore limit.
    let concurrency = (options.batch_concurrency.max(1) as usize).min(total.max(1));
    let batch_size = (options.max_documents_per_batch.max(1) as usize).min(total.max(1));
    let sem = Arc::new(Semaphore::new(concurrency));
    let mut state = State {
        reporter: Reporter {
            callback: progress,
            total,
            completed: Arc::new(AtomicUsize::new(0)),
        },
        successful: Vec::new(),
        failed: Vec::new(),
        chunks: 0,
        pages: 0,
    };
    let reporter = state.reporter.clone();
    let one = |index: usize, append_to_collection: bool| {
        let reference = refs[index - 1].clone();
        let reporter = reporter.clone();
        let process = process.clone();
        let sem = sem.clone();
        let request = DocumentRequest {
            append_to_collection,
            reference,
            username: request.username.clone(),
            collection_name: collection.clone(),
            collection_scope: scope.clone(),
            chunk_size: request.chunk_size.clone(),
            chunk_overlap: request.chunk_overlap.clone(),
        };
        async move {
            let filename = filename(&request.reference, index)?;
            reporter
                .emit(
                    filename.clone(),
                    Some(index),
                    "queued",
                    json!({"message":format!("Starting document {index} of {total}")}),
                )
                .await;
            let callback = reporter.document(filename.clone(), index);
            let _permit = sem.acquire().await?;
            let result = process(request, callback).await;
            Ok::<_, anyhow::Error>((index, filename, result))
        }
    };
    state.reporter.emit(Value::Null,None,"queued",json!({"message":format!("Queued {total} document{} for ingestion",if total==1 {""} else {"s"})})).await;
    let mut prefix = 0;
    // A failed document may not have reached the writer. Establish the new
    // collection with a successful serial document before appending in parallel.
    while options.recreate_collection && prefix < total && state.successful.is_empty() {
        prefix += 1;
        let (index, name, outcome) = one(prefix, false).await?;
        let timed_out = timeout(&outcome);
        state.accumulate(name, index, outcome).await;
        if timed_out {
            state.skip(&refs, prefix).await?;
            break;
        }
    }
    let mut skipped = state.successful.len() + state.failed.len() >= total;
    for start in (prefix..total).step_by(batch_size) {
        if skipped {
            break;
        }
        let stop = (start + batch_size).min(total);
        if concurrency == 1 {
            for index in start..stop {
                let (index, name, outcome) = one(index + 1, true).await?;
                let timed_out = timeout(&outcome);
                state.accumulate(name, index, outcome).await;
                if timed_out {
                    state.skip(&refs, index).await?;
                    skipped = true;
                    break;
                }
            }
        } else {
            // Gather a full internal batch before accumulating outcomes, and
            // retain input order even if later documents finish first.
            for result in join_all((start..stop).map(|index| one(index + 1, true))).await {
                let (index, name, outcome) = result?;
                let timed_out = timeout(&outcome);
                state.accumulate(name, index, outcome).await;
                if timed_out && !skipped {
                    state.skip(&refs, stop).await?;
                    skipped = true;
                }
            }
        }
    }
    state
        .reporter
        .emit(
            Value::Null,
            None,
            "finalizing",
            json!({"message":format!("Finalizing ingestion summary for {collection}")}),
        )
        .await;
    let selected = |value: Option<Value>, fallback: &Value| {
        value.filter(truthy).unwrap_or_else(|| fallback.clone())
    };
    Ok(Summary {
        total,
        successful: &state.successful,
        failed: &state.failed,
        chunks: state.chunks,
        pages: state.pages,
        collection: &collection,
        chunk_size: &selected(request.chunk_size, &options.chunk_size),
        chunk_overlap: &request
            .chunk_overlap
            .unwrap_or_else(|| options.chunk_overlap.clone()),
    }
    .render())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, sync::Mutex};

    /// Parallel document phase interleaving depends on the async runtime. Keep
    /// each document's phase order and the complete ordered terminal sequence;
    /// compare every payload without requiring one scheduler's poll order.
    fn progress_contract(events: &[Value]) -> Value {
        let mut terminal = Vec::new();
        let mut documents: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for event in events {
            if event.get("currentIndex").is_none()
                || ["completed", "failed"].contains(&event["phase"].as_str().unwrap())
            {
                terminal.push(event.clone());
            } else {
                documents
                    .entry(event["currentIndex"].to_string())
                    .or_default()
                    .push(event.clone());
            }
        }
        json!({"terminal":terminal,"documents":documents})
    }

    #[tokio::test]
    async fn retained_batch_outcomes_progress_and_concurrency() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/document-batch.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            if case["outcomes"]
                .as_object()
                .is_some_and(|o| o.values().any(|o| o["exception"] == "RuntimeError"))
            {
                // The retained processor could raise arbitrary exceptions, and
                // its batch ignored "timed out" in their text. The native
                // runner returns every failure as an outcome instead.
                continue;
            }
            let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
            let events = Arc::new(Mutex::new(Vec::<Value>::new()));
            let active = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let process: Process = {
                let calls = calls.clone();
                let active = active.clone();
                let peak = peak.clone();
                let case = case.clone();
                Arc::new(move |request, callback| {
                    let calls = calls.clone();
                    let active = active.clone();
                    let peak = peak.clone();
                    let case = case.clone();
                    Box::pin(async move {
                        calls
                            .lock()
                            .unwrap()
                            .push(serde_json::to_value(&request).unwrap());
                        let count = active.fetch_add(1, Ordering::Relaxed) + 1;
                        peak.fetch_max(count, Ordering::Relaxed);
                        let stages = case
                            .get("stages")
                            .cloned()
                            .unwrap_or_else(|| json!([{"phase":"processing"}]));
                        for stage in stages.as_array().unwrap() {
                            callback(stage.clone()).await.unwrap();
                            tokio::task::yield_now().await;
                        }
                        active.fetch_sub(1, Ordering::Relaxed);
                        let outcome = &case["outcomes"]
                            [request.reference["documentId"].as_str().unwrap_or("")];
                        if outcome["exception"] == "TimeoutError" {
                            // The retained processor raised its timeout; the
                            // native runner reports the same failure text.
                            return Outcome {
                                status: "failure".into(),
                                filename: Value::Null,
                                chunks: 0,
                                pages: 0,
                                failures: 0,
                                error: outcome["error"].as_str().unwrap().into(),
                            };
                        }
                        let mut result = json!({
                            "status":"success","filename":request.reference.get("filename").cloned().unwrap_or(json!("")),
                            "chunks":2,"pages":3,"failures":0,"error":"",
                        });
                        if let Some(fields) = outcome.as_object() {
                            result.as_object_mut().unwrap().extend(fields.clone());
                        }
                        serde_json::from_value(result).unwrap()
                    })
                })
            };
            let progress: Progress = {
                let events = events.clone();
                let fail = case["callback_error"].as_bool().unwrap_or(false);
                Arc::new(move |event| {
                    events.lock().unwrap().push(event);
                    Box::pin(async move {
                        if fail {
                            Err(anyhow!("Synthetic callback error"))
                        } else {
                            Ok(())
                        }
                    })
                })
            };
            let options: Options =
                serde_json::from_value(case.get("config").cloned().unwrap_or(json!({}))).unwrap();
            let result = run(
                &options,
                serde_json::from_value(case["request"].clone()).unwrap(),
                process,
                Some(progress),
            )
            .await;
            let mut expected = case["expected"].clone();
            if name == "chunk-overrides" {
                // Correct the frozen baseline's zero-as-default bug; retain
                // every other byte, pipeline argument, and progress event.
                assert_eq!(case["request"]["chunk_overlap"], 0);
                expected["ok"] = json!(
                    expected["ok"]
                        .as_str()
                        .unwrap()
                        .replace("with 150 overlap", "with 0 overlap")
                );
            }
            match result {
                Ok(output) => assert_eq!(json!({"ok":output}), expected, "{name}"),
                Err(error) => assert_eq!(
                    error.to_string(),
                    case["expected"]["message"].as_str().unwrap(),
                    "{name}"
                ),
            }
            // The retained processor accepted request provenance only to log
            // it. The native runner never receives it.
            let mut expected_calls = case["calls"].as_array().unwrap().clone();
            for call in &mut expected_calls {
                call.as_object_mut().unwrap().remove("provenance");
            }
            assert_eq!(*calls.lock().unwrap(), expected_calls, "calls: {name}");
            assert_eq!(
                progress_contract(&events.lock().unwrap()),
                progress_contract(case["events"].as_array().unwrap()),
                "events: {name}"
            );
            if options.batch_concurrency <= 1 {
                assert_eq!(
                    *events.lock().unwrap(),
                    *case["events"].as_array().unwrap(),
                    "sequential order: {name}"
                );
            }
            assert_eq!(
                peak.load(Ordering::Relaxed),
                case["peak"].as_u64().unwrap() as usize,
                "peak: {name}"
            );
            assert_eq!(active.load(Ordering::Relaxed), 0);
        }
    }

    #[tokio::test]
    async fn recreation_preserves_all_successful_documents() {
        for missing_first in [false, true] {
            for concurrency in [1, 3] {
                for batch_size in [1, 3] {
                    let rows = Arc::new(Mutex::new(vec!["old".to_string()]));
                    let writes = Arc::new(Mutex::new(Vec::new()));
                    let process: Process = {
                        let rows = rows.clone();
                        let writes = writes.clone();
                        Arc::new(move |request, _| {
                            let rows = rows.clone();
                            let writes = writes.clone();
                            Box::pin(async move {
                                let name = request.reference["documentId"].as_str().unwrap();
                                if missing_first && name == "a" {
                                    return Outcome {
                                        status: "failure".into(),
                                        filename: json!(name),
                                        chunks: 0,
                                        pages: 0,
                                        failures: 0,
                                        error: "Missing".into(),
                                    };
                                }
                                tokio::task::yield_now().await;
                                let mut rows = rows.lock().unwrap();
                                if !request.append_to_collection {
                                    rows.clear();
                                }
                                rows.push(name.into());
                                writes.lock().unwrap().push(!request.append_to_collection);
                                Outcome {
                                    status: "success".into(),
                                    filename: json!(name),
                                    chunks: 1,
                                    pages: 1,
                                    failures: 0,
                                    error: String::new(),
                                }
                            })
                        })
                    };
                    let request = serde_json::from_value(json!({"documentRefs":[{"documentId":"a"},{"documentId":"b"},{"documentId":"c"}],"username":"alice"})).unwrap();
                    let options = Options {
                        recreate_collection: true,
                        batch_concurrency: concurrency,
                        max_documents_per_batch: batch_size,
                        ..Options::default()
                    };
                    let output = run(&options, request, process, None).await.unwrap();
                    let expected = if missing_first {
                        vec!["b", "c"]
                    } else {
                        vec!["a", "b", "c"]
                    };
                    let mut actual = rows.lock().unwrap().clone();
                    actual.sort();
                    assert_eq!(actual, expected, "{output}");
                    let writes = writes.lock().unwrap();
                    assert!(writes[0]);
                    assert!(writes[1..].iter().all(|recreate| !recreate));
                }
            }
        }
    }

    #[tokio::test]
    async fn cancellation_drops_active_documents_and_never_starts_queued_work() {
        struct Active(Arc<AtomicUsize>);
        impl Drop for Active {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::Relaxed);
            }
        }
        let active = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(AtomicUsize::new(0));
        let process: Process = {
            let active = active.clone();
            let started = started.clone();
            Arc::new(move |_, _| {
                let active = active.clone();
                let started = started.clone();
                Box::pin(async move {
                    let _active = Active(active.clone());
                    active.fetch_add(1, Ordering::Relaxed);
                    started.fetch_add(1, Ordering::Relaxed);
                    std::future::pending::<()>().await;
                    unreachable!()
                })
            })
        };
        let request = serde_json::from_value(json!({"documentRefs":[{"documentId":"a"},{"documentId":"b"},{"documentId":"c"}],"username":"alice"})).unwrap();
        let options = Options {
            batch_concurrency: 2,
            ..Options::default()
        };
        let batch = run(&options, request, process, None);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), batch)
                .await
                .is_err()
        );
        assert_eq!(started.load(Ordering::Relaxed), 2);
        assert_eq!(active.load(Ordering::Relaxed), 0);
    }
}
