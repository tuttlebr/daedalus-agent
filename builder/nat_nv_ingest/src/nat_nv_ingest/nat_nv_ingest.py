import asyncio
import base64
import html as html_mod
import json
import logging
import re
import time
from pathlib import Path
from typing import Any

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


class NvIngestFunctionConfig(FunctionBaseConfig, name="nat_nv_ingest"):
    """
    Configuration for NvIngest document processing function.
    """

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
    chunk_size: int = Field(default=1024, description="Text chunk size for processing")
    chunk_overlap: int = Field(default=150, description="Overlap between text chunks")
    embedder_dim: int = Field(default=2048, description="Embedding dimension")
    recreate_collection: bool = Field(
        default=False, description="Whether to recreate Milvus collection on each run"
    )
    default_collection_name: str = Field(
        default="user_uploads",
        description="Fallback Milvus collection name when none is supplied in the request",
    )


@register_function(
    config_type=NvIngestFunctionConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN]
)
async def nv_ingest_function(
    config: NvIngestFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    """
    Registers a document processing function using NvIngest.

    Supports all NvIngest-compatible file types (PDF, DOCX, PPTX, images, etc.)
    and returns extracted content as Markdown.

    Args:
        config (NvIngestFunctionConfig): The configuration for the function.
        builder (Builder): The builder object.

    Returns:
        FunctionInfo: The function info object for the function.
    """

    # Initialize Redis client
    redis_client = redis.from_url(
        config.redis_url,
        decode_responses=False,  # Need binary data for documents
    )

    # Initialize NvIngest client
    nv_client = NvIngestClient(
        message_client_port=config.nv_ingest_port,
        message_client_hostname=config.nv_ingest_host,
    )

    # Initialize Milvus client
    milvus_client = MilvusClient(uri=config.milvus_uri)

    def clean_markdown(text: str) -> str:
        """Apply low-cost text cleanup to raw NV-Ingest extracted content."""
        if not text:
            return text

        # 1. Decode HTML entities (&nbsp;, &amp;, &lt;, etc.)
        text = html_mod.unescape(text)

        # 2. Convert residual <br> to newlines; strip common wrapper tags
        text = re.sub(r"<br\s*/?>", "\n", text)
        text = re.sub(r"</?(?:span|div|p|font)[^>]*>", "", text)

        # 3. Unicode normalization — replace PDF-common invisible/special chars
        text = text.replace("\u00a0", " ")  # non-breaking space
        text = text.replace("\u200b", "")  # zero-width space
        text = text.replace("\u200c", "")  # zero-width non-joiner
        text = text.replace("\u200d", "")  # zero-width joiner
        text = text.replace("\ufeff", "")  # BOM
        text = text.replace("\u2028", "\n")  # line separator
        text = text.replace("\u2029", "\n")  # paragraph separator

        # 4. Normalize smart quotes / dashes / ellipsis
        text = text.replace("\u2018", "'").replace("\u2019", "'")
        text = text.replace("\u201c", '"').replace("\u201d", '"')
        text = text.replace("\u2013", "-").replace("\u2014", "--")
        text = text.replace("\u2026", "...")

        # 5. Dehyphenation — rejoin words split across lines by PDF layout
        text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)

        # 6. Whitespace normalization
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r" +\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)

        return text.strip()

    def clean_table_markdown(text: str) -> str:
        """Light repair of markdown tables from NV-Ingest structured extraction."""
        if not text:
            return text

        # Decode entities and strip stray HTML inside table cells
        text = html_mod.unescape(text)
        text = re.sub(r"</?(?:span|div|p|font)[^>]*>", "", text)
        text = text.replace("\u00a0", " ")

        lines = text.strip().split("\n")

        # Strip empty trailing rows (rows that are only pipes and whitespace)
        while lines and re.match(r"^\|[\s|]*$", lines[-1]):
            lines.pop()

        if not lines:
            return text

        # Determine expected column count from the header row
        header_cols = lines[0].count("|") - 1  # leading + trailing pipe
        if header_cols < 1:
            return "\n".join(lines)

        # Normalize separator row dashes and ensure consistent column count
        repaired: list[str] = []
        for i, line in enumerate(lines):
            if not line.strip().startswith("|"):
                repaired.append(line)
                continue

            cells = line.strip().strip("|").split("|")

            # Separator row: normalize to --- per cell
            if i == 1 and all(c.strip().replace("-", "") == "" for c in cells):
                cells = [" --- "] * header_cols
            else:
                # Pad short rows, truncate long rows
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
        return set(re.sub(r"[^a-z0-9\s]", "", text.lower()).split())

    def _dedup_entries(entries: list[dict]) -> list[dict]:
        """
        Remove near-duplicate entries that share the same page and overlap
        significantly in content. Keeps the higher-quality version.
        """
        if len(entries) <= 1:
            return entries

        # Group text entries by page for pairwise comparison
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

        # Find indices to drop (near-duplicate with lower quality)
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
                        # Keep the higher-quality entry, drop the other
                        score_a = _text_quality_score(group[i][2])
                        score_b = _text_quality_score(group[j][2])
                        drop_idx = group[j][0] if score_a >= score_b else group[i][0]
                        drop_indices.add(drop_idx)
                        logger.debug(
                            "Dropping near-duplicate entry %d (page %d, similarity=%.2f)",
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

    def results_to_markdown(results: list[list[dict]]) -> str:
        """
        Convert NvIngest JSON results into well-structured Markdown.

        Handles all document_type values returned by NvIngest:
        structured (tables/charts), text, image, and audio.
        """
        if not results or not results[0]:
            return ""

        entries = results[0]

        logger.info(
            "results_to_markdown: %d result sets, %d entries in first set",
            len(results),
            len(entries),
        )
        # Log document types for debugging
        type_counts: dict[str, int] = {}
        for e in entries:
            dt = e.get("document_type", "unknown")
            type_counts[dt] = type_counts.get(dt, 0) + 1
        logger.info("Entry type breakdown: %s", type_counts)

        # Sort by page, then by spatial position within the page
        def sort_key(entry: dict) -> tuple:
            meta = entry.get("metadata", {})
            page = meta.get("content_metadata", {}).get("page_number", 0)
            x0 = meta.get("content_metadata", {}).get("hierarchy", {}).get("x0", 0)
            y0 = meta.get("content_metadata", {}).get("hierarchy", {}).get("y0", 0)
            return (page, y0, x0)

        try:
            entries = sorted(entries, key=sort_key)
        except (TypeError, KeyError):
            pass

        # Remove near-duplicate entries (e.g. native text + OCR of same region)
        entries = _dedup_entries(entries)

        md_parts: list[str] = []
        current_page: int | None = None

        for entry in entries:
            meta = entry.get("metadata", {})
            doc_type = entry.get("document_type", "")
            content_meta = meta.get("content_metadata", {})
            page_num = content_meta.get("page_number")

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
        result = re.sub(r"\n{3,}", "\n\n", result)
        return result

    async def nv_ingest_router(input_message: dict[str, Any]) -> str:
        """
        Routes NV Ingest requests to the appropriate function.
        If the request contains documentRef or documentRefs, it processes the document(s).
        Otherwise, it lists available collections.

        Args:
            input_message: Request dictionary that may contain:
                - request: Inner request object with document processing parameters
                - documentRef: Reference to single document for processing
                - documentRefs: Array of references to multiple documents for processing
                - username: Username for the request
                - collection_name: Target collection name
                - chunk_size: Optional chunk size override
                - chunk_overlap: Optional chunk overlap override

        Returns:
            Either a list of collections or a processing result message
        """
        logger.info(
            "nv_ingest_router called with input_message: %s", str(input_message)[:500]
        )

        # Handle nested request structure from the agent
        if input_message and isinstance(input_message, dict):
            # Unwrap tool input payloads (sequential executor wraps as input_message)
            if "input_message" in input_message and isinstance(
                input_message["input_message"], dict
            ):
                inner_request = input_message["input_message"]
            # Check if parameters are nested under 'request' key
            elif "request" in input_message and isinstance(
                input_message["request"], dict
            ):
                inner_request = input_message["request"]
            else:
                inner_request = input_message

            logger.info("Inner request structure: %s", str(inner_request)[:500])

            # Extract metadata if present (LLM sometimes nests username/collection_name here)
            metadata = inner_request.get("metadata", {})
            if not isinstance(metadata, dict):
                metadata = {}

            # Helper to get a value from inner_request or fallback to metadata
            def get_param(key: str, default: str | None = None) -> str | None:
                value = inner_request.get(key)
                if value:
                    return value
                return metadata.get(key, default)

            # Check if this is a multiple document processing request
            if "documentRefs" in inner_request:
                documentRefs = inner_request.get("documentRefs")
                logger.info(
                    "Processing multiple documents: %d files",
                    len(documentRefs) if isinstance(documentRefs, list) else 0,
                )
                # Extract parameters for multiple document processing
                return await process_multiple_documents(
                    documentRefs=documentRefs,
                    username=get_param("username", ""),
                    collection_name=get_param("collection_name"),
                    chunk_size=inner_request.get("chunk_size"),
                    chunk_overlap=inner_request.get("chunk_overlap"),
                )

            # Check if this is a single document processing request
            elif "documentRef" in inner_request:
                # Extract parameters for document processing
                return await process_document(
                    documentRef=inner_request.get("documentRef"),
                    username=get_param("username", ""),
                    collection_name=get_param("collection_name"),
                    chunk_size=inner_request.get("chunk_size"),
                    chunk_overlap=inner_request.get("chunk_overlap"),
                )

        # Default to listing collections
        return await list_collections()

    async def list_collections() -> str:
        """
        Lists all available Milvus collections.

        Returns:
            str: Human-readable list of collection names
        """
        try:
            collections = await asyncio.to_thread(milvus_client.list_collections)
            logger.info("Found %d collections in Milvus", len(collections))
            if not collections:
                return "No collections found."
            return "Available collections:\n" + "\n".join(collections)
        except Exception as e:
            logger.error("Error listing Milvus collections: %s", e)
            return "Error listing Milvus collections."

    async def process_multiple_documents(
        documentRefs: list[dict[str, Any]],
        username: str,
        collection_name: str | None = None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
    ) -> str:
        """
        Processes multiple documents from Redis and ingests them into Milvus.

        Args:
            documentRefs: List of document references in Redis containing documentId and sessionId
            username: Username from session context
            collection_name: Name of the Milvus collection to upload to (optional)
            chunk_size: Optional override for chunk size
            chunk_overlap: Optional override for chunk overlap

        Returns:
            str: Summary message with processing details for all documents
        """
        logger.info(
            "process_multiple_documents called with: documentRefs=%s, username=%s, collection_name=%s",
            str(documentRefs)[:500] if documentRefs else "None",
            username,
            collection_name,
        )

        # Validate inputs
        if not documentRefs or not isinstance(documentRefs, list):
            logger.error("Invalid document references: %s", type(documentRefs))
            return "Error: Invalid document references provided. Expected a list of document references."

        if not username:
            logger.error("No username provided")
            return "Error: Valid username required for document processing."

        # Limit the number of documents to process at once to avoid timeouts
        MAX_DOCUMENTS_PER_BATCH = 20
        if len(documentRefs) > MAX_DOCUMENTS_PER_BATCH:
            logger.warning(
                "Too many documents to process at once: %d. Maximum allowed is %d",
                len(documentRefs),
                MAX_DOCUMENTS_PER_BATCH,
            )
            return (
                f"⚠️ Too many documents selected ({len(documentRefs)})\n\n"
                f"For optimal processing and to avoid timeouts, please select no more than {MAX_DOCUMENTS_PER_BATCH} documents at a time.\n\n"
                f"You can process your {len(documentRefs)} documents in {(len(documentRefs) + MAX_DOCUMENTS_PER_BATCH - 1) // MAX_DOCUMENTS_PER_BATCH} batches."
            )

        # Default collection name if none provided
        if not collection_name:
            collection_name = config.default_collection_name or username

        # Process results tracking
        total_documents = len(documentRefs)
        successful_documents = []
        failed_documents = []
        total_chunks = 0

        logger.info(
            "Starting batch processing of %d documents for user %s into collection %s",
            total_documents,
            username,
            collection_name,
        )

        # Process each document
        start_time = time.time()

        for idx, documentRef in enumerate(documentRefs, 1):
            document_start_time = time.time()
            logger.info(
                "Processing document %d of %d: %s",
                idx,
                total_documents,
                documentRef.get("filename", documentRef.get("documentId")),
            )

            try:
                # Process individual document
                result = await process_document(
                    documentRef=documentRef,
                    username=username,
                    collection_name=collection_name,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                )

                document_time = time.time() - document_start_time
                logger.info(
                    "Document %d processing completed in %.2f seconds. Result: %s",
                    idx,
                    document_time,
                    result[:200],
                )

                # Extract filename from documentRef or use documentId
                document_id = documentRef.get("documentId", f"Document_{idx}")
                filename = documentRef.get("filename", document_id)

                # Check if processing was successful
                if (
                    "Successfully processed" in result
                    or "Partially processed" in result
                ):
                    # Extract chunk count from result message
                    chunk_match = re.search(r"indexed (\d+)", result)
                    if chunk_match:
                        chunks = int(chunk_match.group(1))
                        total_chunks += chunks
                        successful_documents.append({"id": filename, "chunks": chunks})
                    else:
                        successful_documents.append(
                            {"id": filename, "chunks": "unknown"}
                        )
                else:
                    failed_documents.append({"id": filename, "error": result})
                    logger.warning("Document %s failed: %s", filename, result)

            except Exception as e:
                logger.error(
                    "Error processing document %s: %s",
                    documentRef.get("documentId", "unknown"),
                    e,
                    exc_info=True,
                )
                filename = documentRef.get(
                    "filename", documentRef.get("documentId", f"Document_{idx}")
                )
                failed_documents.append({"id": filename, "error": str(e)})

        # Prepare summary message
        success_count = len(successful_documents)
        failure_count = len(failed_documents)

        if failure_count == 0:
            # All documents processed successfully
            result_message = (
                f"✅ Successfully processed all {total_documents} documents\n\n"
                f"📄 **Summary:**\n"
                f"- Total documents: {total_documents}\n"
                f"- Total chunks indexed: {total_chunks}\n"
                f"- Collection: '{collection_name}'\n"
                f"- Chunk size: {chunk_size or config.chunk_size} with "
                f"{chunk_overlap or config.chunk_overlap} overlap\n\n"
            )

            if len(successful_documents) <= 10:
                result_message += "📋 **Processed files:**\n"
                for doc in successful_documents:
                    result_message += f"- {doc['id']} ({doc['chunks']} chunks)\n"

            result_message += (
                "\nAll documents are now searchable in your knowledge base!"
            )

        elif success_count > 0:
            # Some documents processed successfully
            result_message = (
                f"⚠️ Partially completed batch processing\n\n"
                f"📄 **Summary:**\n"
                f"- Successfully processed: {success_count}/{total_documents} documents\n"
                f"- Failed: {failure_count} documents\n"
                f"- Total chunks indexed: {total_chunks}\n"
                f"- Collection: '{collection_name}'\n\n"
            )

            if success_count <= 10:
                result_message += "✅ **Successfully processed:**\n"
                for doc in successful_documents:
                    result_message += f"- {doc['id']} ({doc['chunks']} chunks)\n"
                result_message += "\n"

            if failure_count <= 10:
                result_message += "❌ **Failed documents:**\n"
                for doc in failed_documents:
                    result_message += f"- {doc['id']}: {doc['error'][:100]}...\n"

            result_message += "\nSuccessfully processed documents are searchable in your knowledge base."

        else:
            # All documents failed
            result_message = (
                f"❌ Failed to process any documents\n\n"
                f"📄 **Summary:**\n"
                f"- Attempted: {total_documents} documents\n"
                f"- All failed\n\n"
            )

            if failure_count <= 10:
                result_message += "**Errors:**\n"
                for doc in failed_documents:
                    result_message += f"- {doc['id']}: {doc['error'][:100]}...\n"

            result_message += "\nPlease check the documents and try again."

        total_time = time.time() - start_time
        logger.info(
            "Batch processing completed in %.2f seconds. Success: %d, Failed: %d",
            total_time,
            success_count,
            failure_count,
        )
        logger.info(
            "Returning result message (length=%d): %s",
            len(result_message),
            result_message[:500],
        )
        return result_message

    async def process_document(
        documentRef: dict[str, Any],
        username: str,
        collection_name: str | None = None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
    ) -> str:
        """
        Processes a document from Redis and ingests it into Milvus.

        Args:
            documentRef: Reference to document in Redis containing documentId and sessionId
            username: Username from session context
            collection_name: Name of the Milvus collection to upload to (optional)
            chunk_size: Optional override for chunk size
            chunk_overlap: Optional override for chunk overlap

        Returns:
            str: Success message with processing details
        """
        logger.info(
            "process_document called with: documentRef=%s, username=%s, collection_name=%s",
            documentRef,
            username,
            collection_name,
        )

        # Use config defaults if not provided
        chunk_size = chunk_size or config.chunk_size
        chunk_overlap = chunk_overlap or config.chunk_overlap

        # Default collection name if none provided
        if not collection_name:
            collection_name = config.default_collection_name or username

        try:
            # Validate inputs
            if not documentRef or not isinstance(documentRef, dict):
                return "Error: Invalid document reference provided."

            document_id = documentRef.get("documentId")
            session_id = documentRef.get("sessionId")

            if not document_id or not session_id:
                return (
                    "Error: Document reference must contain documentId and sessionId."
                )

            if not username:
                return "Error: Valid username required for document processing."

            if not collection_name:
                return "Error: Collection name must be specified."

            logger.info(
                "Processing document %s for user %s into collection %s",
                document_id,
                username,
                collection_name,
            )

            # Construct Redis key following the pattern from documentStorage
            redis_key = f"document:{session_id}:{document_id}"

            # Retrieve document data from Redis (wrapped in to_thread since redis is synchronous)
            try:
                document_data_json = await asyncio.to_thread(
                    redis_client.execute_command, "JSON.GET", redis_key
                )

                if not document_data_json:
                    logger.error(
                        "Document %s not found in Redis (key: %s)",
                        document_id,
                        redis_key,
                    )
                    return (
                        "Error: Document not found in storage. "
                        "The file may have expired or the session may be "
                        "invalid. Please try uploading the document again."
                    )

                # Parse the JSON data
                document_record = json.loads(document_data_json)

                # Extract base64 data and metadata
                document_base64 = document_record.get("data")
                filename = document_record.get("filename", f"{document_id}.bin")

                if not document_base64:
                    logger.error("Document data is empty for document %s", document_id)
                    return "Error: Retrieved document data is empty."

                logger.info(
                    "Successfully retrieved document from Redis (filename: %s)",
                    filename,
                )

                # Decode base64 to bytes
                document_bytes = base64.b64decode(document_base64)

            except redis.RedisError as e:
                logger.error("Redis error retrieving document: %s", e)
                return f"Error accessing document storage: {str(e)}"
            except Exception as e:
                logger.error("Error processing document data: %s", e)
                return f"Error processing document data: {str(e)}"

            # Create temporary directory for user
            temp_dir = Path(f"/data/{username}")
            temp_dir.mkdir(parents=True, exist_ok=True)

            # Save document to temporary file
            document_path = temp_dir / filename
            try:
                with open(document_path, "wb") as f:
                    f.write(document_bytes)
                logger.info("Saved document to %s", document_path)
            except Exception as e:
                logger.error("Error saving document to disk: %s", e)
                return f"Error saving document: {str(e)}"

            # Process with NvIngest (wrapped in to_thread since nv_ingest is synchronous)

            def run_ingest():
                with (
                    Ingestor(client=nv_client)
                    .files([str(document_path)])
                    .extract(
                        extract_text=True,
                        extract_tables=True,
                        extract_charts=False,
                        extract_images=False,
                        table_output_format="markdown",
                        text_depth="page",
                    )
                    .split(
                        tokenizer="meta-llama/Llama-3.2-1B",
                        chunk_size=chunk_size,
                        chunk_overlap=chunk_overlap,
                    )
                    .dedup()
                    .embed()
                    .vdb_upload(
                        collection_name=collection_name,  # Use specified collection
                        milvus_uri=config.milvus_uri,
                        gpu_index=False,
                        gpu_search=False,
                        dense_dim=config.embedder_dim,
                        recreate=config.recreate_collection,
                        minio_endpoint=config.minio_endpoint,
                        bucket_name="nv-ingest",
                        access_key=config.minio_access_key,
                        secret_key=config.minio_secret_key,
                        stream=True,  # Force streaming insert
                    )
                ) as ingestor:
                    logger.info("Starting document ingestion for %s...", filename)
                    return ingestor.ingest(show_progress=True, return_failures=True)

            try:
                results, failures = await asyncio.to_thread(run_ingest)

                result_md = results_to_markdown(results)
                logger.info("Result markdown: %s", result_md[:500])
                success_count = len(results[0]) if results and results[0] else 0
                failure_count = len(failures[0]) if failures and failures[0] else 0

                logger.info(
                    "Completed document ingestion: %s successful, %s failures",
                    success_count,
                    failure_count,
                )
                if result_md:
                    return result_md

                if failure_count == 0:
                    return (
                        f"✅ Successfully processed document '{filename}'\n\n"
                        f"- Extracted and indexed {success_count} text chunks\n"
                        f"- Stored in collection '{collection_name}'\n"
                        f"- Chunk size: {chunk_size} characters with "
                        f"{chunk_overlap} overlap\n\n"
                        "The document is now searchable in your knowledge base!"
                    )

                return (
                    f"⚠️ Partially processed document '{filename}'\n\n"
                    f"- Successfully indexed {success_count} chunks\n"
                    f"- Failed to process {failure_count} chunks\n"
                    f"- Stored in collection '{collection_name}'\n\n"
                    "Some content may be missing from the search index."
                )
            except Exception as e:
                logger.error("NvIngest processing error: %s", e, exc_info=True)
                return f"Error processing document with NvIngest: {str(e)}"
            finally:
                # Clean up temporary file
                try:
                    if document_path.exists():
                        document_path.unlink()
                        logger.info("Cleaned up temporary file: %s", document_path)
                except Exception as e:
                    logger.warning("Failed to clean up temp file: %s", e)

        except Exception as e:
            logger.error("Unexpected error in process_document: %s", e, exc_info=True)
            return f"An unexpected error occurred: {str(e)}"

    # Yield the router function as the main entry point
    yield FunctionInfo.from_fn(
        nv_ingest_router,
        description="Process single or multiple document files for ingestion into vector database or list available collections. Accepts a request object that may contain documentRef (single document) or documentRefs (array of documents), username, and collection_name for document processing. All documents in a batch will be uploaded to the same collection.",
    )
