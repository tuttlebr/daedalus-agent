//! Concrete NV-Ingest and Milvus composition for the owned document runner.
use crate::{
    config::Config,
    document_encoding, document_index,
    document_process::{self, Build, Ingested, Stages},
    document_processor, milvus_index,
    milvus_index_transport::Connection,
    nv_ingest,
};
use anyhow::{Result, anyhow};
use base64::Engine as _;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Clone)]
pub struct Engine {
    config: Config,
    options: Arc<nv_ingest::Options>,
    client: nv_ingest::Client,
    dimension: i64,
    recreate: bool,
    bucket: String,
    timestamp: fn() -> String,
}
fn timestamp() -> String {
    let now = chrono::Local::now();
    let mut value = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let micros = now.timestamp_subsec_micros();
    if micros != 0 {
        value.push_str(&format!(".{micros:06}"));
    }
    value
}
impl Engine {
    pub fn new(
        config: &Config,
        options: Arc<nv_ingest::Options>,
        client: nv_ingest::Client,
        recreate: bool,
        bucket: String,
    ) -> Result<Self> {
        Ok(Self {
            config: config.clone(),
            options,
            client,
            dimension: document_processor::integer(config, "EMBEDDING_DENSE_DIM", 2048)?,
            recreate,
            bucket,
            timestamp,
        })
    }
    pub(super) fn indexing_tasks(
        &self,
        job: &mut Value,
        chunk_size: &Value,
        chunk_overlap: &Value,
    ) -> Result<()> {
        document_index::indexing_tasks(
            job,
            &self.config.variable("TOKENIZER", "meta-llama/Llama-3.2-1B"),
            chunk_size,
            chunk_overlap,
        )?;
        // The local SDK Milvus operator validates the bucket even though its
        // streaming path doesn't upload assets. Preserve that pre-submit error.
        let bucket = self.config.variable("MINIO_BUCKET", "nv-ingest");
        if self.bucket != bucket {
            let args = crate::profile_import::identifier(&json!([
                "You must use the environment variable MINIO_BUCKET to specify bucket_name, detected:",
                format!("`bucket_name`: {} and MINIO_BUCKET: {bucket}", self.bucket),
            ]));
            return Err(anyhow!("({})", &args[1..args.len() - 1]));
        }
        Ok(())
    }
}
pub struct Pipeline {
    engine: Engine,
    collection: String,
    body: bytes::Bytes,
}
impl document_process::Engine for Engine {
    type Pipeline = Pipeline;
    async fn build(&self, input: Build) -> Result<Pipeline> {
        // Decoded text retains UCS-4 code points (UTF-7 may yield isolated
        // surrogates). Base64 is ASCII, so it stays a String: as code points it
        // would occupy four bytes per character, over 1 GiB for a 200 MB file.
        enum Content {
            Points(Vec<u32>),
            Ascii(String),
        }
        let options = self.options.clone();
        let source = input.filename.clone();
        let (mut job, content) = tokio::task::spawn_blocking(move || {
            let kind = nv_ingest::document_type(&source)?;
            let content = if ["text", "html"].contains(&kind.as_str()) {
                Content::Points(
                    document_encoding::read_text(&input.bytes)
                        .map_err(|_| anyhow!("Failed to extract content from buffer {source}"))?,
                )
            } else {
                Content::Ascii(base64::engine::general_purpose::STANDARD.encode(input.bytes))
            };
            Ok::<_, anyhow::Error>((nv_ingest::job(&source, "", &options)?, content))
        })
        .await??;
        let connection = Connection::from_config(&self.config);
        // The retained dimension preflight fails open on an unavailable read
        // connection, but a confirmed mismatch prevents submitting the NV job.
        if let Ok(mut probe) = connection.connect(&self.config, false).await {
            milvus_index::dimension_probe(
                &mut probe,
                &input.collection_name,
                self.dimension,
                "vector",
            )
            .await?;
        }
        self.indexing_tasks(&mut job, &input.chunk_size, &input.chunk_overlap)?;
        let body = nv_ingest::blocking(move || {
            let job = match content {
                Content::Points(points) => nv_ingest::payload(&job, &points),
                Content::Ascii(text) => nv_ingest::payload(&job, text.bytes().map(u32::from)),
            };
            nv_ingest::submission(&job)
        })
        .await;
        Ok(Pipeline {
            engine: self.clone(),
            collection: input.collection_name,
            body,
        })
    }
}
impl document_process::Pipeline for Pipeline {
    async fn ingest(self, progress: Stages) -> Result<Ingested> {
        let engine = self.engine;
        let mut ingested = engine.client.ingest_submission(self.body).await;
        progress
            .emit(
                "indexing",
                "NV-Ingest extraction finished; writing chunks to Milvus",
                json!({}),
            )
            .await;
        if ingested.upload {
            let connection = Connection::from_config(&engine.config);
            let mut writer = connection.connect(&engine.config, true).await?;
            // A failure after acknowledged rows is a CommittedWrite, which the
            // document runner never replays.
            milvus_index::upload(
                &mut writer,
                &milvus_index::Options {
                    collection: &self.collection,
                    dimension: engine.dimension,
                    recreate: engine.recreate,
                    timestamp: &(engine.timestamp)(),
                    model: &engine.config.variable(
                        "EMBEDDING_NIM_MODEL_NAME",
                        "nvidia/llama-nemotron-embed-1b-v2",
                    ),
                    surrogates: &ingested.extraction.surrogates,
                },
                &mut ingested.extraction.results,
            )
            .await?;
        }
        Ok(Ingested {
            results: ingested.extraction.results,
            failures: ingested.failures,
            surrogates: ingested.extraction.surrogates,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        document_process::{Engine as _, Pipeline as _, Services as _},
        milvus_index_transport::tests::{configured, script},
    };
    use axum::{
        Router,
        body::Bytes,
        extract::State,
        http::{Method, Uri},
        response::IntoResponse,
        routing::any,
    };
    use serde_json::Value;
    use std::{sync::Mutex, time::Duration};

    struct Peer {
        envelope: Value,
        calls: Vec<Value>,
        raw: Option<String>,
    }
    async fn nv_peer(
        State(state): State<Arc<Mutex<Peer>>>,
        method: Method,
        uri: Uri,
        bytes: Bytes,
    ) -> axum::response::Response {
        let mut state = state.lock().unwrap();
        let payload = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice::<Value>(&bytes).unwrap()
        };
        state
            .calls
            .push(json!({"method":method.as_str(),"path":uri.path(),"body":payload}));
        if method == Method::POST {
            axum::Json(json!("synthetic-job")).into_response()
        } else if let Some(raw) = &state.raw {
            raw.clone().into_response()
        } else {
            axum::Json(state.envelope.clone()).into_response()
        }
    }
    async fn reset(http: &reqwest::Client, control: &str, uri: &str, script: Value) {
        http.post(format!("{control}/reset"))
            .json(&json!({"script":script,"uri":uri}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    async fn consumed(http: &reqwest::Client, control: &str) {
        let state: Value = http
            .get(format!("{control}/script"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(state, json!({"remaining":0,"errors":[]}));
    }
    fn input() -> Build {
        Build {
            bytes: b"Synthetic".to_vec(),
            filename: "fixture.txt".into(),
            collection_name: "private_collection".into(),
            chunk_size: json!(1024),
            chunk_overlap: json!(150),
        }
    }

    /// Replays the frozen SDK responses, in order, to the native writer.
    struct Script(std::collections::VecDeque<Value>);
    impl milvus_index::Io for Script {
        async fn exchange<I, O>(
            &mut self,
            method: &'static str,
            _input: I,
            _context: milvus_index::Context,
        ) -> Result<O>
        where
            I: prost::Message + Default + Clone + Send + Sync + 'static,
            O: prost::Message + Default + Send + Sync + 'static,
        {
            let call = self.0.pop_front().expect("Unexpected extra Milvus call");
            assert_eq!(method, call["method"].as_str().unwrap());
            let bytes = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                call["response_base64"].as_str().unwrap(),
            )?;
            Ok(O::decode(bytes.as_slice())?)
        }
        async fn sleep(&mut self, _duration: Duration) {}
    }
    #[derive(Clone)]
    struct Runner {
        config: Config,
        case: Value,
        attempts: Arc<Mutex<usize>>,
    }
    impl document_process::Services for Runner {
        type Engine = Self;
        fn config(&self) -> &Config {
            &self.config
        }
        async fn fetch(
            &self,
            _key: &str,
        ) -> std::result::Result<Option<Vec<u8>>, document_process::FetchError> {
            Ok(Some(
                json!({"userId":"alice","filename":"fixture.txt","data":"U3ludGhldGlj"})
                    .to_string()
                    .into_bytes(),
            ))
        }
        async fn initialize(&self) -> Result<Self> {
            Ok(self.clone())
        }
    }
    impl document_process::Engine for Runner {
        type Pipeline = Self;
        async fn build(&self, _input: Build) -> Result<Self> {
            Ok(self.clone())
        }
    }
    impl document_process::Pipeline for Runner {
        async fn ingest(self, _progress: Stages) -> Result<Ingested> {
            *self.attempts.lock().unwrap() += 1;
            let mut io = Script(
                self.case["calls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|c| c["method"] != "Connect")
                    .cloned()
                    .collect(),
            );
            milvus_index::dimension_probe(&mut io, "private_collection", 2, "vector").await?;
            let mut results = self.case["records"].clone();
            milvus_index::upload(
                &mut io,
                &milvus_index::Options {
                    collection: "private_collection",
                    dimension: 2,
                    recreate: self.case["recreate"].as_bool().unwrap(),
                    timestamp: "2026-10-13 12:00:00",
                    model: "nvidia/llama-nemotron-embed-1b-v2",
                    surrogates: &Default::default(),
                },
                &mut results,
            )
            .await?;
            assert!(io.0.is_empty());
            Ok(Ingested {
                results,
                failures: 0,
                surrogates: Default::default(),
            })
        }
    }

    #[tokio::test]
    async fn confirmed_rows_are_never_replayed_by_the_document_runner() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-index.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        // Rows confirmed, then flush rejection or a stalled index: one attempt.
        // Earlier rejections leave no document rows and keep the SDK retries.
        for (mode, attempts) in [
            ("stalled-index", 1),
            ("reject-Flush", 1),
            ("reject-Insert:private_collection", 3),
            ("reject-Insert:meta", 3),
            ("reject-CreateCollection", 3),
            ("rate-limit-exhausted", 3),
        ] {
            let case = fixture["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["mode"] == mode)
                .unwrap();
            let runner = Runner {
                config: Config {
                    raw: json!({}),
                    policy_raw: json!({}),
                    env: Default::default(),
                    python_tools: false,
                },
                case: case.clone(),
                attempts: Arc::new(Mutex::new(0)),
            };
            let outcome = document_process::run(
                &runner,
                &crate::document_ownership::Collections::default(),
                &document_process::Options {
                    ingest_retry_delay: 0.,
                    ..Default::default()
                },
                serde_json::from_value(json!({"documentRef":{"documentId":"document","sessionId":"session"},"username":"alice"})).unwrap(),
                None,
            )
            .await;
            assert_eq!(outcome.status, "failure", "{mode}");
            assert_eq!(
                outcome.error,
                format!(
                    "Error processing document with NvIngest: {}",
                    case["expected"]["message"].as_str().unwrap()
                ),
                "{mode}"
            );
            assert_eq!(*runner.attempts.lock().unwrap(), attempts, "{mode}");
        }
    }

    #[tokio::test]
    #[ignore = "requires retained processor and TLS/ACL RedisJSON; run document_runner_check.py"]
    async fn actual_stored_document_runner() {
        use crate::document_process::{FetchError, Options, Services};
        struct Clocked(document_processor::Processor);
        impl Services for Clocked {
            type Engine = Engine;
            fn config(&self) -> &Config {
                self.0.config()
            }
            async fn fetch(&self, key: &str) -> std::result::Result<Option<Vec<u8>>, FetchError> {
                self.0.fetch(key).await
            }
            async fn initialize(&self) -> Result<Engine> {
                let mut engine = self.0.initialize().await?;
                engine.timestamp = || "2026-10-13 12:00:00".into();
                Ok(engine)
            }
        }
        let fixture: Value = serde_json::from_slice(
            &std::fs::read(std::env::var("DAEDALUS_DOCUMENT_RUNNER_FIXTURE").unwrap()).unwrap(),
        )
        .unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let control = fixture["control"].as_str().unwrap();
        let nv = fixture["nv_control"].as_str().unwrap();
        let mut failures = Vec::new();
        for case in fixture["cases"].as_array().unwrap() {
            http.post(format!("{control}/reset"))
                .json(&case["settings"])
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            http.post(format!("{nv}/__runner/reset"))
                .json(case)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let config = Config {
                raw: json!({}),
                policy_raw: json!({}),
                python_tools: false,
                env: serde_json::from_value(case["environment"].clone()).unwrap(),
            };
            let processor = if let Some(raw) = case.get("tool_config") {
                let settings = crate::document_tools::Settings::new(raw, &config.env).unwrap();
                document_processor::Processor::for_tool(&config, &settings).unwrap()
            } else {
                document_processor::Processor::new(&config).unwrap()
            };
            let services = Clocked(processor);
            let events = Arc::new(Mutex::new(Vec::new()));
            let callback = {
                let events = events.clone();
                Arc::new(move |event| {
                    let events = events.clone();
                    Box::pin(async move {
                        events.lock().unwrap().push(event);
                        Ok(())
                    }) as futures::future::BoxFuture<'static, Result<()>>
                })
            };
            let result = document_process::run(
                &services,
                &crate::document_ownership::Collections::default(),
                &Options {
                    ingest_max_retries: 0,
                    ingest_retry_delay: 0.,
                    ingest_timeout_seconds: 30.,
                    ..Default::default()
                },
                serde_json::from_value(case["request"].clone()).unwrap(),
                Some(callback),
            )
            .await;
            let calls: Value = http
                .get(format!("{nv}/__runner/calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let actual = json!({"result":result,"events":events.lock().unwrap().clone(),"nv_calls":calls["nv_calls"],"object_calls":calls["object_calls"]});
            if actual != case["expected"] {
                failures.push(format!(
                    "{}: actual {actual}\nexpected {}",
                    case["name"], case["expected"]
                ));
            }
            let state: Value = http
                .get(format!("{control}/script"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                state,
                json!({"remaining":0,"errors":[]}),
                "{}: {actual}",
                case["name"]
            );
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[tokio::test]
    #[ignore = "requires the disposable retained-SDK gRPC peer; run index_transport_check.py"]
    async fn actual_nv_and_milvus_pipeline() {
        let control = std::env::var("DAEDALUS_INDEX_PEER_CONTROL").unwrap();
        let uri = std::env::var("DAEDALUS_INDEX_PEER_URI").unwrap();
        let selection = std::env::var("DAEDALUS_INDEX_PEER_CASES").unwrap_or_else(|_| "all".into());
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-index.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        let peer = Arc::new(Mutex::new(Peer {
            envelope: Value::Null,
            calls: Vec::new(),
            raw: None,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", any(nv_peer))
                    .with_state(peer.clone()),
            )
            .into_future(),
        );
        let mut config = configured(&uri);
        config.env.extend([
            ("NV_INGEST_HOST".into(), "127.0.0.1".into()),
            ("NV_INGEST_PORT".into(), port.to_string()),
            ("EMBEDDING_DENSE_DIM".into(), "2".into()),
        ]);
        let processor = document_processor::Processor::new(&config).unwrap();
        let mut engine = processor.initialize().await.unwrap();
        engine.timestamp = || "2026-10-13 12:00:00".into();
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            if case["mode"] == "rate-limit-exhausted"
                || (selection != "all" && selection != index.to_string())
            {
                continue;
            }
            reset(&http, &control, &uri, script(case)).await;
            engine.recreate = case["recreate"].as_bool().unwrap();
            {
                let mut peer = peer.lock().unwrap();
                peer.calls.clear();
                peer.envelope = json!({"status":"success","data":case["records"].as_array().unwrap().first().cloned().unwrap_or(json!([]))});
            }
            let events = Arc::new(Mutex::new(Vec::new()));
            let callback = {
                let events = events.clone();
                Arc::new(move |event| {
                    let events = events.clone();
                    Box::pin(async move {
                        events.lock().unwrap().push(event);
                        Ok(())
                    }) as futures::future::BoxFuture<'static, Result<()>>
                })
            };
            let result = tokio::time::timeout(Duration::from_secs(30), async {
                engine
                    .build(input())
                    .await?
                    .ingest(Stages::worker(json!("fixture.txt"), Some(callback)))
                    .await
            })
            .await
            .unwrap();
            match result {
                Ok(output) => {
                    assert!(case["expected"].get("rows").is_some(), "{}", case["mode"]);
                    assert_eq!(output.failures, 0);
                    // The writer mutates content metadata before Markdown is rendered.
                    if case["mode"] != "empty" {
                        assert_eq!(
                            output.results[0][0]["metadata"]["content_metadata"]["location"],
                            Value::Null
                        );
                        assert!(
                            crate::document_text::markdown(&output.results)
                                .unwrap()
                                .0
                                .contains("Synthetic indexed")
                        );
                    }
                }
                Err(error) => assert_eq!(
                    error.to_string(),
                    case["expected"]["message"].as_str().unwrap(),
                    "{}",
                    case["mode"]
                ),
            }
            consumed(&http, &control).await;
            let mismatch = case["dimension"] == 3;
            let peer = peer.lock().unwrap();
            assert_eq!(peer.calls.len(), if mismatch { 0 } else { 2 });
            assert_eq!(events.lock().unwrap().len(), usize::from(!mismatch));
            if !mismatch {
                let submitted: Value =
                    serde_json::from_str(peer.calls[0]["body"]["payload"].as_str().unwrap())
                        .unwrap();
                let types: Vec<_> = submitted["tasks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t["type"].as_str().unwrap())
                    .collect();
                assert!(types.ends_with(&["split", "dedup", "embed"]));
            }
        }
        if selection == "all" {
            engine.recreate = false;
            let case = &fixture["cases"][0];
            let probe_only = json!([script(case)[0].clone()]);
            // All-failed NV jobs must stop before opening any writer connection.
            for envelope in [
                json!({"status":"failed","description":"Synthetic failure"}),
                Value::Null,
            ] {
                reset(&http, &control, &uri, probe_only.clone()).await;
                peer.lock().unwrap().envelope = envelope;
                let result = engine
                    .build(input())
                    .await
                    .unwrap()
                    .ingest(Stages::worker(json!("fixture.txt"), None))
                    .await
                    .unwrap();
                assert_eq!(result.failures, 2);
                assert_eq!(result.results, json!([]));
                consumed(&http, &control).await;
            }
            // Invalid chunks fail after the read probe, before NV submission.
            reset(&http, &control, &uri, probe_only).await;
            peer.lock().unwrap().calls.clear();
            let mut invalid = input();
            invalid.chunk_overlap = json!(1024);
            assert!(engine.build(invalid).await.is_err());
            assert!(peer.lock().unwrap().calls.is_empty());
            consumed(&http, &control).await;
            let mut serialization: Value =
                serde_json::from_str(include_str!("../tests/fixtures/milvus-serialization.json"))
                    .unwrap();
            crate::document_codecs::tests::expand(&mut serialization);
            let before_insert = script(case)
                .as_array()
                .unwrap()
                .iter()
                .take_while(|call| {
                    !(call["method"] == "Insert"
                        && call["body"]["collection_name"] == "private_collection")
                })
                .cloned()
                .collect::<Vec<_>>();
            for (field, oracle) in [
                ("text", "text-0"),
                ("source", "source-11"),
                ("integer", "content_metadata-39"),
            ] {
                reset(&http, &control, &uri, json!(before_insert)).await;
                let mut data = case["records"][0].clone();
                match field {
                    "text" => data[0]["metadata"]["content"] = json!("aUNITb"),
                    "source" => {
                        data[0]["metadata"]["source_metadata"]["source_name"] = json!("UNIT")
                    }
                    _ => {
                        data[0]["metadata"]["extra"]["large"] =
                            serde_json::from_str("18446744073709551616").unwrap()
                    }
                }
                peer.lock().unwrap().raw = Some(
                    json!({"status":"success","data":data})
                        .to_string()
                        .replace("UNIT", "\\ud800"),
                );
                let error = engine
                    .build(input())
                    .await
                    .unwrap()
                    .ingest(Stages::worker(json!("fixture.txt"), None))
                    .await
                    .err()
                    .unwrap();
                let expected = serialization["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["name"] == oracle)
                    .unwrap();
                assert_eq!(
                    error.to_string(),
                    expected["expected"]["message"].as_str().unwrap()
                );
                consumed(&http, &control).await;
            }
            // Row 1's bad JSON wins over row 2's bad vector, even though the
            // schema places vectors first. Reject before sending document rows.
            let mut row_oracle: Value =
                serde_json::from_str(include_str!("../tests/fixtures/milvus-rows.json")).unwrap();
            crate::document_codecs::tests::expand(&mut row_oracle);
            let expected = row_oracle["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["name"] == "row-order-source-vector")
                .unwrap();
            reset(&http, &control, &uri, json!(before_insert)).await;
            let mut first = case["records"][0][0].clone();
            let mut second = first.clone();
            first["metadata"]["source_metadata"] = json!("bad");
            second["metadata"]["embedding"] = json!(false);
            peer.lock().unwrap().raw =
                Some(json!({"status":"success","data":[first,second]}).to_string());
            let error = engine
                .build(input())
                .await
                .unwrap()
                .ingest(Stages::worker(json!("fixture.txt"), None))
                .await
                .err()
                .unwrap();
            assert_eq!(
                error.to_string(),
                expected["expected"]["message"].as_str().unwrap()
            );
            consumed(&http, &control).await;
            let mut cleanup: Value =
                serde_json::from_str(include_str!("../tests/fixtures/milvus-records-0.json"))
                    .unwrap();
            crate::document_codecs::tests::expand(&mut cleanup);
            let calls = script(case);
            let calls = calls.as_array().unwrap();
            let before_cleanup = &calls[..calls
                .iter()
                .rposition(|call| call["method"] == "GetVersion")
                .unwrap()
                + 3];
            for (field, value, oracle) in [
                ("content", json!(1), "field-41"),
                ("content_metadata", Value::Null, "field-76"),
            ] {
                reset(&http, &control, &uri, json!(before_cleanup)).await;
                let mut data = case["records"][0].clone();
                data[0]["metadata"][field] = value;
                peer.lock().unwrap().raw =
                    Some(json!({"status":"success","data":data}).to_string());
                let error = engine
                    .build(input())
                    .await
                    .unwrap()
                    .ingest(Stages::worker(json!("fixture.txt"), None))
                    .await
                    .err()
                    .unwrap();
                let expected = cleanup["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|case| case["name"] == oracle)
                    .unwrap();
                assert_eq!(
                    error.to_string(),
                    expected["expected"]["message"].as_str().unwrap()
                );
                consumed(&http, &control).await;
            }
            // An orphan unit in the envelope description is not written or
            // rendered. Its marker must not reject otherwise valid row data.
            reset(&http, &control, &uri, script(case)).await;
            peer.lock().unwrap().raw = Some(
                json!({"status":"success","description":"UNIT","data":case["records"][0]})
                    .to_string()
                    .replace("UNIT", "\\udfff"),
            );
            assert!(
                engine
                    .build(input())
                    .await
                    .unwrap()
                    .ingest(Stages::worker(json!("fixture.txt"), None))
                    .await
                    .is_ok()
            );
            consumed(&http, &control).await;
        }
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }
}
