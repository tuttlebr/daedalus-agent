import asyncio
import base64
import html as html_mod
import json
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable
from io import BytesIO
from typing import Any, Literal, TypedDict

import redis
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.identity import resolve_authenticated_user_id
from nv_ingest_client.client import Ingestor, NvIngestClient
from pydantic import BaseModel, ConfigDict, Field
from pymilvus import MilvusClient

logger = logging.getLogger(__name__)


class IngestProgressEvent(TypedDict, total=False):
    completed: int
    total: int
    current: str | None
    currentIndex: int
    percent: int
    phase: str
    message: str
    chunks: int
    pages: int
    failures: int
    attempt: int


ProgressCallback = Callable[[IngestProgressEvent], Awaitable[None]]


_PROGRESS_PHASE_WEIGHTS = {
    "queued": 0.0,
    "fetching": 0.04,
    "fetched": 0.08,
    "waiting": 0.12,
    "preparing": 0.16,
    "submitting": 0.24,
    "processing": 0.42,
    "indexing": 0.70,
    "postprocessing": 0.86,
    "postprocessed": 0.94,
    "retrying": 0.20,
}

# Precompiled regex used by the markdown cleaners and dedup helpers.
_HTML_TAG_RE = re.compile(r"</?(?:span|div|p|font)[^>]*>")
_BR_RE = re.compile(r"<br\s*/?>")
_WS_RE = re.compile(r"[ \t]+")
_SPACE_NL_RE = re.compile(r" +\n")
_NL_COLLAPSE_RE = re.compile(r"\n{3,}")
_DEHYPHEN_RE = re.compile(r"(\w)-\n(\w)")
_EMPTY_ROW_RE = re.compile(r"^\|[\s|]*$")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9\s]")
_COLLECTION_PART_RE = re.compile(r"[^a-zA-Z0-9_]+")
_UNDERSCORE_COLLAPSE_RE = re.compile(r"_+")
SHARED_COLLECTION_NAMES = {
    "kubernetes",
    "mentalhealth",
    "nvidia",
    "semianalysis",
    "vetpartner",
}


class IngestResult(TypedDict):
    """Structured result of ingesting a single document.

    Returned by `process_document` so callers (router / batch handler) work
    off typed fields instead of re-parsing a human-readable message string.
    """

    status: Literal["success", "partial", "failure"]
    filename: str
    chunks: int
    failures: int
    pages: int
    collection: str
    markdown: str
    error: str


class ExtractResult(TypedDict):
    """Structured result of extract-only document processing.

    Returned by `extract_document` when the caller wants raw markdown without
    chunking, embedding, or Milvus upload. Used by the chat "inline" mode where
    the document content is dropped straight into the LLM prompt.
    """

    status: Literal["success", "failure"]
    filename: str
    pages: int
    markdown: str
    truncated: bool
    original_chars: int
    error: str


INLINE_MARKDOWN_CHAR_LIMIT = 50_000

# Hard cap (characters) on full-document markdown downloads. Unlike the inline
# cap above (which protects the chat context window), this only bounds the
# server's memory for the doc-to-markdown download path — it is large enough to
# return any plausible whole-document rendering. Overridable via the
# DOCUMENT_MARKDOWN_MAX_CHARS env var.
DEFAULT_DOCUMENT_MARKDOWN_MAX_CHARS = 20_000_000

# Cap the length of per-document error text echoed back to the client (both the
# batch summary and the streamed progress message). The full error is logged
# server-side; only this prefix is surfaced to the user/LLM.
ERROR_MESSAGE_CHAR_LIMIT = 100

# Default per-document ingest size cap (bytes) applied before base64 decoding.
# Overridable via the DOCUMENT_INGEST_MAX_SIZE_BYTES env var.
DEFAULT_DOCUMENT_INGEST_MAX_SIZE_BYTES = 100 * 1024 * 1024


def _truncate_error(error: object, limit: int = ERROR_MESSAGE_CHAR_LIMIT) -> str:
    """Cap error text surfaced to the client to ``limit`` characters."""
    text = str(error)
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def document_ingest_max_size_bytes() -> int:
    """Resolve the per-document ingest size cap (bytes) from the environment.

    Falls back to ``DEFAULT_DOCUMENT_INGEST_MAX_SIZE_BYTES`` when the env var is
    unset, empty, non-numeric, or non-positive.
    """
    raw = (os.getenv("DOCUMENT_INGEST_MAX_SIZE_BYTES") or "").strip()
    if not raw:
        return DEFAULT_DOCUMENT_INGEST_MAX_SIZE_BYTES
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_DOCUMENT_INGEST_MAX_SIZE_BYTES
    return value if value > 0 else DEFAULT_DOCUMENT_INGEST_MAX_SIZE_BYTES


def document_markdown_max_chars() -> int:
    """Resolve the full-document markdown download cap (chars) from the env.

    Falls back to ``DEFAULT_DOCUMENT_MARKDOWN_MAX_CHARS`` when
    ``DOCUMENT_MARKDOWN_MAX_CHARS`` is unset, empty, non-numeric, or non-positive.
    """
    raw = (os.getenv("DOCUMENT_MARKDOWN_MAX_CHARS") or "").strip()
    if not raw:
        return DEFAULT_DOCUMENT_MARKDOWN_MAX_CHARS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_DOCUMENT_MARKDOWN_MAX_CHARS
    return value if value > 0 else DEFAULT_DOCUMENT_MARKDOWN_MAX_CHARS


def _apply_char_limit(raw_md: str, char_limit: int | None) -> tuple[str, bool]:
    """Apply an optional character cap to extracted markdown.

    Returns ``(markdown, truncated)``. A ``char_limit`` of None means no
    truncation. Markdown exactly at the limit is not considered truncated.
    """
    if char_limit is None or len(raw_md) <= char_limit:
        return raw_md, False
    return raw_md[:char_limit], True


def _estimated_decoded_size(document_base64: str) -> int:
    """Estimate the decoded byte length of a base64 string without decoding.

    Base64 encodes 3 bytes per 4 characters; padding ('=') reduces the count.
    Used to reject oversized uploads before allocating the decoded bytes.
    """
    encoded = document_base64.strip()
    padding = encoded.count("=")
    return (len(encoded) * 3) // 4 - padding


def _document_size_error(document_base64: str, max_bytes: int) -> str | None:
    """Return an error string when the base64 payload exceeds ``max_bytes``.

    Returns None when the payload is within the limit.
    """
    estimated = _estimated_decoded_size(document_base64)
    if estimated > max_bytes:
        return (
            f"Error: Document exceeds the maximum allowed size "
            f"({max_bytes} bytes). Please upload a smaller file."
        )
    return None


def normalize_collection_part(value: str | None, fallback: str = "anonymous") -> str:
    """Return a Milvus-safe collection name component."""
    raw = (value or "").strip() or fallback
    normalized = _COLLECTION_PART_RE.sub("_", raw)
    normalized = _UNDERSCORE_COLLAPSE_RE.sub("_", normalized).strip("_").lower()
    if not normalized:
        normalized = fallback
    if normalized[0].isdigit():
        normalized = f"u_{normalized}"
    return normalized[:64]


def user_upload_collection_name(
    username: str | None,
    base_collection_name: str | None = "user_uploads",
) -> str:
    """Derive the default per-user uploaded-document collection name."""
    base = normalize_collection_part(base_collection_name, fallback="user_uploads")
    user = normalize_collection_part(username, fallback="anonymous")
    suffix = f"_{user}"
    if base.endswith(suffix):
        return base
    return f"{base}{suffix}"


def resolve_user_collection_name(
    collection_name: str | None,
    username: str | None,
    default_collection_name: str | None = "user_uploads",
) -> str:
    """Resolve a target collection without allowing cross-user private writes."""
    if not collection_name:
        return user_upload_collection_name(username, default_collection_name)

    collection = normalize_collection_part(collection_name, fallback="user_uploads")
    user = normalize_collection_part(username, fallback="anonymous")

    if collection in SHARED_COLLECTION_NAMES:
        return collection
    if collection == user or collection.endswith(f"_{user}"):
        return collection
    return user_upload_collection_name(username, collection)


def classify_collection_scope(collection_name: str | None) -> Literal["shared", "user"]:
    """Classify a Milvus collection as shared or user-scoped."""
    collection = normalize_collection_part(collection_name, fallback="")
    if collection in SHARED_COLLECTION_NAMES:
        return "shared"
    return "user"


def validate_collection_scope(
    collection_name: str,
    requested_scope: str | None,
) -> Literal["shared", "user"]:
    """Validate optional caller-supplied scope against the resolved collection."""
    actual_scope = classify_collection_scope(collection_name)
    if not requested_scope:
        return actual_scope

    normalized_scope = requested_scope.strip().lower()
    if normalized_scope not in {"shared", "user"}:
        raise ValueError("collection_scope must be 'shared' or 'user'.")
    if normalized_scope != actual_scope:
        raise ValueError(
            f"collection_scope '{normalized_scope}' does not match "
            f"collection '{collection_name}' ({actual_scope})."
        )
    return actual_scope


def validate_user_collection_write_scope(
    collection_name: str,
    requested_scope: str | None,
) -> Literal["user"]:
    """Reject shared-corpus writes from user-facing ingestion paths."""

    actual_scope = validate_collection_scope(collection_name, requested_scope)
    if actual_scope == "shared":
        raise ValueError(
            "Shared collection writes are not permitted through user-facing "
            "document ingestion. Ingest into your private collection instead."
        )
    return "user"


def _can_access_stored_document(
    document_record: dict[str, Any],
    username: str | None,
) -> bool:
    """Return whether a stored document record is usable by the current user.

    F-011: an authenticated user may only reach documents they own. A record
    stored without a userId (legacy/anonymous upload) is reachable only by an
    unauthenticated/anonymous requester — an authenticated user must NOT read
    another party's un-owned upload. The frontend session-scoped ownership check
    remains the primary gate; this is defense-in-depth at the backend boundary.
    """
    document_user_id = str(document_record.get("userId") or "").strip()
    requester = (username or "").strip()
    if document_user_id:
        return document_user_id == requester
    # Owner-less document: only an anonymous/unauthenticated caller may access it.
    return requester == "" or requester.lower() == "anonymous"


def format_user_document_search_results(output: object, collection_name: str) -> str:
    """Format Milvus retriever output for user document search."""
    results = getattr(output, "results", None) or []
    if not results:
        return f"No matching uploaded-document passages found in {collection_name}."

    parts = [f"Collection: {collection_name}", f"Passages: {len(results)}"]
    for idx, doc in enumerate(results, start=1):
        content = getattr(doc, "page_content", "") or str(doc)
        metadata = getattr(doc, "metadata", {}) or {}
        source = (
            metadata.get("filename")
            or metadata.get("source")
            or metadata.get("document_id")
            or metadata.get("title")
        )
        distance = metadata.get("distance")
        header_bits = [f"{idx}."]
        if source:
            header_bits.append(str(source))
        if distance is not None:
            header_bits.append(f"distance={distance}")
        parts.append(f"\n{' '.join(header_bits)}\n{content}")
    return "\n".join(parts)


class NvIngestFunctionConfig(FunctionBaseConfig, name="nat_nv_ingest"):
    """Configuration for NvIngest document processing function."""

    # Connection endpoints
    redis_url: str = Field(
        default="redis://localhost:6379",
        description="Redis connection URL for retrieving documents",
    )
    nv_ingest_host: str = Field(
        default="localhost", description="NvIngest service hostname"
    )
    nv_ingest_port: int = Field(default=7670, description="NvIngest service port")
    milvus_uri: str = Field(
        default="http://localhost:19530", description="Milvus connection URI"
    )
    milvus_username: str | None = Field(
        default_factory=lambda: (
            os.getenv("MILVUS_USERNAME") or os.getenv("MILVUS_USER") or None
        ),
        description="Milvus username when authentication is enabled",
    )
    milvus_password: str | None = Field(
        default_factory=lambda: os.getenv("MILVUS_PASSWORD") or None,
        description="Milvus password when authentication is enabled",
    )
    milvus_token: str | None = Field(
        default_factory=lambda: os.getenv("MILVUS_TOKEN") or None,
        description=(
            "Milvus auth token for direct pymilvus clients. If formatted as "
            "username:password, it is also used for NV-Ingest VDB upload."
        ),
    )
    minio_endpoint: str = Field(
        default="localhost:9000", description="MinIO endpoint for document storage"
    )
    minio_access_key: str = Field(default="minioadmin", description="MinIO access key")
    minio_secret_key: str = Field(default="minioadmin", description="MinIO secret key")
    minio_bucket: str = Field(
        default="nv-ingest", description="MinIO bucket name for extracted assets"
    )

    # Chunking / embedding
    chunk_size: int = Field(default=1024, description="Text chunk size for processing")
    chunk_overlap: int = Field(default=150, description="Overlap between text chunks")
    embedder_dim: int = Field(default=2048, description="Embedding dimension")
    tokenizer: str = Field(
        default="meta-llama/Llama-3.2-1B",
        description="Tokenizer used for chunking",
    )

    # Collection management
    recreate_collection: bool = Field(
        default=False, description="Whether to recreate Milvus collection on each run"
    )
    default_collection_name: str = Field(
        default="user_uploads",
        description="Fallback Milvus collection name when none is supplied in the request",
    )
    database_name: str = Field(
        default="default",
        description="Milvus database name for user document retrieval",
    )

    # Extraction pipeline
    extract_method: str = Field(
        default="pdfium",
        description=(
            "PDF extract method (pdfium, pdfium_hybrid, nemotron_parse, tika, ocr)."
        ),
    )

    # V2 API feature flag + server-side PDF chunking
    use_v2_api: bool = Field(
        default=False,
        description="Enable NV-Ingest V2 API (required for pdf_split_config)",
    )
    pdf_pages_per_chunk: int = Field(
        default=32,
        description="PDF server-side chunking pages per chunk (V2 API only, 1-128)",
    )

    # Image pipeline
    enable_image_filter: bool = Field(
        default=True,
        description="Drop tiny/odd-aspect images from the extraction output",
    )
    enable_captioning: bool = Field(
        default=False,
        description="Enable VLM captioning of extracted images / charts",
    )
    caption_model_name: str | None = Field(
        default=None, description="VLM model name used for captioning"
    )
    caption_endpoint_url: str | None = Field(
        default=None, description="VLM endpoint URL used for captioning"
    )
    caption_api_key: str | None = Field(
        default=None, description="API key for the captioning service"
    )

    # Concurrency
    worker_pool_size: int = Field(
        default=16, description="NvIngestClient worker pool size"
    )
    batch_concurrency: int = Field(
        default=1,
        description="Max concurrent documents per batch request (1 = sequential)",
    )
    max_documents_per_batch: int = Field(
        default=20,
        description="Max documents allowed in a single batch request",
    )

    # Robustness
    redis_socket_timeout: int = Field(
        default=30, description="Redis socket read timeout (seconds)"
    )
    redis_connect_timeout: int = Field(
        default=5, description="Redis connection timeout (seconds)"
    )
    ingest_max_retries: int = Field(
        default=2, description="Max retries for transient NV-Ingest failures"
    )
    ingest_retry_delay: float = Field(
        default=1.0, description="Seconds to wait between ingest retries"
    )
    ingest_timeout_seconds: float = Field(
        default=300.0,
        description="Hard timeout for one document's NV-Ingest call",
    )

    # Retrieval mode for the consolidated user document tool
    embedder_name: str = Field(
        default="milvus_embedder",
        description="Embedder used to vectorize user document search queries",
    )
    content_field: str = Field(
        default="text",
        description="Milvus field containing indexed document text",
    )
    vector_field: str = Field(
        default="vector",
        description="Milvus vector field for similarity search",
    )
    top_k: int = Field(
        default=10,
        gt=0,
        description="Default number of user document chunks to retrieve",
    )
    distance_cutoff: float | None = Field(
        default=None,
        description="Optional search distance cutoff before reranking",
    )
    output_fields: list[str] | None = Field(
        default=None,
        description="Optional Milvus output fields for document retrieval",
    )
    search_params: dict[str, Any] = Field(
        default_factory=lambda: {"metric_type": "L2"},
        description="Milvus search parameters for document retrieval",
    )
    use_reranker: bool = Field(
        default=True,
        description="Whether to rerank retrieved document chunks",
    )
    reranker_endpoint: str | None = Field(
        default=None,
        description="Reranker endpoint for user document retrieval",
    )
    reranker_model: str | None = Field(
        default=None,
        description="Reranker model for user document retrieval",
    )
    reranker_top_n: int | None = Field(
        default=None,
        description="Number of reranked document chunks to keep",
    )
    reranker_api_key: str | None = Field(
        default=None,
        description="Reranker API key for user document retrieval",
    )


class UserDocumentInput(BaseModel):
    """LLM-facing document-tool input; request identity is intentionally absent."""

    model_config = ConfigDict(extra="forbid")

    operation: Literal["ingest", "extract", "search", "list_collections"] = "search"
    query: str = ""
    collection_name: str | None = None
    provenance: dict[str, Any] | None = None
    documentRef: dict[str, Any] | None = None
    documentRefs: list[dict[str, Any]] | None = None
    top_k: int | None = Field(default=None, gt=0)
    filters: str | None = None
    chunk_size: int | None = Field(default=None, gt=0)
    chunk_overlap: int | None = Field(default=None, ge=0)


# --- Module-level helpers (pure) ---------------------------------------------


def clean_markdown(text: str) -> str:
    """Apply low-cost text cleanup to raw NV-Ingest extracted content."""
    if not text:
        return text

    text = html_mod.unescape(text)

    text = _BR_RE.sub("\n", text)
    text = _HTML_TAG_RE.sub("", text)

    text = (
        text.replace("\u00a0", " ")  # non-breaking space
        .replace("\u200b", "")  # zero-width space
        .replace("\u200c", "")  # zero-width non-joiner
        .replace("\u200d", "")  # zero-width joiner
        .replace("\ufeff", "")  # BOM
        .replace("\u2028", "\n")  # line separator
        .replace("\u2029", "\n")  # paragraph separator
    )

    text = (
        text.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2013", "-")
        .replace("\u2014", "--")
        .replace("\u2026", "...")
    )

    text = _DEHYPHEN_RE.sub(r"\1\2", text)

    text = _WS_RE.sub(" ", text)
    text = _SPACE_NL_RE.sub("\n", text)
    text = _NL_COLLAPSE_RE.sub("\n\n", text)

    return text.strip()


def clean_table_markdown(text: str) -> str:
    """Light repair of markdown tables from NV-Ingest structured extraction."""
    if not text:
        return text

    text = html_mod.unescape(text)
    text = _HTML_TAG_RE.sub("", text)
    text = text.replace("\u00a0", " ")  # non-breaking space

    lines = text.strip().split("\n")

    while lines and _EMPTY_ROW_RE.match(lines[-1]):
        lines.pop()

    if not lines:
        return text

    header_cols = lines[0].count("|") - 1
    if header_cols < 1:
        return "\n".join(lines)

    repaired: list[str] = []
    for i, line in enumerate(lines):
        if not line.strip().startswith("|"):
            repaired.append(line)
            continue

        cells = line.strip().strip("|").split("|")

        if i == 1 and all(c.strip().replace("-", "") == "" for c in cells):
            cells = [" --- "] * header_cols
        else:
            if len(cells) < header_cols:
                cells.extend([""] * (header_cols - len(cells)))
            elif len(cells) > header_cols:
                cells = cells[:header_cols]

        repaired.append("| " + " | ".join(c.strip() for c in cells) + " |")

    return "\n".join(repaired)


def _text_quality_score(text: str) -> float:
    """Score text quality: higher = cleaner. Garbled OCR text scores lower."""
    if not text:
        return 0.0
    alnum = sum(1 for c in text if c.isalnum() or c.isspace())
    return alnum / len(text) if text else 0.0


def _normalize_for_dedup(text: str) -> set[str]:
    """Extract word-set for Jaccard similarity comparison."""
    return set(_NON_ALNUM_RE.sub("", text.lower()).split())


def _dedup_entries(entries: list[dict]) -> list[dict]:
    """Remove near-duplicate text entries on the same page.

    Keeps the higher-quality version when two entries on the same page share
    at least 50% of their word sets (Jaccard similarity).
    """
    if len(entries) <= 1:
        return entries

    page_groups: dict[int, list[tuple[int, dict, str, set[str]]]] = {}
    for idx, entry in enumerate(entries):
        doc_type = entry.get("document_type", "")
        if doc_type != "text":
            continue
        meta = entry.get("metadata", {})
        page = meta.get("content_metadata", {}).get("page_number", -1)
        content = meta.get("content", "").strip()
        if not content:
            continue
        words = _normalize_for_dedup(content)
        if not words:
            continue
        page_groups.setdefault(page, []).append((idx, entry, content, words))

    drop_indices: set[int] = set()
    for page, group in page_groups.items():
        for i in range(len(group)):
            if group[i][0] in drop_indices:
                continue
            for j in range(i + 1, len(group)):
                if group[j][0] in drop_indices:
                    continue
                words_a = group[i][3]
                words_b = group[j][3]
                intersection = words_a & words_b
                union = words_a | words_b
                similarity = len(intersection) / len(union) if union else 0.0
                if similarity >= 0.5:
                    score_a = _text_quality_score(group[i][2])
                    score_b = _text_quality_score(group[j][2])
                    drop_idx = group[j][0] if score_a >= score_b else group[i][0]
                    drop_indices.add(drop_idx)
                    logger.debug(
                        "Dropping near-duplicate entry %d (page %s, similarity=%.2f)",
                        drop_idx,
                        page,
                        similarity,
                    )

    if drop_indices:
        logger.info(
            "Filtered %d near-duplicate entries from %d total",
            len(drop_indices),
            len(entries),
        )
    return [e for idx, e in enumerate(entries) if idx not in drop_indices]


def _sort_key(entry: dict) -> tuple:
    """Order extracted entries by page then spatial position within the page."""
    meta = entry.get("metadata", {})
    content_meta = meta.get("content_metadata", {}) or {}
    page = content_meta.get("page_number", 0)
    hierarchy = content_meta.get("hierarchy", {}) or {}
    x0 = hierarchy.get("x0", 0)
    y0 = hierarchy.get("y0", 0)
    return (page, y0, x0)


def results_to_markdown(results: list[list[dict]]) -> tuple[str, int]:
    """Convert NvIngest JSON results into well-structured Markdown.

    Handles all document_type values returned by NvIngest: structured
    (tables/charts), text, image, and audio. Runs `_dedup_entries`, which is
    `O(n² · |words|)` per page — call from a worker thread when results
    are large.

    Returns:
        (markdown, page_count) where page_count is the number of unique
        pages present in the results.
    """
    if not results or not results[0]:
        return "", 0

    entries = results[0]

    logger.info(
        "results_to_markdown: %d result sets, %d entries in first set",
        len(results),
        len(entries),
    )
    type_counts: dict[str, int] = {}
    for e in entries:
        dt = e.get("document_type", "unknown")
        type_counts[dt] = type_counts.get(dt, 0) + 1
    logger.info("Entry type breakdown: %s", type_counts)

    try:
        entries = sorted(entries, key=_sort_key)
    except (TypeError, KeyError):
        pass

    entries = _dedup_entries(entries)

    md_parts: list[str] = []
    current_page: int | None = None
    seen_pages: set[int] = set()

    for entry in entries:
        meta = entry.get("metadata", {})
        doc_type = entry.get("document_type", "")
        content_meta = meta.get("content_metadata", {})
        page_num = content_meta.get("page_number")

        if isinstance(page_num, int):
            seen_pages.add(page_num)

        if page_num is not None and page_num != current_page:
            if current_page is not None:
                md_parts.append("")
                md_parts.append("---")
                md_parts.append("")
            current_page = page_num

        if doc_type == "text":
            text = clean_markdown(meta.get("content", "").strip())
            if text:
                md_parts.append(text)
                md_parts.append("")

        elif doc_type == "structured":
            table_meta = meta.get("table_metadata", {})
            table_content = table_meta.get("table_content", "").strip()
            if table_content:
                md_parts.append(clean_table_markdown(table_content))
                md_parts.append("")

        elif doc_type == "image":
            image_meta = meta.get("image_metadata", {})
            caption = image_meta.get("caption", "").strip()
            if caption:
                md_parts.append(f"*[Image: {caption}]*")
                md_parts.append("")

        elif doc_type == "audio":
            audio_meta = meta.get("audio_metadata", {})
            transcript = audio_meta.get("audio_transcript", "").strip()
            if transcript:
                md_parts.append(f"> {transcript}")
                md_parts.append("")

    result = "\n".join(md_parts).strip()
    result = _NL_COLLAPSE_RE.sub("\n\n", result)
    return result, len(seen_pages)


def format_single_doc_response(result: IngestResult) -> str:
    """Render an IngestResult into the user-facing string for single-doc mode.

    Preserves the existing UX: when extraction yields markdown content, the
    user sees that content (with a short metadata footer the frontend regex
    can parse). Otherwise falls back to a structured success / partial receipt
    or the error string.
    """
    if result["status"] == "failure":
        return result["error"]

    filename = result["filename"]
    chunks = result["chunks"]
    failures = result["failures"]
    pages = result["pages"]
    collection = result["collection"]
    md = result["markdown"]

    if md:
        footer = (
            f"\n\n---\n\n*1 document indexed • {pages} pages • "
            f"{chunks} chunks in collection '{collection}'*"
        )
        return md + footer

    if result["status"] == "success":
        return (
            f"✅ Successfully processed document '{filename}'\n\n"
            f"- 1 document indexed\n"
            f"- {pages} pages\n"
            f"- {chunks} text chunks\n"
            f"- Stored in collection '{collection}'\n\n"
            "The document is now searchable in your knowledge base!"
        )

    return (
        f"⚠️ Partially processed document '{filename}'\n\n"
        f"- 1 document indexed\n"
        f"- {pages} pages\n"
        f"- {chunks} chunks successful, {failures} failed\n"
        f"- Stored in collection '{collection}'\n\n"
        "Some content may be missing from the search index."
    )


EXTRACT_ENVELOPE_PREFIX = "<<<DAEDALUS_EXTRACT_JSON>>>"
EXTRACT_ENVELOPE_SUFFIX = "<<<END>>>"


def format_extract_response(result: ExtractResult) -> str:
    """Render an ExtractResult into a string the chat pipe can carry.

    On failure, returns the error text so existing frontend error-prefix
    detection keeps working. On success, wraps a JSON envelope between
    sentinels — `/api/document/process` extract-mode looks for the sentinels
    to recover structured fields without parsing arbitrary markdown.
    """
    if result["status"] == "failure":
        return result["error"]
    payload = {
        "filename": result["filename"],
        "pages": result["pages"],
        "markdown": result["markdown"],
        "truncated": result["truncated"],
        "original_chars": result["original_chars"],
    }
    return f"{EXTRACT_ENVELOPE_PREFIX}{json.dumps(payload)}{EXTRACT_ENVELOPE_SUFFIX}"


def format_batch_response(
    total_documents: int,
    successful_documents: list[dict[str, Any]],
    failed_documents: list[dict[str, Any]],
    total_chunks: int,
    total_pages: int,
    collection_name: str,
    chunk_size: int,
    chunk_overlap: int,
) -> str:
    """Render batch results into a user-facing summary.

    The "N documents indexed" and "P pages" phrases are load-bearing: the
    frontend parses them to populate the upload UI metadata badge.
    """
    success_count = len(successful_documents)
    failure_count = len(failed_documents)

    if failure_count == 0:
        msg = (
            f"✅ Successfully processed all {total_documents} documents\n\n"
            f"📄 **Summary:**\n"
            f"- {total_documents} documents indexed\n"
            f"- {total_pages} pages\n"
            f"- Total chunks indexed: {total_chunks}\n"
            f"- Collection: '{collection_name}'\n"
            f"- Chunk size: {chunk_size} with {chunk_overlap} overlap\n\n"
        )
        if len(successful_documents) <= 10:
            msg += "📋 **Processed files:**\n"
            for doc in successful_documents:
                msg += f"- {doc['id']} ({doc['chunks']} chunks, {doc['pages']} pages)\n"
        msg += "\nAll documents are now searchable in your knowledge base!"
        return msg

    if success_count > 0:
        msg = (
            f"⚠️ Partially completed batch processing\n\n"
            f"📄 **Summary:**\n"
            f"- Successfully processed: {success_count}/{total_documents} documents\n"
            f"- {success_count} documents indexed\n"
            f"- {total_pages} pages\n"
            f"- Failed: {failure_count} documents\n"
            f"- Total chunks indexed: {total_chunks}\n"
            f"- Collection: '{collection_name}'\n\n"
        )
        if success_count <= 10:
            msg += "✅ **Successfully processed:**\n"
            for doc in successful_documents:
                msg += f"- {doc['id']} ({doc['chunks']} chunks, {doc['pages']} pages)\n"
            msg += "\n"
        if failure_count <= 10:
            msg += "❌ **Failed documents:**\n"
            for doc in failed_documents:
                msg += f"- {doc['id']}: {doc['error'][:100]}...\n"
        msg += (
            "\nSuccessfully processed documents are searchable in your knowledge base."
        )
        return msg

    msg = (
        f"❌ Failed to process any documents\n\n"
        f"📄 **Summary:**\n"
        f"- Attempted: {total_documents} documents\n"
        f"- All failed\n\n"
    )
    if failure_count <= 10:
        msg += "**Errors:**\n"
        for doc in failed_documents:
            msg += f"- {doc['id']}: {doc['error'][:100]}...\n"
    msg += "\nPlease check the documents and try again."
    return msg


def _extract_dense_dim(
    collection_desc: Any, vector_field: str = "vector"
) -> int | None:
    """Pull the dense-vector dimension from a Milvus describe_collection result.

    Prefers the configured vector field; falls back to the first field that
    declares a ``dim``. Returns None when it cannot be determined.
    """
    fields = (collection_desc or {}).get("fields") or []
    fallback: int | None = None
    for field in fields:
        if not isinstance(field, dict):
            continue
        params = field.get("params") or {}
        dim = params.get("dim")
        if dim is None:
            continue
        try:
            dim_int = int(dim)
        except (TypeError, ValueError):
            continue
        if field.get("name") == vector_field:
            return dim_int
        if fallback is None:
            fallback = dim_int
    return fallback


def _validate_embedding_dimension(
    config: "NvIngestFunctionConfig",
    collection_name: str,
    client: Any = None,
) -> None:
    """F-010: fail fast if the target collection exists with a mismatched dim.

    Writing vectors of one dimension into a collection created at another
    dimension fails at insert time or silently corrupts retrieval. We check
    before ingest and raise a clear error. No-op when the collection does not
    yet exist (vdb_upload creates it at the right dim) or when the dimension
    cannot be read (we log and let vdb_upload surface any real error).
    """
    try:
        if client is None:
            from pymilvus import MilvusClient

            client = MilvusClient(**_milvus_client_kwargs(config))
        if collection_name not in client.list_collections():
            return
        desc = client.describe_collection(collection_name)
    except Exception as exc:  # noqa: BLE001 - never block ingest on a probe error
        logger.warning(
            "Could not verify embedding dimension for collection '%s': %s",
            collection_name,
            exc,
        )
        return

    actual = _extract_dense_dim(desc, getattr(config, "vector_field", "vector"))
    expected = getattr(config, "embedder_dim", None)
    if actual is not None and expected and actual != expected:
        raise ValueError(
            f"Embedding dimension mismatch for Milvus collection "
            f"'{collection_name}': existing dim={actual}, configured "
            f"embedder_dim={expected}. Re-ingesting would corrupt retrieval; "
            f"use a matching embedder or a different collection."
        )


def _dedup_document_refs(document_refs: list) -> list:
    """Drop repeated documentIds within a single ingest batch (F-009).

    Re-embedding the same uploaded document is expensive and duplicates chunks
    in the collection, so a batch that contains the same documentId more than
    once (client retry, UI duplication) should embed it only once. Order is
    preserved and the first occurrence wins. Refs without a documentId are kept
    as-is because they cannot be de-duplicated safely.

    NOTE: this only de-duplicates *within one request*. Cross-request dedup
    (re-uploading / re-ingesting the same document later) requires upsert-by-key
    or a describe/skip against Milvus and must be validated against a live
    NV-Ingest + Milvus deployment before being enabled.
    """
    seen: set[str] = set()
    deduped: list = []
    for ref in document_refs:
        doc_id = ref.get("documentId") if isinstance(ref, dict) else None
        if doc_id:
            if doc_id in seen:
                continue
            seen.add(doc_id)
        deduped.append(ref)
    return deduped


def _build_ingestor(
    *,
    nv_client: NvIngestClient,
    document_bytes: bytes,
    filename: str,
    config: NvIngestFunctionConfig,
    collection_name: str,
    chunk_size: int,
    chunk_overlap: int,
    extract_only: bool = False,
) -> Ingestor:
    """Build a configured Ingestor chain from in-memory bytes.

    Uses `.buffers()` so nothing has to be written to disk, which avoids
    concurrent-same-filename collisions and /data cleanup.

    When `extract_only` is True, the chain stops after extraction (no chunking,
    embedding, or Milvus upload) — used by the inline-mode path that returns
    raw markdown to the chat instead of indexing the document.
    """
    lower = filename.lower()
    is_pdf = lower.endswith(".pdf")
    is_office = lower.endswith((".docx", ".pptx"))
    is_txt = lower.endswith((".txt", ".md", ".html", ".json"))

    if is_txt:
        extract_kwargs: dict[str, Any] = {
            "extract_text": True,
            "extract_tables": False,
            "extract_charts": False,
            "extract_images": False,
        }
    else:
        extract_kwargs: dict[str, Any] = {
            "extract_text": True,
            "extract_tables": True,
            "extract_charts": True,
            "extract_images": True,
            "table_output_format": "markdown",
            "text_depth": "page",
            "extract_method": config.extract_method,
        }
        if is_office:
            extract_kwargs["render_as_pdf"] = True

    ingestor = Ingestor(client=nv_client).buffers([(filename, BytesIO(document_bytes))])

    if is_pdf and config.use_v2_api:
        pages = max(1, min(128, config.pdf_pages_per_chunk))
        ingestor = ingestor.pdf_split_config(pages_per_chunk=pages)

    ingestor = ingestor.extract(**extract_kwargs)

    if config.enable_image_filter:
        ingestor = ingestor.filter(
            min_size=128, min_aspect_ratio=0.2, max_aspect_ratio=5.0
        )

    if config.enable_captioning:
        if config.caption_endpoint_url and config.caption_model_name:
            caption_kwargs: dict[str, Any] = {
                "endpoint_url": config.caption_endpoint_url,
                "model_name": config.caption_model_name,
            }
            if config.caption_api_key:
                caption_kwargs["api_key"] = config.caption_api_key
            ingestor = ingestor.caption(**caption_kwargs)
        else:
            logger.warning(
                "enable_captioning=True but caption_endpoint_url/caption_model_name "
                "are not set — skipping captioning stage."
            )

    if extract_only:
        return ingestor

    # F-010: verify the collection's existing embedding dimension matches the
    # configured embedder before writing to it.
    _validate_embedding_dimension(config, collection_name)

    vdb_auth_kwargs = _milvus_vdb_auth_kwargs(config)

    ingestor = (
        ingestor.split(
            tokenizer=config.tokenizer,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )
        .dedup()
        .embed()
        .vdb_upload(
            collection_name=collection_name,
            milvus_uri=config.milvus_uri,
            gpu_index=False,
            gpu_search=False,
            dense_dim=config.embedder_dim,
            recreate=config.recreate_collection,
            minio_endpoint=config.minio_endpoint,
            bucket_name=config.minio_bucket,
            access_key=config.minio_access_key,
            secret_key=config.minio_secret_key,
            stream=True,
            **vdb_auth_kwargs,
        )
    )
    return ingestor


def _clean_optional_secret(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _milvus_auth_token(config: NvIngestFunctionConfig) -> str | None:
    token = _clean_optional_secret(config.milvus_token)
    if token:
        return token

    username = _clean_optional_secret(config.milvus_username)
    password = _clean_optional_secret(config.milvus_password)
    if username is None and password is None:
        return None
    return f"{username or ''}:{password or ''}"


def _milvus_client_kwargs(config: NvIngestFunctionConfig) -> dict[str, str]:
    kwargs = {"uri": config.milvus_uri}
    token = _milvus_auth_token(config)
    if token:
        kwargs["token"] = token
    return kwargs


def _milvus_vdb_auth_kwargs(config: NvIngestFunctionConfig) -> dict[str, str]:
    username = _clean_optional_secret(config.milvus_username)
    password = _clean_optional_secret(config.milvus_password)

    if (username is None or password is None) and config.milvus_token:
        token = _clean_optional_secret(config.milvus_token)
        if token and ":" in token:
            token_username, token_password = token.split(":", 1)
            username = username or token_username
            password = password if password is not None else token_password

    kwargs: dict[str, str] = {}
    if username is not None:
        kwargs["username"] = username
    if password is not None:
        kwargs["password"] = password
    return kwargs


async def _extract_document_to_markdown(
    *,
    documentRef: dict[str, Any],
    username: str,
    config: NvIngestFunctionConfig,
    redis_getter: Callable[[], Awaitable[redis.Redis]],
    nv_getter: Callable[[], Awaitable[NvIngestClient]],
    char_limit: int | None = INLINE_MARKDOWN_CHAR_LIMIT,
) -> ExtractResult:
    """Fetch an uploaded document from Redis and return its markdown.

    Shared body for both the ``NvIngestDocumentProcessor`` method and the
    ``nv_ingest_function`` closure so the ownership check, size guard, and
    NV-Ingest extraction stay in one place. ``redis_getter``/``nv_getter`` are
    passed as coroutine callables so the Redis client is resolved inside the
    same ``try`` that catches ``redis.RedisError`` (preserving error mapping).

    Output is capped at ``char_limit`` characters with a ``truncated`` flag;
    ``char_limit=None`` returns the full document (used by the download path).
    """
    initial_filename = (
        documentRef.get("filename", "") if isinstance(documentRef, dict) else ""
    )

    def _failure(error: str, filename: str = "") -> ExtractResult:
        return ExtractResult(
            status="failure",
            filename=filename or initial_filename,
            pages=0,
            markdown="",
            truncated=False,
            original_chars=0,
            error=error,
        )

    try:
        if not documentRef or not isinstance(documentRef, dict):
            return _failure("Error: Invalid document reference provided.")
        document_id = documentRef.get("documentId")
        session_id = documentRef.get("sessionId")
        if not document_id or not session_id:
            return _failure(
                "Error: Document reference must contain documentId and sessionId."
            )
        if not username:
            return _failure("Error: Valid username required for document extraction.")

        redis_key = f"document:{session_id}:{document_id}"
        try:
            redis_client = await redis_getter()
            document_data_json = await asyncio.to_thread(
                redis_client.execute_command, "JSON.GET", redis_key
            )
            if not document_data_json:
                logger.error(
                    "Document %s not found in Redis (key: %s)",
                    document_id,
                    redis_key,
                )
                return _failure(
                    "Error: Document not found in storage. "
                    "The file may have expired or the session may be "
                    "invalid. Please try uploading the document again."
                )

            document_record = json.loads(document_data_json)
            if not _can_access_stored_document(document_record, username):
                logger.warning(
                    "Document %s accessed by %s but belongs to another user",
                    document_id,
                    username,
                )
                return _failure(
                    "Error: You do not have access to this document. "
                    "Please upload the document again from your account."
                )

            document_base64 = document_record.get("data")
            filename = document_record.get("filename", f"{document_id}.bin")
            if not document_base64:
                return _failure(
                    "Error: Retrieved document data is empty.",
                    filename=filename,
                )
            max_bytes = document_ingest_max_size_bytes()
            size_error = _document_size_error(document_base64, max_bytes)
            if size_error is not None:
                logger.warning(
                    "Document %s (%s) exceeds max ingest size %d bytes",
                    document_id,
                    filename,
                    max_bytes,
                )
                return _failure(size_error, filename=filename)
            document_bytes = base64.b64decode(document_base64)
        except redis.RedisError as e:
            logger.error("Redis error retrieving document: %s", e)
            return _failure(f"Error accessing document storage: {str(e)}")

        logger.info(
            "Extracting %s for user %s (size=%d bytes)",
            filename,
            username,
            len(document_bytes),
        )

        nv_client = await nv_getter()

        def run_extract() -> tuple[str, int]:
            ingestor = _build_ingestor(
                nv_client=nv_client,
                document_bytes=document_bytes,
                filename=filename,
                config=config,
                collection_name="",
                chunk_size=config.chunk_size,
                chunk_overlap=config.chunk_overlap,
                extract_only=True,
            )
            with ingestor as ctx:
                results, _failures = ctx.ingest(
                    show_progress=False, return_failures=True
                )
            md, page_count = results_to_markdown(results)
            return md, page_count

        ingest_timeout = max(1.0, config.ingest_timeout_seconds)
        try:
            raw_md, page_count = await asyncio.wait_for(
                asyncio.to_thread(run_extract),
                timeout=ingest_timeout,
            )
        except TimeoutError:
            logger.error(
                "NV-Ingest extract timed out after %.1fs for %s",
                ingest_timeout,
                filename,
            )
            return _failure(
                "Error extracting document with NvIngest: "
                f"timed out after {ingest_timeout:.0f} seconds.",
                filename=filename,
            )
        except Exception as e:
            logger.error(
                "NV-Ingest extract error for %s: %s", filename, e, exc_info=True
            )
            return _failure(
                f"Error extracting document with NvIngest: {str(e)}",
                filename=filename,
            )

        original_chars = len(raw_md)
        markdown, truncated = _apply_char_limit(raw_md, char_limit)

        logger.info(
            "Extracted %s: %d pages, %d chars (truncated=%s)",
            filename,
            page_count,
            original_chars,
            truncated,
        )

        return ExtractResult(
            status="success",
            filename=filename,
            pages=page_count,
            markdown=markdown,
            truncated=truncated,
            original_chars=original_chars,
            error="",
        )

    except Exception as e:
        logger.error("Unexpected error in extract_document: %s", e, exc_info=True)
        return _failure(f"An unexpected error occurred: {str(e)}")


class NvIngestDocumentProcessor:
    """Authoritative ingestion runner shared by NAT tools and HTTP routes."""

    def __init__(self, config: NvIngestFunctionConfig):
        self.config = config
        self._client_cache: dict[str, Any] = {}
        self._client_lock = asyncio.Lock()
        self._ingest_locks: dict[str, asyncio.Lock] = {}
        self._ingest_locks_guard = asyncio.Lock()

    async def _get_redis(self) -> redis.Redis:
        if "redis" not in self._client_cache:
            async with self._client_lock:
                if "redis" not in self._client_cache:
                    self._client_cache["redis"] = redis.from_url(
                        self.config.redis_url,
                        decode_responses=False,
                        socket_timeout=self.config.redis_socket_timeout,
                        socket_connect_timeout=self.config.redis_connect_timeout,
                        retry_on_timeout=True,
                    )
        return self._client_cache["redis"]

    async def _get_nv_client(self) -> NvIngestClient:
        if "nv_ingest" not in self._client_cache:
            async with self._client_lock:
                if "nv_ingest" not in self._client_cache:
                    kwargs: dict[str, Any] = {
                        "message_client_port": self.config.nv_ingest_port,
                        "message_client_hostname": self.config.nv_ingest_host,
                        "worker_pool_size": self.config.worker_pool_size,
                    }
                    if self.config.use_v2_api:
                        kwargs["message_client_kwargs"] = {"api_version": "v2"}
                    self._client_cache["nv_ingest"] = NvIngestClient(**kwargs)
        return self._client_cache["nv_ingest"]

    async def _get_collection_ingest_lock(self, collection_name: str) -> asyncio.Lock:
        async with self._ingest_locks_guard:
            lock = self._ingest_locks.get(collection_name)
            if lock is None:
                lock = asyncio.Lock()
                self._ingest_locks[collection_name] = lock
            return lock

    async def process_document(
        self,
        documentRef: dict[str, Any],
        username: str,
        collection_name: str | None = None,
        collection_scope: str | None = None,
        provenance: dict[str, Any] | None = None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> IngestResult:
        """Processes a document from Redis and ingests it into Milvus."""
        config = self.config
        logger.info(
            "process_document called with: documentRef=%s, username=%s, collection_name=%s",
            documentRef,
            username,
            collection_name,
        )

        chunk_size = chunk_size or config.chunk_size
        chunk_overlap = chunk_overlap or config.chunk_overlap

        collection_name = resolve_user_collection_name(
            collection_name,
            username,
            config.default_collection_name,
        )
        try:
            resolved_scope = validate_user_collection_write_scope(
                collection_name,
                collection_scope,
            )
        except ValueError as e:
            resolved_scope = "user"
            scope_error = str(e)
        else:
            scope_error = ""

        initial_filename = (
            documentRef.get("filename", "") if isinstance(documentRef, dict) else ""
        )
        loop = asyncio.get_running_loop()

        def _failure(error: str, filename: str = "") -> IngestResult:
            return IngestResult(
                status="failure",
                filename=filename or initial_filename,
                chunks=0,
                failures=0,
                pages=0,
                collection=collection_name or "",
                markdown="",
                error=error,
            )

        async def _emit_stage(
            phase: str,
            filename: str | None = None,
            message: str | None = None,
            **extra: Any,
        ) -> None:
            if progress_callback is None:
                return
            payload: IngestProgressEvent = {"phase": phase}
            if filename is not None:
                payload["current"] = filename
            if message:
                payload["message"] = message
            payload.update(extra)
            try:
                await progress_callback(payload)
            except Exception:
                logger.exception("Ingestion progress callback failed; continuing")

        def _emit_stage_from_thread(
            phase: str,
            filename: str | None = None,
            message: str | None = None,
            **extra: Any,
        ) -> None:
            if progress_callback is None:
                return
            future = asyncio.run_coroutine_threadsafe(
                _emit_stage(phase, filename, message, **extra),
                loop,
            )
            try:
                future.result(timeout=2)
            except Exception:
                logger.debug(
                    "Timed out forwarding ingest progress event", exc_info=True
                )

        try:
            if scope_error:
                return _failure(f"Error: {scope_error}")

            if not documentRef or not isinstance(documentRef, dict):
                return _failure("Error: Invalid document reference provided.")

            document_id = documentRef.get("documentId")
            session_id = documentRef.get("sessionId")

            if not document_id or not session_id:
                return _failure(
                    "Error: Document reference must contain documentId and sessionId."
                )

            if not username:
                return _failure(
                    "Error: Valid username required for document processing."
                )

            if not collection_name:
                return _failure("Error: Collection name must be specified.")

            await _emit_stage(
                "fetching",
                initial_filename or document_id,
                "Fetching upload from session storage",
            )

            logger.info(
                "Processing document %s for user %s into %s collection %s",
                document_id,
                username,
                resolved_scope,
                collection_name,
            )
            if provenance:
                logger.info(
                    "Document ingestion provenance: %s",
                    json.dumps(provenance, sort_keys=True)[:1000],
                )

            redis_key = f"document:{session_id}:{document_id}"
            fetch_start = time.time()
            try:
                redis_client = await self._get_redis()
                document_data_json = await asyncio.to_thread(
                    redis_client.execute_command, "JSON.GET", redis_key
                )

                if not document_data_json:
                    logger.error(
                        "Document %s not found in Redis (key: %s)",
                        document_id,
                        redis_key,
                    )
                    return _failure(
                        "Error: Document not found in storage. "
                        "The file may have expired or the session may be "
                        "invalid. Please try uploading the document again."
                    )

                document_record = json.loads(document_data_json)
                if not _can_access_stored_document(document_record, username):
                    document_user_id = str(document_record.get("userId") or "").strip()
                    logger.warning(
                        "Document %s belongs to user %s but was requested by %s",
                        document_id,
                        document_user_id,
                        username,
                    )
                    return _failure(
                        "Error: You do not have access to this document. "
                        "Please upload the document again from your account."
                    )

                document_base64 = document_record.get("data")
                filename = document_record.get("filename", f"{document_id}.bin")

                if not document_base64:
                    logger.error("Document data is empty for document %s", document_id)
                    return _failure(
                        "Error: Retrieved document data is empty.",
                        filename=filename,
                    )

                max_bytes = document_ingest_max_size_bytes()
                size_error = _document_size_error(document_base64, max_bytes)
                if size_error is not None:
                    logger.warning(
                        "Document %s (%s) exceeds max ingest size %d bytes",
                        document_id,
                        filename,
                        max_bytes,
                    )
                    return _failure(size_error, filename=filename)

                document_bytes = base64.b64decode(document_base64)
            except redis.RedisError as e:
                logger.error("Redis error retrieving document: %s", e)
                return _failure(f"Error accessing document storage: {str(e)}")
            except Exception as e:
                logger.error("Error processing document data: %s", e)
                return _failure(f"Error processing document data: {str(e)}")

            logger.info(
                "Fetched %s from Redis in %.2fs (size=%d bytes)",
                filename,
                time.time() - fetch_start,
                len(document_bytes),
            )
            await _emit_stage(
                "fetched",
                filename,
                f"Fetched {filename} from Redis ({len(document_bytes)} bytes)",
            )

            await _emit_stage("preparing", filename, "Preparing NV-Ingest pipeline")
            nv_client = await self._get_nv_client()

            def run_ingest_with_postproc() -> tuple[str, int, int, int]:
                _emit_stage_from_thread(
                    "preparing",
                    filename,
                    "Building NV-Ingest extraction and Milvus upload pipeline",
                )
                ingestor = _build_ingestor(
                    nv_client=nv_client,
                    document_bytes=document_bytes,
                    filename=filename,
                    config=config,
                    collection_name=collection_name,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                )

                class _BatchFinishedHandler(logging.Handler):
                    def __init__(self) -> None:
                        super().__init__(level=logging.INFO)
                        self._seen = False

                    def emit(self, record: logging.LogRecord) -> None:
                        if self._seen:
                            return
                        try:
                            message = record.getMessage()
                        except Exception:
                            return
                        if "Batch processing finished" not in message:
                            return
                        self._seen = True
                        _emit_stage_from_thread(
                            "indexing",
                            filename,
                            ("NV-Ingest extraction finished; writing chunks to Milvus"),
                        )

                progress_log_handler = _BatchFinishedHandler()
                client_logger = logging.getLogger("nv_ingest_client.client.client")
                client_logger.addHandler(progress_log_handler)
                try:
                    with ingestor as ctx:
                        logger.info("Starting document ingestion for %s...", filename)
                        _emit_stage_from_thread(
                            "processing",
                            filename,
                            (
                                "NV-Ingest is extracting, chunking, and "
                                "embedding the document"
                            ),
                        )
                        results, failures = ctx.ingest(
                            show_progress=False, return_failures=True
                        )
                finally:
                    client_logger.removeHandler(progress_log_handler)
                _emit_stage_from_thread(
                    "postprocessing",
                    filename,
                    "Converting extracted content to Markdown",
                )
                md, page_count = results_to_markdown(results)
                success_count = len(results[0]) if results and results[0] else 0
                failure_count = len(failures[0]) if failures and failures[0] else 0
                _emit_stage_from_thread(
                    "postprocessed",
                    filename,
                    f"Prepared {success_count} chunks from {page_count} pages",
                    chunks=success_count,
                    pages=page_count,
                    failures=failure_count,
                )
                return md, page_count, success_count, failure_count

            ingest_start = time.time()
            success_payload: tuple[str, int, int, int] | None = None
            last_exc: Exception | None = None
            ingest_timeout = max(1.0, config.ingest_timeout_seconds)
            collection_ingest_lock = await self._get_collection_ingest_lock(
                collection_name
            )
            for attempt in range(config.ingest_max_retries + 1):
                try:
                    if collection_ingest_lock.locked():
                        await _emit_stage(
                            "waiting",
                            filename,
                            "Waiting for the collection write lock",
                            attempt=attempt + 1,
                        )
                    async with collection_ingest_lock:
                        await _emit_stage(
                            "submitting",
                            filename,
                            "Submitting document to NV-Ingest",
                            attempt=attempt + 1,
                        )
                        success_payload = await asyncio.wait_for(
                            asyncio.to_thread(run_ingest_with_postproc),
                            timeout=ingest_timeout,
                        )
                    break
                except TimeoutError as e:
                    last_exc = e
                    logger.error(
                        "NV-Ingest timed out after %.1fs for %s",
                        ingest_timeout,
                        filename,
                    )
                    return _failure(
                        "Error processing document with NvIngest: "
                        f"timed out after {ingest_timeout:.0f} seconds.",
                        filename=filename,
                    )
                except Exception as e:
                    last_exc = e
                    if attempt < config.ingest_max_retries:
                        await _emit_stage(
                            "retrying",
                            filename,
                            (
                                f"NV-Ingest attempt {attempt + 1}/"
                                f"{config.ingest_max_retries + 1} failed; retrying"
                            ),
                            attempt=attempt + 1,
                        )
                        logger.warning(
                            "NV-Ingest attempt %d/%d failed for %s: %s — retrying in %.1fs",
                            attempt + 1,
                            config.ingest_max_retries + 1,
                            filename,
                            e,
                            config.ingest_retry_delay,
                        )
                        await asyncio.sleep(config.ingest_retry_delay)

            if success_payload is None:
                logger.error(
                    "NV-Ingest processing error after %d attempts: %s",
                    config.ingest_max_retries + 1,
                    last_exc,
                    exc_info=True,
                )
                return _failure(
                    f"Error processing document with NvIngest: {str(last_exc)}",
                    filename=filename,
                )

            result_md, page_count, success_count, failure_count = success_payload

            logger.info(
                "Completed %s in %.2fs: %d chunks, %d failures, %d pages",
                filename,
                time.time() - ingest_start,
                success_count,
                failure_count,
                page_count,
            )

            return IngestResult(
                status="success" if failure_count == 0 else "partial",
                filename=filename,
                chunks=success_count,
                failures=failure_count,
                pages=page_count,
                collection=collection_name,
                markdown=result_md,
                error="",
            )

        except Exception as e:
            logger.error("Unexpected error in process_document: %s", e, exc_info=True)
            return _failure(f"An unexpected error occurred: {str(e)}")

    async def extract_document(
        self,
        documentRef: dict[str, Any],
        username: str,
        char_limit: int | None = INLINE_MARKDOWN_CHAR_LIMIT,
    ) -> ExtractResult:
        """Run NV-Ingest extraction and return markdown without indexing.

        Used by the chat "inline" mode and the HTTP routes. Delegates to the
        shared `_extract_document_to_markdown` helper. Output is capped at
        `char_limit` chars with a truncation flag (protecting the chat context
        window); `char_limit=None` returns the full document, which the
        doc-to-markdown download path uses.
        """
        return await _extract_document_to_markdown(
            documentRef=documentRef,
            username=username,
            config=self.config,
            redis_getter=self._get_redis,
            nv_getter=self._get_nv_client,
            char_limit=char_limit,
        )

    async def process_multiple_documents(
        self,
        documentRefs: list[dict[str, Any]],
        username: str,
        collection_name: str | None = None,
        collection_scope: str | None = None,
        provenance: dict[str, Any] | None = None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> str:
        """Processes multiple documents from Redis and ingests them into Milvus.

        If ``progress_callback`` is provided, it is invoked after each document
        phase change with a structured payload containing ``completed``,
        ``total``, ``current``, ``phase``, ``message``, and ``percent``.
        Exceptions raised by the callback are logged but do not interrupt ingestion.
        """
        config = self.config
        logger.info(
            "process_multiple_documents called with: documentRefs=%s, username=%s, collection_name=%s",
            str(documentRefs)[:500] if documentRefs else "None",
            username,
            collection_name,
        )

        if not documentRefs or not isinstance(documentRefs, list):
            logger.error("Invalid document references: %s", type(documentRefs))
            return (
                "Error: Invalid document references provided. "
                "Expected a list of document references."
            )

        if not username:
            logger.error("No username provided")
            return "Error: Valid username required for document processing."

        # F-009: drop repeated documentIds within this batch so the same upload
        # is not embedded (and billed) twice.
        documentRefs = _dedup_document_refs(documentRefs)

        max_batch = max(1, config.max_documents_per_batch)
        if len(documentRefs) > max_batch:
            logger.info(
                "Processing %d documents in internal batches of %d",
                len(documentRefs),
                max_batch,
            )

        collection_name = resolve_user_collection_name(
            collection_name,
            username,
            config.default_collection_name,
        )
        try:
            resolved_scope = validate_user_collection_write_scope(
                collection_name,
                collection_scope,
            )
        except ValueError as e:
            return f"Error: {e}"

        total_documents = len(documentRefs)
        successful_documents: list[dict[str, Any]] = []
        failed_documents: list[dict[str, Any]] = []
        total_chunks = 0
        total_pages = 0

        logger.info(
            "Starting batch processing of %d documents for user %s into %s collection %s "
            "(concurrency=%d, recreate=%s)",
            total_documents,
            username,
            resolved_scope,
            collection_name,
            config.batch_concurrency,
            config.recreate_collection,
        )
        if provenance:
            logger.info(
                "Batch document ingestion provenance: %s",
                json.dumps(provenance, sort_keys=True)[:1000],
            )
        start_time = time.time()

        sync_prefix = 1 if config.recreate_collection and total_documents > 1 else 0
        concurrency = max(1, config.batch_concurrency)
        sem = asyncio.Semaphore(concurrency)

        def _completed_count() -> int:
            return len(successful_documents) + len(failed_documents)

        def _percent_for(completed: int, phase: str) -> int:
            if total_documents <= 0:
                return 0
            if completed >= total_documents:
                return 100
            phase_weight = _PROGRESS_PHASE_WEIGHTS.get(phase, 0.0)
            percent = int(((completed + phase_weight) / total_documents) * 100)
            return max(0, min(99, percent))

        async def _emit_progress(
            *,
            current_filename: str | None,
            phase: str,
            current_index: int | None = None,
            message: str | None = None,
            completed: int | None = None,
            **extra: Any,
        ) -> None:
            if progress_callback is None:
                return
            completed_count = _completed_count() if completed is None else completed
            payload: IngestProgressEvent = {
                "completed": completed_count,
                "total": total_documents,
                "current": current_filename,
                "percent": _percent_for(completed_count, phase),
                "phase": phase,
            }
            if current_index is not None:
                payload["currentIndex"] = current_index
            if message:
                payload["message"] = message
            payload.update(extra)
            try:
                await progress_callback(payload)
            except Exception:
                logger.exception("Ingestion progress callback failed; continuing")

        async def _one(
            idx: int, documentRef: dict[str, Any]
        ) -> tuple[int, str, IngestResult | Exception]:
            ref_filename = documentRef.get(
                "filename", documentRef.get("documentId", f"Document_{idx}")
            )
            logger.info(
                "Processing document %d of %d: %s",
                idx,
                total_documents,
                ref_filename,
            )
            t0 = time.time()
            try:
                await _emit_progress(
                    current_filename=ref_filename,
                    phase="queued",
                    current_index=idx,
                    message=f"Starting document {idx} of {total_documents}",
                )

                async def _doc_progress(stage: IngestProgressEvent) -> None:
                    extra = {
                        key: value
                        for key, value in stage.items()
                        if key
                        not in {
                            "completed",
                            "total",
                            "current",
                            "currentIndex",
                            "percent",
                            "phase",
                            "message",
                        }
                    }
                    await _emit_progress(
                        current_filename=stage.get("current") or ref_filename,
                        phase=stage.get("phase") or "processing",
                        current_index=idx,
                        message=stage.get("message"),
                        **extra,
                    )

                async with sem:
                    result = await self.process_document(
                        documentRef=documentRef,
                        username=username,
                        collection_name=collection_name,
                        collection_scope=resolved_scope,
                        provenance=provenance,
                        chunk_size=chunk_size,
                        chunk_overlap=chunk_overlap,
                        progress_callback=_doc_progress,
                    )
                logger.info(
                    "Document %d completed in %.2fs: status=%s chunks=%d pages=%d",
                    idx,
                    time.time() - t0,
                    result["status"],
                    result["chunks"],
                    result["pages"],
                )
                return idx, ref_filename, result
            except Exception as e:
                logger.error(
                    "Error processing document %s: %s",
                    documentRef.get("documentId", "unknown"),
                    e,
                    exc_info=True,
                )
                return idx, ref_filename, e

        def _accumulate(
            ref_filename: str, outcome: IngestResult | Exception
        ) -> dict[str, Any]:
            nonlocal total_chunks, total_pages
            if isinstance(outcome, Exception):
                failed_documents.append({"id": ref_filename, "error": str(outcome)})
                logger.warning("Document %s failed: %s", ref_filename, outcome)
                return {
                    "filename": ref_filename,
                    "phase": "failed",
                    "message": f"Failed {ref_filename}: {_truncate_error(outcome)}",
                }
            filename = outcome["filename"] or ref_filename
            if outcome["status"] in ("success", "partial"):
                total_chunks += outcome["chunks"]
                total_pages += outcome["pages"]
                successful_documents.append(
                    {
                        "id": filename,
                        "chunks": outcome["chunks"],
                        "pages": outcome["pages"],
                        "status": outcome["status"],
                    }
                )
                return {
                    "filename": filename,
                    "phase": "completed",
                    "message": (
                        f"Indexed {filename}: {outcome['chunks']} chunks, "
                        f"{outcome['pages']} pages"
                    ),
                    "chunks": outcome["chunks"],
                    "pages": outcome["pages"],
                    "failures": outcome["failures"],
                }
            else:
                failed_documents.append({"id": filename, "error": outcome["error"]})
                logger.warning("Document %s failed: %s", filename, outcome["error"])
                return {
                    "filename": filename,
                    "phase": "failed",
                    "message": f"Failed {filename}: {_truncate_error(outcome['error'])}",
                }

        def _metric_kwargs(status_event: dict[str, Any]) -> dict[str, Any]:
            return {
                key: status_event[key]
                for key in ("chunks", "pages", "failures")
                if key in status_event
            }

        def _is_timeout_failure(outcome: IngestResult | Exception) -> bool:
            if isinstance(outcome, Exception):
                return isinstance(outcome, TimeoutError)
            return (
                outcome["status"] == "failure"
                and "timed out" in outcome["error"].lower()
            )

        def _mark_skipped_due_to_timeout(start_idx: int, stop_idx: int) -> int:
            skipped_count = 0
            for skipped_idx in range(start_idx, stop_idx):
                skipped_ref = documentRefs[skipped_idx]
                skipped_name = skipped_ref.get(
                    "filename",
                    skipped_ref.get("documentId", f"Document_{skipped_idx + 1}"),
                )
                failed_documents.append(
                    {
                        "id": skipped_name,
                        "error": (
                            "Skipped because a prior document ingest timed out; "
                            "NV-Ingest or Milvus may be unavailable."
                        ),
                    }
                )
                skipped_count += 1
            return skipped_count

        await _emit_progress(
            current_filename=None,
            phase="queued",
            message=(
                f"Queued {total_documents} document"
                f"{'' if total_documents == 1 else 's'} for ingestion"
            ),
        )

        for idx in range(sync_prefix):
            _idx, ref_filename, outcome = await _one(idx + 1, documentRefs[idx])
            status_event = _accumulate(ref_filename, outcome)
            await _emit_progress(
                current_filename=status_event["filename"],
                phase=status_event["phase"],
                current_index=idx + 1,
                message=status_event["message"],
                **_metric_kwargs(status_event),
            )
            if _is_timeout_failure(outcome):
                skipped_count = _mark_skipped_due_to_timeout(idx + 1, total_documents)
                await _emit_progress(
                    current_filename=None,
                    phase="skipped",
                    message=f"Skipped {skipped_count} remaining documents after timeout",
                )
                break

        skipped_remaining = (
            len(successful_documents) + len(failed_documents) >= total_documents
        )

        for start in range(sync_prefix, total_documents, max_batch):
            if skipped_remaining:
                break
            stop = min(start + max_batch, total_documents)
            logger.info(
                "Starting internal document batch %d-%d of %d",
                start + 1,
                stop,
                total_documents,
            )
            if concurrency == 1:
                for idx in range(start, stop):
                    _idx, ref_filename, outcome = await _one(idx + 1, documentRefs[idx])
                    status_event = _accumulate(ref_filename, outcome)
                    await _emit_progress(
                        current_filename=status_event["filename"],
                        phase=status_event["phase"],
                        current_index=idx + 1,
                        message=status_event["message"],
                        **_metric_kwargs(status_event),
                    )
                    if _is_timeout_failure(outcome):
                        skipped_count = _mark_skipped_due_to_timeout(
                            idx + 1, total_documents
                        )
                        await _emit_progress(
                            current_filename=None,
                            phase="skipped",
                            message=(
                                f"Skipped {skipped_count} remaining documents "
                                "after timeout"
                            ),
                        )
                        skipped_remaining = True
                        break
                continue

            batch = [_one(idx + 1, documentRefs[idx]) for idx in range(start, stop)]
            for _idx, ref_filename, outcome in await asyncio.gather(*batch):
                status_event = _accumulate(ref_filename, outcome)
                await _emit_progress(
                    current_filename=status_event["filename"],
                    phase=status_event["phase"],
                    current_index=_idx,
                    message=status_event["message"],
                    **_metric_kwargs(status_event),
                )
                if _is_timeout_failure(outcome) and not skipped_remaining:
                    skipped_count = _mark_skipped_due_to_timeout(stop, total_documents)
                    await _emit_progress(
                        current_filename=None,
                        phase="skipped",
                        message=f"Skipped {skipped_count} remaining documents after timeout",
                    )
                    skipped_remaining = True

        await _emit_progress(
            current_filename=None,
            phase="finalizing",
            message=f"Finalizing ingestion summary for {collection_name}",
        )

        result_message = format_batch_response(
            total_documents=total_documents,
            successful_documents=successful_documents,
            failed_documents=failed_documents,
            total_chunks=total_chunks,
            total_pages=total_pages,
            collection_name=collection_name,
            chunk_size=chunk_size or config.chunk_size,
            chunk_overlap=chunk_overlap or config.chunk_overlap,
        )

        total_time = time.time() - start_time
        logger.info(
            "Batch processing completed in %.2fs. Success: %d, Failed: %d",
            total_time,
            len(successful_documents),
            len(failed_documents),
        )
        logger.info(
            "Returning result message (length=%d): %s",
            len(result_message),
            result_message[:500],
        )
        return result_message


# --- Registration ------------------------------------------------------------


@register_function(
    config_type=NvIngestFunctionConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN]
)
async def nv_ingest_function(
    config: NvIngestFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    """Registers a document processing function using NvIngest.

    Supports all NvIngest-compatible file types (PDF, DOCX, PPTX, images, etc.)
    and returns extracted content as Markdown.
    """

    # All ingestion state (Redis/NV-Ingest clients and per-collection locks)
    # belongs to the structured processor. The adapter retains a separate,
    # search-only cache for Milvus and the retriever.
    document_processor = NvIngestDocumentProcessor(config)
    _retrieval_client_cache: dict[str, Any] = {}
    _retrieval_client_lock = asyncio.Lock()

    async def _get_milvus() -> MilvusClient:
        if "milvus" not in _retrieval_client_cache:
            async with _retrieval_client_lock:
                if "milvus" not in _retrieval_client_cache:
                    _retrieval_client_cache["milvus"] = MilvusClient(
                        **_milvus_client_kwargs(config)
                    )
        return _retrieval_client_cache["milvus"]

    async def _get_retriever():
        if "retriever" not in _retrieval_client_cache:
            async with _retrieval_client_lock:
                if "retriever" not in _retrieval_client_cache:
                    from smart_milvus.smart_milvus_function import MilvusRetriever

                    embedder = await builder.get_embedder(
                        embedder_name=config.embedder_name,
                        wrapper_type=LLMFrameworkEnum.LANGCHAIN,
                    )
                    milvus_client = _retrieval_client_cache.get("milvus")
                    if milvus_client is None:
                        milvus_client = MilvusClient(**_milvus_client_kwargs(config))
                        _retrieval_client_cache["milvus"] = milvus_client
                    reranker_config = None
                    if config.use_reranker and config.reranker_endpoint:
                        reranker_config = {
                            "endpoint": config.reranker_endpoint,
                            "model": config.reranker_model,
                            "top_n": config.reranker_top_n,
                            "api_key": config.reranker_api_key,
                        }
                    _retrieval_client_cache["retriever"] = MilvusRetriever(
                        client=milvus_client,
                        embedder=embedder,
                        content_field=config.content_field,
                        database_name=(
                            config.database_name
                            if config.database_name != "default"
                            else None
                        ),
                        vector_field_name=config.vector_field,
                        reranker_config=reranker_config,
                    )
        return _retrieval_client_cache["retriever"]

    async def list_collections(username: str) -> str:
        """List only collections the authenticated user is allowed to read."""
        try:
            milvus_client = await _get_milvus()
            collections = await asyncio.to_thread(milvus_client.list_collections)
            private_collection = resolve_user_collection_name(
                None,
                username,
                config.default_collection_name,
            )
            allowed_collections = SHARED_COLLECTION_NAMES | {private_collection}
            visible_collections = sorted(
                collection
                for collection in collections
                if collection in allowed_collections
            )
            logger.info(
                "Found %d user-visible collections in Milvus",
                len(visible_collections),
            )
            if not visible_collections:
                return "No collections found."
            return "Available collections:\n" + "\n".join(visible_collections)
        except Exception as e:
            logger.error("Error listing Milvus collections: %s", e)
            return "Error listing Milvus collections."

    async def nv_ingest_router(input_message: dict[str, Any]) -> str:
        """Routes NV Ingest requests to the appropriate function."""
        logger.info(
            "nv_ingest_router called with input_message: %s", str(input_message)[:500]
        )

        if isinstance(input_message, dict):
            if "input_message" in input_message and isinstance(
                input_message["input_message"], dict
            ):
                inner_request = input_message["input_message"]
            elif "request" in input_message and isinstance(
                input_message["request"], dict
            ):
                inner_request = input_message["request"]
            else:
                inner_request = input_message

            logger.info("Inner request structure: %s", str(inner_request)[:500])

            metadata = inner_request.get("metadata", {})
            if not isinstance(metadata, dict):
                metadata = {}

            def get_param(key: str, default: str | None = None) -> str | None:
                value = inner_request.get(key)
                if value:
                    return value
                return metadata.get(key, default)

            try:
                username = resolve_authenticated_user_id(get_param("username", ""))
            except ValueError as exc:
                logger.warning(
                    "Denied document request without trusted identity: %s", exc
                )
                return f"Error: user document request denied: {exc}."

            provenance = inner_request.get("provenance") or metadata.get("provenance")
            if not isinstance(provenance, dict):
                provenance = None

            if "documentRefs" in inner_request:
                documentRefs = inner_request.get("documentRefs")
                logger.info(
                    "Processing multiple documents: %d files",
                    len(documentRefs) if isinstance(documentRefs, list) else 0,
                )
                return await document_processor.process_multiple_documents(
                    documentRefs=documentRefs,
                    username=username,
                    collection_name=get_param("collection_name"),
                    collection_scope=get_param("collection_scope"),
                    provenance=provenance,
                    chunk_size=inner_request.get("chunk_size"),
                    chunk_overlap=inner_request.get("chunk_overlap"),
                )

            elif "documentRef" in inner_request:
                ingest_result = await document_processor.process_document(
                    documentRef=inner_request.get("documentRef"),
                    username=username,
                    collection_name=get_param("collection_name"),
                    collection_scope=get_param("collection_scope"),
                    provenance=provenance,
                    chunk_size=inner_request.get("chunk_size"),
                    chunk_overlap=inner_request.get("chunk_overlap"),
                )
                return format_single_doc_response(ingest_result)

            return await list_collections(username)

        return "Error: input_message must be an object."

    async def search_documents(
        query: str,
        username: str,
        collection_name: str | None = None,
        top_k: int | None = None,
        filters: str | None = None,
    ) -> str:
        """Search previously ingested documents for one user."""
        resolved_collection = resolve_user_collection_name(
            collection_name,
            username,
            config.default_collection_name,
        )
        resolved_query = query.strip() if isinstance(query, str) else ""
        if not resolved_query:
            resolved_query = "summary of the document"

        retriever = await _get_retriever()
        search_kwargs: dict[str, Any] = {
            "collection_name": resolved_collection,
            "top_k": top_k or config.top_k,
            "filters": filters,
            "output_fields": config.output_fields,
            "search_params": config.search_params,
        }
        if config.distance_cutoff is not None:
            search_kwargs["distance_cutoff"] = config.distance_cutoff

        output = await retriever.search(query=resolved_query, **search_kwargs)
        return format_user_document_search_results(output, resolved_collection)

    async def user_document_tool(
        operation: str = "search",
        query: str = "",
        username: str = "",
        collection_name: str | None = None,
        collection_scope: str | None = None,
        provenance: dict[str, Any] | None = None,
        documentRef: dict[str, Any] | None = None,
        documentRefs: list[dict[str, Any]] | None = None,
        top_k: int | None = None,
        filters: str | None = None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
        input_message: dict[str, Any] | None = None,
    ) -> str:
        """Ingest or search the user's uploaded documents.

        Args:
            operation: ingest, extract, search, or list_collections.
            query: Search query for operation='search'.
            username: Deprecated direct-call identity assertion. The LLM-facing
                schema omits it; HTTP requests use the trusted NAT context.
            collection_name: Optional explicit Milvus collection.
            collection_scope: Optional expected scope, either shared or user.
            provenance: Optional audit metadata for ingestion requests.
            documentRef: Single uploaded document reference for operation='ingest'
                or operation='extract'.
            documentRefs: Multiple uploaded document references for operation='ingest'.
            top_k: Optional search result count.
            filters: Optional Milvus filter expression.
            chunk_size: Optional ingest chunk size override.
            chunk_overlap: Optional ingest chunk overlap override.
            input_message: Backward-compatible raw request object.
        """
        if input_message is not None:
            return await nv_ingest_router(input_message)

        op = (operation or "search").strip().lower()
        if op not in {"ingest", "extract", "search", "list_collections"}:
            return (
                "Error: operation must be one of ingest, extract, search, "
                "list_collections."
            )

        try:
            effective_username = resolve_authenticated_user_id(username)
        except ValueError as exc:
            logger.warning("Denied document request without trusted identity: %s", exc)
            return f"Error: user document request denied: {exc}."

        if op == "search":
            return await search_documents(
                query=query,
                username=effective_username,
                collection_name=collection_name,
                top_k=top_k,
                filters=filters,
            )
        if op == "ingest":
            if documentRefs:
                return await document_processor.process_multiple_documents(
                    documentRefs=documentRefs,
                    username=effective_username,
                    collection_name=collection_name,
                    collection_scope=collection_scope,
                    provenance=provenance,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                )
            if documentRef:
                ingest_result = await document_processor.process_document(
                    documentRef=documentRef,
                    username=effective_username,
                    collection_name=collection_name,
                    collection_scope=collection_scope,
                    provenance=provenance,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                )
                return format_single_doc_response(ingest_result)
            return "Error: documentRef or documentRefs is required for ingestion."
        if op == "extract":
            if documentRefs:
                return (
                    "Error: extract operation only accepts a single documentRef; "
                    "use operation='ingest' for multi-document batches."
                )
            if not documentRef:
                return "Error: documentRef is required for extraction."
            extract_result = await document_processor.extract_document(
                documentRef=documentRef,
                username=effective_username,
            )
            return format_extract_response(extract_result)
        if op == "list_collections":
            return await list_collections(effective_username)
        raise AssertionError("validated operation was not handled")

    yield FunctionInfo.from_fn(
        user_document_tool,
        description=(
            "Ingest or search documents for the authenticated user. The backend "
            "derives identity from the trusted request; never pass a username. "
            "Ingestion always writes to a private per-user collection and rejects "
            "shared targets. Search may read either the user's private collection "
            "or an allow-listed shared collection."
        ),
        input_schema=UserDocumentInput,
    )
