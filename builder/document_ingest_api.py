"""FastAPI router for structured uploaded-document ingestion.

This endpoint bypasses the agent loop for upload ingestion. The frontend sends
documentRef/documentRefs as JSON, so large batches do not depend on an LLM
copying hundreds of references into a tool call.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from functools import lru_cache
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Response
from fastapi.responses import StreamingResponse
from nat_helpers.internal_auth import require_trusted_user as _require_trusted_user
from nat_helpers.redis_url import redis_url_from_env
from nat_nv_ingest.nat_nv_ingest import (
    INLINE_MARKDOWN_CHAR_LIMIT,
    NvIngestDocumentProcessor,
    NvIngestFunctionConfig,
    document_markdown_max_chars,
    validate_collection_scope,
)
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/documents", tags=["documents"])

MAX_DOCUMENTS_PER_REQUEST = int(os.getenv("DOCUMENT_INGEST_REQUEST_LIMIT", "500"))


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
    collection_scope: str | None = None
    provenance: dict[str, Any] | None = None
    username: str | None = None
    chunk_size: int | None = Field(None, gt=0)
    chunk_overlap: int | None = Field(None, ge=0)


class IngestResponse(BaseModel):
    status: str
    collection: str
    documents: int
    output: str


class ExtractRequest(BaseModel):
    documentRef: DocumentRef
    username: str | None = None
    char_limit: int | None = Field(None, gt=0, le=500_000)


class ExtractResponse(BaseModel):
    status: str
    filename: str
    pages: int
    markdown: str
    truncated: bool
    original_chars: int


class MarkdownRequest(BaseModel):
    documentRef: DocumentRef
    username: str | None = None
    # No char_limit: the doc-to-markdown download returns the whole document,
    # bounded server-side by document_markdown_max_chars().


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
    return redis_url_from_env()


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
        milvus_username=os.getenv("MILVUS_USERNAME") or os.getenv("MILVUS_USER"),
        milvus_password=os.getenv("MILVUS_PASSWORD"),
        milvus_token=os.getenv("MILVUS_TOKEN"),
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


def _resolve_request(
    req: IngestRequest,
    x_user_id: str | None,
    x_daedalus_internal_token: str | None = None,
) -> tuple[str, list[dict[str, Any]], str, str, dict[str, Any] | None]:
    user_id = _require_trusted_user(x_user_id, x_daedalus_internal_token)
    username = (req.username or user_id).strip()
    if username != user_id:
        raise HTTPException(status_code=403, detail="username must match x-user-id")

    if req.documentRefs:
        document_refs = [ref.model_dump(exclude_none=True) for ref in req.documentRefs]
    elif req.documentRef:
        document_refs = [req.documentRef.model_dump(exclude_none=True)]
    else:
        raise HTTPException(
            status_code=400, detail="documentRef or documentRefs required"
        )

    if len(document_refs) > MAX_DOCUMENTS_PER_REQUEST:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Too many documents in a single request: "
                f"{len(document_refs)} > {MAX_DOCUMENTS_PER_REQUEST}. "
                "Split the upload into smaller batches."
            ),
        )

    collection = req.collection_name or req.collection or username
    try:
        collection_scope = validate_collection_scope(
            collection,
            req.collection_scope,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if collection_scope == "shared":
        raise HTTPException(
            status_code=403,
            detail=(
                "Shared collection writes are not permitted through user-facing "
                "document ingestion."
            ),
        )

    return username, document_refs, collection, collection_scope, req.provenance


def _classify_status(output: str) -> str:
    lower_output = output.lower()
    if "failed to process any documents" in lower_output or lower_output.startswith(
        "error:"
    ):
        return "failure"
    if "partially completed batch processing" in lower_output:
        return "partial"
    return "success"


_MD_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _markdown_filename(source_filename: str | None) -> str:
    """Derive a safe ``<basename>.md`` download name from a source filename.

    Strips directory components (defusing path traversal), drops the original
    extension, replaces unsafe characters with ``_``, bounds length, and falls
    back to ``document.md`` when nothing usable remains. The result is embedded
    in a ``Content-Disposition`` header, so it must never contain quotes,
    newlines, or path separators.
    """
    raw = (source_filename or "").strip()
    base = os.path.basename(raw)
    stem = base.rsplit(".", 1)[0] if "." in base else base
    safe = _MD_FILENAME_SAFE_RE.sub("_", stem).strip("._-")
    if not safe:
        safe = "document"
    return f"{safe[:128]}.md"


def _raise_for_extract_failure(message: str) -> None:
    """Map an extract/markdown failure string to an HTTP error.

    Shared by ``/extract`` and ``/markdown`` so both surface ownership, missing,
    oversized, and timeout failures as the right 4xx/5xx instead of generic 500s.
    """
    lower = message.lower()
    if "access" in lower:
        raise HTTPException(status_code=403, detail=message)
    if "not found" in lower or "expired" in lower:
        raise HTTPException(status_code=404, detail=message)
    if "exceeds the maximum allowed size" in lower:
        raise HTTPException(status_code=413, detail=message)
    if "timed out" in lower:
        raise HTTPException(status_code=504, detail=message)
    if "invalid" in lower or "required" in lower or "empty" in lower:
        raise HTTPException(status_code=400, detail=message)
    raise HTTPException(status_code=500, detail=message)


@router.post("/ingest", response_model=IngestResponse)
async def ingest(
    req: IngestRequest,
    x_user_id: Annotated[str | None, Header(alias="x-user-id")] = None,
    x_daedalus_internal_token: Annotated[
        str | None, Header(alias="x-daedalus-internal-token")
    ] = None,
) -> IngestResponse:
    username, document_refs, collection, collection_scope, provenance = (
        _resolve_request(
            req,
            x_user_id,
            x_daedalus_internal_token,
        )
    )
    if provenance:
        logger.info("documents.ingest provenance: %s", json.dumps(provenance)[:1000])

    try:
        output = await _processor().process_multiple_documents(
            documentRefs=document_refs,
            username=username,
            collection_name=collection,
            collection_scope=collection_scope,
            provenance=provenance,
            chunk_size=req.chunk_size,
            chunk_overlap=req.chunk_overlap,
        )
    except Exception as e:
        logger.exception("documents.ingest failed")
        raise HTTPException(status_code=500, detail=str(e)) from e

    return IngestResponse(
        status=_classify_status(output),
        collection=collection,
        documents=len(document_refs),
        output=output,
    )


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@router.post("/ingest/stream")
async def ingest_stream(
    req: IngestRequest,
    x_user_id: Annotated[str | None, Header(alias="x-user-id")] = None,
    x_daedalus_internal_token: Annotated[
        str | None, Header(alias="x-daedalus-internal-token")
    ] = None,
) -> StreamingResponse:
    """Server-Sent Events variant of /ingest that emits per-document progress.

    Events:
      - progress: {completed, total, current, currentIndex, percent, phase, message}
      - complete: {status, output, collection, documents}
      - error:    {detail}
    """
    username, document_refs, collection, collection_scope, provenance = (
        _resolve_request(
            req,
            x_user_id,
            x_daedalus_internal_token,
        )
    )
    if provenance:
        logger.info(
            "documents.ingest_stream provenance: %s",
            json.dumps(provenance)[:1000],
        )
    total = len(document_refs)
    queue: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue()

    async def progress_cb(progress: dict[str, Any]) -> None:
        payload = {
            "completed": int(progress.get("completed") or 0),
            "total": int(progress.get("total") or total),
            "current": progress.get("current"),
            "currentIndex": progress.get("currentIndex"),
            "percent": int(progress.get("percent") or 0),
            "phase": progress.get("phase") or "processing",
            "message": progress.get("message"),
            "chunks": progress.get("chunks"),
            "pages": progress.get("pages"),
            "failures": progress.get("failures"),
            "attempt": progress.get("attempt"),
        }
        await queue.put(("progress", payload))

    async def run_ingest() -> None:
        try:
            output = await _processor().process_multiple_documents(
                documentRefs=document_refs,
                username=username,
                collection_name=collection,
                collection_scope=collection_scope,
                provenance=provenance,
                chunk_size=req.chunk_size,
                chunk_overlap=req.chunk_overlap,
                progress_callback=progress_cb,
            )
            await queue.put(
                (
                    "complete",
                    {
                        "status": _classify_status(output),
                        "collection": collection,
                        "documents": total,
                        "output": output,
                    },
                )
            )
        except Exception as e:
            logger.exception("documents.ingest stream failed")
            await queue.put(("error", {"detail": str(e)}))
        finally:
            await queue.put(("__done__", {}))

    async def event_stream():
        # Initial progress event so the client can render an empty bar immediately.
        yield _sse(
            "progress",
            {
                "completed": 0,
                "total": total,
                "current": None,
                "currentIndex": None,
                "percent": 0,
                "phase": "queued",
                "message": (
                    f"Queued {total} document{'' if total == 1 else 's'} for ingestion"
                ),
            },
        )
        task = asyncio.create_task(run_ingest())
        try:
            while True:
                event, payload = await queue.get()
                if event == "__done__":
                    break
                yield _sse(event, payload)
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/extract", response_model=ExtractResponse)
async def extract(
    req: ExtractRequest,
    x_user_id: Annotated[str | None, Header(alias="x-user-id")] = None,
    x_daedalus_internal_token: Annotated[
        str | None, Header(alias="x-daedalus-internal-token")
    ] = None,
) -> ExtractResponse:
    """Extract a single document to markdown without chunking or Milvus upload.

    Bypasses the agent loop entirely so the request cannot be paraphrased
    away — `extract` operations require exact-args fidelity (especially
    `username` for the ownership check) which the LLM router corrupts when
    routed through `/chat`.
    """
    user_id = _require_trusted_user(x_user_id, x_daedalus_internal_token)
    username = (req.username or user_id).strip()
    if username != user_id:
        raise HTTPException(status_code=403, detail="username must match x-user-id")

    document_ref = req.documentRef.model_dump(exclude_none=True)
    char_limit = req.char_limit or INLINE_MARKDOWN_CHAR_LIMIT

    try:
        result = await _processor().extract_document(
            documentRef=document_ref,
            username=username,
            char_limit=char_limit,
        )
    except Exception as e:
        logger.exception("documents.extract failed")
        raise HTTPException(status_code=500, detail=str(e)) from e

    if result["status"] == "failure":
        # Map ownership/missing-doc failures to 4xx so the frontend can
        # surface them cleanly instead of generic 500s.
        _raise_for_extract_failure(result["error"])

    return ExtractResponse(
        status=result["status"],
        filename=result["filename"],
        pages=result["pages"],
        markdown=result["markdown"],
        truncated=result["truncated"],
        original_chars=result["original_chars"],
    )


@router.post("/markdown")
async def markdown(
    req: MarkdownRequest,
    x_user_id: Annotated[str | None, Header(alias="x-user-id")] = None,
    x_daedalus_internal_token: Annotated[
        str | None, Header(alias="x-daedalus-internal-token")
    ] = None,
) -> Response:
    """Extract a full uploaded document to a downloadable Markdown file.

    Unlike `/extract` (truncated, JSON, for LLM consumption), this returns the
    *whole* document as a `text/markdown` attachment for the user to download
    locally. Bounded server-side by `document_markdown_max_chars()`. Bypasses
    the agent loop and reuses the same ownership check + failure→status mapping
    as `/extract`.
    """
    user_id = _require_trusted_user(x_user_id, x_daedalus_internal_token)
    username = (req.username or user_id).strip()
    if username != user_id:
        raise HTTPException(status_code=403, detail="username must match x-user-id")

    document_ref = req.documentRef.model_dump(exclude_none=True)

    try:
        result = await _processor().extract_document(
            documentRef=document_ref,
            username=username,
            char_limit=document_markdown_max_chars(),
        )
    except Exception as e:
        logger.exception("documents.markdown failed")
        raise HTTPException(status_code=500, detail=str(e)) from e

    if result["status"] == "failure":
        _raise_for_extract_failure(result["error"])

    if not result["markdown"]:
        # e.g. an image-only/scanned document with no extractable text.
        raise HTTPException(
            status_code=422,
            detail="No extractable text or markdown content in this document.",
        )

    filename = _markdown_filename(result["filename"])
    return Response(
        content=result["markdown"].encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Document-Pages": str(result["pages"]),
            "X-Document-Truncated": "true" if result["truncated"] else "false",
            "X-Original-Chars": str(result["original_chars"]),
            "Cache-Control": "private, no-store",
        },
    )
