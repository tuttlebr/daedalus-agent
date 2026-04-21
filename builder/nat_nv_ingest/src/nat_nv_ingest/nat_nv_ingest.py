import asyncio
import base64
import html as html_mod
import json
import logging
import re
import time
from io import BytesIO
from typing import Any, Literal, TypedDict

import redis
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nv_ingest_client.client import Ingestor, NvIngestClient
from pydantic import Field
from pymilvus import MilvusClient

logger = logging.getLogger(__name__)

# Precompiled regex used by the markdown cleaners and dedup helpers.
_HTML_TAG_RE = re.compile(r"</?(?:span|div|p|font)[^>]*>")
_BR_RE = re.compile(r"<br\s*/?>")
_WS_RE = re.compile(r"[ \t]+")
_SPACE_NL_RE = re.compile(r" +\n")
_NL_COLLAPSE_RE = re.compile(r"\n{3,}")
_DEHYPHEN_RE = re.compile(r"(\w)-\n(\w)")
_EMPTY_ROW_RE = re.compile(r"^\|[\s|]*$")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9\s]")


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
        default=4,
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


def _build_ingestor(
    *,
    nv_client: NvIngestClient,
    document_bytes: bytes,
    filename: str,
    config: NvIngestFunctionConfig,
    collection_name: str,
    chunk_size: int,
    chunk_overlap: int,
) -> Ingestor:
    """Build a configured Ingestor chain from in-memory bytes.

    Uses `.buffers()` so nothing has to be written to disk, which avoids
    concurrent-same-filename collisions and /data cleanup.
    """
    lower = filename.lower()
    is_pdf = lower.endswith(".pdf")
    is_office = lower.endswith((".docx", ".pptx"))

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
        )
    )
    return ingestor


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

    # Lazy client cache — clients are built on first use to avoid eager
    # network I/O at startup and to let tests patch factory output cleanly.
    # Pattern mirrors builder/nat_nv_ingest/src/nat_nv_ingest/user_document_retriever.py.
    _client_cache: dict[str, Any] = {}
    _client_lock = asyncio.Lock()

    async def _get_redis() -> redis.Redis:
        if "redis" not in _client_cache:
            async with _client_lock:
                if "redis" not in _client_cache:
                    _client_cache["redis"] = redis.from_url(
                        config.redis_url,
                        decode_responses=False,  # Need binary data for documents
                        socket_timeout=config.redis_socket_timeout,
                        socket_connect_timeout=config.redis_connect_timeout,
                        retry_on_timeout=True,
                    )
        return _client_cache["redis"]

    async def _get_nv_client() -> NvIngestClient:
        if "nv_ingest" not in _client_cache:
            async with _client_lock:
                if "nv_ingest" not in _client_cache:
                    kwargs: dict[str, Any] = {
                        "message_client_port": config.nv_ingest_port,
                        "message_client_hostname": config.nv_ingest_host,
                        "worker_pool_size": config.worker_pool_size,
                    }
                    if config.use_v2_api:
                        kwargs["message_client_kwargs"] = {"api_version": "v2"}
                    _client_cache["nv_ingest"] = NvIngestClient(**kwargs)
        return _client_cache["nv_ingest"]

    async def _get_milvus() -> MilvusClient:
        if "milvus" not in _client_cache:
            async with _client_lock:
                if "milvus" not in _client_cache:
                    _client_cache["milvus"] = MilvusClient(uri=config.milvus_uri)
        return _client_cache["milvus"]

    async def list_collections() -> str:
        """Lists all available Milvus collections."""
        try:
            milvus_client = await _get_milvus()
            collections = await asyncio.to_thread(milvus_client.list_collections)
            logger.info("Found %d collections in Milvus", len(collections))
            if not collections:
                return "No collections found."
            return "Available collections:\n" + "\n".join(collections)
        except Exception as e:
            logger.error("Error listing Milvus collections: %s", e)
            return "Error listing Milvus collections."

    async def process_document(
        documentRef: dict[str, Any],
        username: str,
        collection_name: str | None = None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
    ) -> IngestResult:
        """Processes a document from Redis and ingests it into Milvus."""
        logger.info(
            "process_document called with: documentRef=%s, username=%s, collection_name=%s",
            documentRef,
            username,
            collection_name,
        )

        chunk_size = chunk_size or config.chunk_size
        chunk_overlap = chunk_overlap or config.chunk_overlap

        if not collection_name:
            collection_name = config.default_collection_name or username

        initial_filename = (
            documentRef.get("filename", "") if isinstance(documentRef, dict) else ""
        )

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
                return _failure(
                    "Error: Valid username required for document processing."
                )

            if not collection_name:
                return _failure("Error: Collection name must be specified.")

            logger.info(
                "Processing document %s for user %s into collection %s",
                document_id,
                username,
                collection_name,
            )

            # Fetch document bytes from Redis
            redis_key = f"document:{session_id}:{document_id}"
            fetch_start = time.time()
            try:
                redis_client = await _get_redis()
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
                document_base64 = document_record.get("data")
                filename = document_record.get("filename", f"{document_id}.bin")

                if not document_base64:
                    logger.error("Document data is empty for document %s", document_id)
                    return _failure(
                        "Error: Retrieved document data is empty.",
                        filename=filename,
                    )

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

            # Ingestion + post-processing run inside a worker thread so the
            # CPU-bound dedup / markdown assembly never blocks the event loop.
            nv_client = await _get_nv_client()

            def run_ingest_with_postproc() -> tuple[str, int, int, int]:
                ingestor = _build_ingestor(
                    nv_client=nv_client,
                    document_bytes=document_bytes,
                    filename=filename,
                    config=config,
                    collection_name=collection_name,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                )
                with ingestor as ctx:
                    logger.info("Starting document ingestion for %s...", filename)
                    results, failures = ctx.ingest(
                        show_progress=False, return_failures=True
                    )
                md, page_count = results_to_markdown(results)
                success_count = len(results[0]) if results and results[0] else 0
                failure_count = len(failures[0]) if failures and failures[0] else 0
                return md, page_count, success_count, failure_count

            ingest_start = time.time()
            success_payload: tuple[str, int, int, int] | None = None
            last_exc: Exception | None = None
            for attempt in range(config.ingest_max_retries + 1):
                try:
                    success_payload = await asyncio.to_thread(run_ingest_with_postproc)
                    break
                except Exception as e:
                    last_exc = e
                    if attempt < config.ingest_max_retries:
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

    async def process_multiple_documents(
        documentRefs: list[dict[str, Any]],
        username: str,
        collection_name: str | None = None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
    ) -> str:
        """Processes multiple documents from Redis and ingests them into Milvus."""
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

        max_batch = config.max_documents_per_batch
        if len(documentRefs) > max_batch:
            logger.warning(
                "Too many documents to process at once: %d. Maximum allowed is %d",
                len(documentRefs),
                max_batch,
            )
            return (
                f"⚠️ Too many documents selected ({len(documentRefs)})\n\n"
                f"For optimal processing and to avoid timeouts, please select no more "
                f"than {max_batch} documents at a time.\n\n"
                f"You can process your {len(documentRefs)} documents in "
                f"{(len(documentRefs) + max_batch - 1) // max_batch} batches."
            )

        if not collection_name:
            collection_name = config.default_collection_name or username

        total_documents = len(documentRefs)
        successful_documents: list[dict[str, Any]] = []
        failed_documents: list[dict[str, Any]] = []
        total_chunks = 0
        total_pages = 0

        logger.info(
            "Starting batch processing of %d documents for user %s into collection %s "
            "(concurrency=%d, recreate=%s)",
            total_documents,
            username,
            collection_name,
            config.batch_concurrency,
            config.recreate_collection,
        )
        start_time = time.time()

        # A concurrent recreate=True race on the Milvus schema would have
        # multiple jobs trying to (re)create the collection in parallel. Run
        # the first job synchronously in that case to prime the collection,
        # then parallelize the rest.
        sync_prefix = 1 if config.recreate_collection and total_documents > 1 else 0
        concurrency = max(1, config.batch_concurrency)
        sem = asyncio.Semaphore(concurrency)

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
                async with sem:
                    result = await process_document(
                        documentRef=documentRef,
                        username=username,
                        collection_name=collection_name,
                        chunk_size=chunk_size,
                        chunk_overlap=chunk_overlap,
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

        def _accumulate(ref_filename: str, outcome: IngestResult | Exception) -> None:
            nonlocal total_chunks, total_pages
            if isinstance(outcome, Exception):
                failed_documents.append({"id": ref_filename, "error": str(outcome)})
                return
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
            else:
                failed_documents.append({"id": filename, "error": outcome["error"]})
                logger.warning("Document %s failed: %s", filename, outcome["error"])

        for idx in range(sync_prefix):
            _idx, ref_filename, outcome = await _one(idx + 1, documentRefs[idx])
            _accumulate(ref_filename, outcome)

        rest = [
            _one(idx + 1, documentRefs[idx])
            for idx in range(sync_prefix, total_documents)
        ]
        if rest:
            for _idx, ref_filename, outcome in await asyncio.gather(*rest):
                _accumulate(ref_filename, outcome)

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

    async def nv_ingest_router(input_message: dict[str, Any]) -> str:
        """Routes NV Ingest requests to the appropriate function."""
        logger.info(
            "nv_ingest_router called with input_message: %s", str(input_message)[:500]
        )

        if input_message and isinstance(input_message, dict):
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

            if "documentRefs" in inner_request:
                documentRefs = inner_request.get("documentRefs")
                logger.info(
                    "Processing multiple documents: %d files",
                    len(documentRefs) if isinstance(documentRefs, list) else 0,
                )
                return await process_multiple_documents(
                    documentRefs=documentRefs,
                    username=get_param("username", ""),
                    collection_name=get_param("collection_name"),
                    chunk_size=inner_request.get("chunk_size"),
                    chunk_overlap=inner_request.get("chunk_overlap"),
                )

            elif "documentRef" in inner_request:
                ingest_result = await process_document(
                    documentRef=inner_request.get("documentRef"),
                    username=get_param("username", ""),
                    collection_name=get_param("collection_name"),
                    chunk_size=inner_request.get("chunk_size"),
                    chunk_overlap=inner_request.get("chunk_overlap"),
                )
                return format_single_doc_response(ingest_result)

        return await list_collections()

    yield FunctionInfo.from_fn(
        nv_ingest_router,
        description=(
            "Process single or multiple document files for ingestion into vector "
            "database or list available collections. Accepts a request object that "
            "may contain documentRef (single document) or documentRefs (array of "
            "documents), username, and collection_name for document processing. All "
            "documents in a batch will be uploaded to the same collection."
        ),
    )
