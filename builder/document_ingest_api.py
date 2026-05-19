"""FastAPI router for structured uploaded-document ingestion.

This endpoint bypasses the agent loop for upload ingestion. The frontend sends
documentRef/documentRefs as JSON, so large batches do not depend on an LLM
copying hundreds of references into a tool call.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Annotated, Any
from urllib.parse import urlparse

from fastapi import APIRouter, Header, HTTPException
from nat_nv_ingest.nat_nv_ingest import (
    NvIngestDocumentProcessor,
    NvIngestFunctionConfig,
)
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/documents", tags=["documents"])


class DocumentRef(BaseModel):
    documentId: str = Field(..., min_length=1)
    sessionId: str = Field(..., min_length=1)
    filename: str | None = None
    mimeType: str | None = None
    userId: str | None = None


class IngestRequest(BaseModel):
    documentRef: DocumentRef | None = None
    documentRefs: list[DocumentRef] | None = None
    collection_name: str | None = None
    collection: str | None = None
    username: str | None = None
    chunk_size: int | None = Field(None, gt=0)
    chunk_overlap: int | None = Field(None, ge=0)


class IngestResponse(BaseModel):
    status: str
    collection: str
    documents: int
    output: str


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return int(value)


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return float(value)


def _redis_url() -> str:
    raw = os.getenv(
        "REDIS_URL",
        "redis://daedalus-redis.daedalus.svc.cluster.local",
    ).strip()
    port = os.getenv("REDIS_PORT", "").strip()
    parsed = urlparse(raw)
    if port and parsed.scheme and parsed.hostname and parsed.port is None:
        return f"{raw.rstrip('/')}:{port}"
    return raw


def _default_config() -> NvIngestFunctionConfig:
    return NvIngestFunctionConfig(
        redis_url=_redis_url(),
        nv_ingest_host=os.getenv(
            "NV_INGEST_HOST", "nv-ingest.nv-ingest.svc.cluster.local"
        ),
        nv_ingest_port=_env_int("NV_INGEST_PORT", 7670),
        milvus_uri=os.getenv(
            "MILVUS_URI", "http://milvus.milvus.svc.cluster.local:19530"
        ),
        minio_endpoint=os.getenv(
            "MINIO_ENDPOINT", "milvus-minio.milvus.svc.cluster.local:9000"
        ),
        minio_access_key=os.getenv("MINIO_ACCESS_KEY", "minioadmin"),
        minio_secret_key=os.getenv("MINIO_SECRET_KEY", "minioadmin"),
        minio_bucket=os.getenv("MINIO_BUCKET", "nv-ingest"),
        chunk_size=_env_int("DOCUMENT_INGEST_CHUNK_SIZE", 1024),
        chunk_overlap=_env_int("DOCUMENT_INGEST_CHUNK_OVERLAP", 150),
        embedder_dim=_env_int("EMBEDDING_DENSE_DIM", 2048),
        tokenizer=os.getenv("TOKENIZER", "meta-llama/Llama-3.2-1B"),
        default_collection_name=os.getenv(
            "DOCUMENT_INGEST_DEFAULT_COLLECTION", "user_uploads"
        ),
        extract_method=os.getenv("DOCUMENT_INGEST_EXTRACT_METHOD", "pdfium"),
        use_v2_api=_env_bool("DOCUMENT_INGEST_USE_V2_API", False),
        pdf_pages_per_chunk=_env_int("DOCUMENT_INGEST_PDF_PAGES_PER_CHUNK", 32),
        enable_image_filter=_env_bool("DOCUMENT_INGEST_ENABLE_IMAGE_FILTER", True),
        enable_captioning=_env_bool("DOCUMENT_INGEST_ENABLE_CAPTIONING", False),
        worker_pool_size=_env_int("DOCUMENT_INGEST_WORKER_POOL_SIZE", 16),
        batch_concurrency=_env_int("DOCUMENT_INGEST_BATCH_CONCURRENCY", 1),
        max_documents_per_batch=_env_int("DOCUMENT_INGEST_MAX_DOCUMENTS_PER_BATCH", 20),
        redis_socket_timeout=_env_int("DOCUMENT_INGEST_REDIS_SOCKET_TIMEOUT", 30),
        redis_connect_timeout=_env_int("DOCUMENT_INGEST_REDIS_CONNECT_TIMEOUT", 5),
        ingest_max_retries=_env_int("DOCUMENT_INGEST_MAX_RETRIES", 2),
        ingest_retry_delay=_env_float("DOCUMENT_INGEST_RETRY_DELAY", 1.0),
        ingest_timeout_seconds=_env_float("DOCUMENT_INGEST_TIMEOUT_SECONDS", 300.0),
    )


@lru_cache(maxsize=1)
def _processor() -> NvIngestDocumentProcessor:
    return NvIngestDocumentProcessor(_default_config())


def _require_trusted_user(x_user_id: str | None) -> str:
    user_id = (x_user_id or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Authenticated user is required")
    return user_id


@router.post("/ingest", response_model=IngestResponse)
async def ingest(
    req: IngestRequest,
    x_user_id: Annotated[str | None, Header(alias="x-user-id")] = None,
) -> IngestResponse:
    user_id = _require_trusted_user(x_user_id)
    username = (req.username or user_id).strip()
    if username != user_id:
        raise HTTPException(status_code=403, detail="username must match x-user-id")

    if req.documentRefs:
        document_refs = [ref.model_dump(exclude_none=True) for ref in req.documentRefs]
    elif req.documentRef:
        document_refs = [req.documentRef.model_dump(exclude_none=True)]
    else:
        raise HTTPException(status_code=400, detail="documentRef or documentRefs required")

    collection = req.collection_name or req.collection or username

    try:
        output = await _processor().process_multiple_documents(
            documentRefs=document_refs,
            username=username,
            collection_name=collection,
            chunk_size=req.chunk_size,
            chunk_overlap=req.chunk_overlap,
        )
    except Exception as e:
        logger.exception("documents.ingest failed")
        raise HTTPException(status_code=500, detail=str(e)) from e

    status = "success"
    lower_output = output.lower()
    if "failed to process any documents" in lower_output or lower_output.startswith(
        "error:"
    ):
        status = "failure"
    elif "partially completed batch processing" in lower_output:
        status = "partial"

    return IngestResponse(
        status=status,
        collection=collection,
        documents=len(document_refs),
        output=output,
    )
