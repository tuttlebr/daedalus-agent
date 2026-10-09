//! P0 dependency probes. These prove specific SDK primitives, not P2/P5 parity.
use axum::{Json, Router, routing::post};
use rmcp::{ServiceExt, model::CallToolRequestParams, transport::StreamableHttpClientTransport};
use serde_json::{Value, json};

#[tokio::test]
async fn mcp_streamable_http_and_oauth_pkce_refresh() {
    async fn peer(Json(body): Json<Value>) -> Json<Value> {
        let result = match body["method"].as_str().unwrap_or("") {
            "initialize" => {
                json!({"protocolVersion":body["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
            }
            "tools/list" => {
                json!({"tools":[{"name":"read","description":"Synthetic read","inputSchema":{"type":"object","properties":{}}}]})
            }
            "tools/call" => {
                json!({"content":[{"type":"text","text":"synthetic evidence"}],"isError":false})
            }
            _ => json!({}),
        };
        Json(json!({"jsonrpc":"2.0","id":body["id"],"result":result}))
    }
    async fn token(body: String) -> Json<Value> {
        assert!(body.contains("code_verifier=") || body.contains("grant_type=refresh_token"));
        Json(
            json!({"access_token":"synthetic-access","token_type":"bearer","refresh_token":"synthetic-rotated","expires_in":3600,"scope":"read"}),
        )
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/mcp", post(peer))
                .route("/token", post(token)),
        )
        .await
        .unwrap()
    });
    let client = ()
        .serve(StreamableHttpClientTransport::from_uri(format!(
            "{base}/mcp"
        )))
        .await
        .unwrap();
    assert_eq!(client.list_all_tools().await.unwrap()[0].name, "read");
    let result = client
        .call_tool(CallToolRequestParams::new("read"))
        .await
        .unwrap();
    assert!(
        serde_json::to_string(&result)
            .unwrap()
            .contains("synthetic evidence")
    );
    client.cancel().await.unwrap();
    use rmcp::transport::auth::{AuthorizationManager, AuthorizationMetadata, OAuthClientConfig};
    let mut manager = AuthorizationManager::new(&base).await.unwrap();
    let mut metadata = AuthorizationMetadata::default();
    metadata.authorization_endpoint = format!("{base}/authorize");
    metadata.token_endpoint = format!("{base}/token");
    manager.set_metadata(metadata);
    manager
        .configure_client(
            OAuthClientConfig::new("synthetic-client", "http://localhost/callback")
                .with_scopes(vec!["read".into()]),
        )
        .unwrap();
    let authorization =
        reqwest::Url::parse(&manager.get_authorization_url(&["read"]).await.unwrap()).unwrap();
    let state = authorization
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    assert!(
        authorization
            .query_pairs()
            .any(|(k, v)| k == "code_challenge_method" && v == "S256")
    );
    assert!(
        manager
            .exchange_code_for_token("synthetic-code", "wrong-state")
            .await
            .is_err()
    );
    manager
        .exchange_code_for_token("synthetic-code", &state)
        .await
        .unwrap();
    manager.refresh_token().await.unwrap();
    assert_eq!(
        manager.get_access_token().await.unwrap(),
        "synthetic-access"
    );
    server.abort();
}

#[tokio::test]
async fn telemetry_exports_terminal_metrics_without_private_content() {
    use axum::{body::Bytes, extract::State};
    use prost::Message;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    type Requests = Arc<Mutex<Vec<Vec<u8>>>>;
    async fn collect(State(requests): State<Requests>, bytes: Bytes) -> &'static str {
        requests.lock().await.push(bytes.to_vec());
        ""
    }
    let requests = Requests::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/traces", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/v1/traces", post(collect))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config = crate::config::Config::new(json!({"telemetry":{"endpoint":endpoint},"llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture","api_key":"PRIVATE_CREDENTIAL"}},"workflow":{"_type":"daedalus_rust_agent","llm_name":"main","instructions":"PRIVATE_PROMPT"}}),Default::default()).unwrap();
    let body = json!({"messages":[{"role":"user","content":"PRIVATE_IDENTITY PRIVATE_ARGUMENT"}]});
    let (prepared, _) = crate::preparation::base_prepare(&config, &body, false).unwrap();
    let telemetry = crate::telemetry::Telemetry::new(&config).unwrap().unwrap();
    let selection = crate::preparation::ModelSelection::new(&config, &body, false, false);
    for outcome in ["completed", "cancelled", "failed"] {
        let mut span = telemetry.start(&prepared, &selection);
        crate::telemetry::finish(
            &mut span,
            outcome,
            &json!({"model_calls":1,"tool_calls":2,"reported_usage_calls":0}),
        );
    }
    telemetry.shutdown().await;
    let requests = requests.lock().await;
    assert!(!requests.is_empty());
    let mut outcomes = Vec::new();
    for bytes in requests.iter() {
        assert!(!String::from_utf8_lossy(bytes).contains("PRIVATE"));
        let export =
            opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest::decode(
                bytes.as_slice(),
            )
            .unwrap();
        for resource in export.resource_spans {
            for scope in resource.scope_spans {
                for span in scope.spans {
                    assert_eq!(span.name, "daedalus.agent");
                    assert!(
                        span.attributes
                            .iter()
                            .any(|a| a.key == "reported_usage_calls")
                    );
                    outcomes.push(
                        span.attributes
                            .into_iter()
                            .find(|a| a.key == "outcome")
                            .unwrap()
                            .value
                            .unwrap()
                            .value
                            .unwrap(),
                    );
                }
            }
        }
    }
    assert_eq!(outcomes.len(), 3);
    server.abort();
}

#[tokio::test]
#[ignore = "opt-in dedicated synthetic collection on a configured Milvus service"]
async fn milvus_rest_probe() {
    let base = std::env::var("DAEDALUS_TEST_MILVUS_URL").unwrap();
    assert!(base.starts_with("http://127.0.0.1:"));
    let token = std::env::var("DAEDALUS_TEST_MILVUS_TOKEN").unwrap();
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap();
    let name = format!("daedalus_p0_{}", uuid::Uuid::new_v4().simple());
    println!("Synthetic collection for cleanup: {name}");
    let call = |path: &'static str, mut body: Value| {
        body["collectionName"] = json!(name);
        http.post(format!("{base}/v2/vectordb/{path}"))
            .header("Request-Timeout", "10")
            .bearer_auth(&token)
            .json(&body)
            .send()
    };
    let result: anyhow::Result<()> = async {
        let created: Value = call("collections/create",json!({"dimension":3,"metricType":"COSINE"})).await?.error_for_status()?.json().await?;
        anyhow::ensure!(created["code"]==0,"Milvus collection create failed");
        let inserted: Value = call("entities/insert",json!({"data":[{"id":1,"vector":[1.0,0.0,0.0],"text":"synthetic migration evidence"}]})).await?.error_for_status()?.json().await?;
        anyhow::ensure!(inserted["code"]==0,"Milvus insert failed");
        let searched: Value = call("entities/search",json!({"data":[[1.0,0.0,0.0]],"limit":1,"outputFields":["id","text"],"consistencyLevel":"Strong"})).await?.error_for_status()?.json().await?;
        anyhow::ensure!(searched["code"]==0 && searched["data"][0]["text"]=="synthetic migration evidence","Milvus search parity failed");
        let invalid: Value = call("entities/insert",json!({"data":[{"id":2,"vector":[1.0,0.0]}]})).await?.error_for_status()?.json().await?;
        anyhow::ensure!(invalid["code"]!=0,"Embedding dimension mismatch accepted");
        Ok(())
    }.await;
    let dropped: Value = call("collections/drop", json!({}))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(dropped["code"], 0, "Synthetic collection cleanup failed");
    result.unwrap();
}

#[tokio::test]
#[ignore = "opt-in synthetic extract-only job on the configured NV-Ingest service"]
async fn nvingest_rest_probe() {
    let base = std::env::var("DAEDALUS_TEST_NVINGEST_URL").unwrap();
    assert!(base.starts_with("http://127.0.0.1:"));
    let fixture: Value =
        serde_json::from_str(include_str!("../tests/fixtures/nvingest.json")).unwrap();
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap();
    // Same payload as the real 26.3.0 client, without its local Python pipeline.
    let job = http
        .post(format!("{base}/v2/submit_job"))
        .json(&fixture["requests"][0]["body"])
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .text()
        .await
        .unwrap();
    let id = job.trim_matches('"');
    assert!(id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    loop {
        let response = http
            .get(format!("{base}/v2/fetch_job/{id}"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        if response.status() == 200 {
            assert!(
                response
                    .text()
                    .await
                    .unwrap()
                    .contains("Synthetic Daedalus migration evidence")
            );
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Synthetic extraction timed out"
        );
        assert_eq!(response.status(), 202);
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}
