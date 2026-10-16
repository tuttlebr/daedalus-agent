//! Authenticated collection inventory for uploads and RAG readiness.
use crate::{
    App, collections,
    memory_api::{actor, detail},
    milvus,
};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::Value;

pub fn routes() -> Router<App> {
    Router::new()
        .route("/v1/metadata/collections", any(handle))
        .route("/v1/metadata/collections/", any(handle))
}
fn respond((status, body): (u16, Value)) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
}
async fn handle(State(app): State<App>, request: Request) -> Response {
    let Some(preparation) = &app.preparation else {
        return crate::proxy(State(app), request).await;
    };
    let user = match actor(&app, request.headers()) {
        Ok(user) => user,
        Err(error) => return respond(error),
    };
    if request.uri().path().ends_with('/') {
        let target = format!(
            "/v1/metadata/collections{}",
            request
                .uri()
                .query()
                .map(|q| format!("?{q}"))
                .unwrap_or_default()
        );
        return axum::response::Redirect::temporary(&target).into_response();
    }
    if request.method() != Method::GET {
        let mut result = respond(detail(405, "Method Not Allowed"));
        result.headers_mut().insert("Allow", "GET".parse().unwrap());
        return result;
    }
    match milvus::list_collections(&preparation.config).await {
        Ok(existing) => respond((
            200,
            collections::metadata(&preparation.config, &user, &existing),
        )),
        Err(_) => respond(detail(
            503,
            "Collection metadata is temporarily unavailable",
        )),
    }
}
