import base64
import json
import logging
from pathlib import Path
from typing import Any

from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nv_ingest_client.client import Ingestor, NvIngestClient
from pydantic import Field
from pymilvus import MilvusClient

import redis

logger = logging.getLogger(__name__)


class NvIngestFunctionConfig(FunctionBaseConfig, name="nat_nv_ingest"):
    """
    Configuration for NvIngest PDF processing function.
    """

    redis_url: str = Field(
        default="redis://localhost:6379",
        description="Redis connection URL for retrieving PDFs",
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


@register_function(
    config_type=NvIngestFunctionConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN]
)
async def nv_ingest_function(
    config: NvIngestFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    """
    Registers a PDF processing function using NvIngest.

    Args:
        config (NvIngestFunctionConfig): The configuration for the function.
        builder (Builder): The builder object.

    Returns:
        FunctionInfo: The function info object for the function.
    """

    # Initialize Redis client
    redis_client = redis.from_url(
        config.redis_url,
        decode_responses=False,  # Need binary data for PDFs
    )

    # Initialize NvIngest client
    nv_client = NvIngestClient(
        message_client_port=config.nv_ingest_port,
        message_client_hostname=config.nv_ingest_host,
    )

    # Initialize Milvus client
    milvus_client = MilvusClient(uri=config.milvus_uri)

    async def nv_ingest_router(request: dict[str, Any]) -> Any:
        """
        Routes NV Ingest requests to the appropriate function.
        If the request contains pdfRef or pdfRefs, it processes the PDF(s).
        Otherwise, it lists available collections.

        Args:
            request: Request dictionary that may contain:
                - request: Inner request object with PDF processing parameters
                - pdfRef: Reference to single PDF for processing
                - pdfRefs: Array of references to multiple PDFs for processing
                - username: Username for the request
                - collection_name: Target collection name
                - chunk_size: Optional chunk size override
                - chunk_overlap: Optional chunk overlap override

        Returns:
            Either a list of collections or a processing result message
        """
        logger.info("nv_ingest_router called with request: %s", str(request)[:500])

        # Handle nested request structure from the agent
        if request and isinstance(request, dict):
            # Check if parameters are nested under 'request' key
            if "request" in request and isinstance(request["request"], dict):
                inner_request = request["request"]
            else:
                inner_request = request

            logger.info("Inner request structure: %s", str(inner_request)[:500])

            # Check if this is a multiple PDF processing request
            if "pdfRefs" in inner_request:
                pdfRefs = inner_request.get("pdfRefs")
                logger.info(
                    "Processing multiple PDFs: %d files",
                    len(pdfRefs) if isinstance(pdfRefs, list) else 0,
                )
                # Extract parameters for multiple PDF processing
                return await process_multiple_pdfs(
                    pdfRefs=pdfRefs,
                    username=inner_request.get("username", ""),
                    collection_name=inner_request.get("collection_name"),
                    chunk_size=inner_request.get("chunk_size"),
                    chunk_overlap=inner_request.get("chunk_overlap"),
                )

            # Check if this is a single PDF processing request
            elif "pdfRef" in inner_request:
                # Extract parameters for PDF processing
                return await process_pdf(
                    pdfRef=inner_request.get("pdfRef"),
                    username=inner_request.get("username", ""),
                    collection_name=inner_request.get("collection_name"),
                    chunk_size=inner_request.get("chunk_size"),
                    chunk_overlap=inner_request.get("chunk_overlap"),
                )

        # Default to listing collections
        return await list_collections()

    async def list_collections() -> list[str]:
        """
        Lists all available Milvus collections.

        Returns:
            list[str]: List of collection names
        """
        try:
            collections = milvus_client.list_collections()
            logger.info("Found %d collections in Milvus", len(collections))
            return collections
        except Exception as e:
            logger.error("Error listing Milvus collections: %s", e)
            return []

    async def process_multiple_pdfs(
        pdfRefs: list[dict[str, Any]],
        username: str,
        collection_name: str | None = None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
    ) -> str:
        """
        Processes multiple PDF documents from Redis and ingests them into Milvus.

        Args:
            pdfRefs: List of PDF references in Redis containing pdfId and sessionId
            username: Username from session context
            collection_name: Name of the Milvus collection to upload to (optional)
            chunk_size: Optional override for chunk size
            chunk_overlap: Optional override for chunk overlap

        Returns:
            str: Summary message with processing details for all PDFs
        """
        logger.info(
            "process_multiple_pdfs called with: pdfRefs=%s, username=%s, collection_name=%s",
            str(pdfRefs)[:500] if pdfRefs else "None",
            username,
            collection_name,
        )

        # Validate inputs
        if not pdfRefs or not isinstance(pdfRefs, list):
            logger.error("Invalid PDF references: %s", type(pdfRefs))
            return "Error: Invalid PDF references provided. Expected a list of PDF references."

        if not username:
            logger.error("No username provided")
            return "Error: Valid username required for PDF processing."

        # Limit the number of PDFs to process at once to avoid timeouts
        MAX_PDFS_PER_BATCH = 20
        if len(pdfRefs) > MAX_PDFS_PER_BATCH:
            logger.warning(
                "Too many PDFs to process at once: %d. Maximum allowed is %d",
                len(pdfRefs),
                MAX_PDFS_PER_BATCH,
            )
            return (
                f"⚠️ Too many PDFs selected ({len(pdfRefs)})\n\n"
                f"For optimal processing and to avoid timeouts, please select no more than {MAX_PDFS_PER_BATCH} PDFs at a time.\n\n"
                f"You can process your {len(pdfRefs)} PDFs in {(len(pdfRefs) + MAX_PDFS_PER_BATCH - 1) // MAX_PDFS_PER_BATCH} batches."
            )

        # Default collection name to username if not provided
        if not collection_name:
            collection_name = username

        # Process results tracking
        total_pdfs = len(pdfRefs)
        successful_pdfs = []
        failed_pdfs = []
        total_chunks = 0

        logger.info(
            "Starting batch processing of %d PDFs for user %s into collection %s",
            total_pdfs,
            username,
            collection_name,
        )

        # Process each PDF
        import time

        start_time = time.time()

        for idx, pdfRef in enumerate(pdfRefs, 1):
            pdf_start_time = time.time()
            logger.info(
                "Processing PDF %d of %d: %s",
                idx,
                total_pdfs,
                pdfRef.get("filename", pdfRef.get("pdfId")),
            )

            try:
                # Process individual PDF
                result = await process_pdf(
                    pdfRef=pdfRef,
                    username=username,
                    collection_name=collection_name,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                )

                pdf_time = time.time() - pdf_start_time
                logger.info(
                    "PDF %d processing completed in %.2f seconds. Result: %s",
                    idx,
                    pdf_time,
                    result[:200],
                )

                # Extract filename from pdfRef or use pdfId
                pdf_id = pdfRef.get("pdfId", f"PDF_{idx}")
                filename = pdfRef.get("filename", pdf_id)

                # Check if processing was successful
                if (
                    "Successfully processed" in result
                    or "Partially processed" in result
                ):
                    # Extract chunk count from result message
                    import re

                    chunk_match = re.search(r"indexed (\d+)", result)
                    if chunk_match:
                        chunks = int(chunk_match.group(1))
                        total_chunks += chunks
                        successful_pdfs.append({"id": filename, "chunks": chunks})
                    else:
                        successful_pdfs.append({"id": filename, "chunks": "unknown"})
                else:
                    failed_pdfs.append({"id": filename, "error": result})
                    logger.warning("PDF %s failed: %s", filename, result)

            except Exception as e:
                logger.error(
                    "Error processing PDF %s: %s",
                    pdfRef.get("pdfId", "unknown"),
                    e,
                    exc_info=True,
                )
                filename = pdfRef.get("filename", pdfRef.get("pdfId", f"PDF_{idx}"))
                failed_pdfs.append({"id": filename, "error": str(e)})

        # Prepare summary message
        success_count = len(successful_pdfs)
        failure_count = len(failed_pdfs)

        if failure_count == 0:
            # All PDFs processed successfully
            result_message = (
                f"✅ Successfully processed all {total_pdfs} PDFs\n\n"
                f"📄 **Summary:**\n"
                f"- Total PDFs: {total_pdfs}\n"
                f"- Total chunks indexed: {total_chunks}\n"
                f"- Collection: '{collection_name}'\n"
                f"- Chunk size: {chunk_size or config.chunk_size} with "
                f"{chunk_overlap or config.chunk_overlap} overlap\n\n"
            )

            if len(successful_pdfs) <= 10:
                result_message += "📋 **Processed files:**\n"
                for pdf in successful_pdfs:
                    result_message += f"- {pdf['id']} ({pdf['chunks']} chunks)\n"

            result_message += (
                "\nAll documents are now searchable in your knowledge base!"
            )

        elif success_count > 0:
            # Some PDFs processed successfully
            result_message = (
                f"⚠️ Partially completed batch processing\n\n"
                f"📄 **Summary:**\n"
                f"- Successfully processed: {success_count}/{total_pdfs} PDFs\n"
                f"- Failed: {failure_count} PDFs\n"
                f"- Total chunks indexed: {total_chunks}\n"
                f"- Collection: '{collection_name}'\n\n"
            )

            if success_count <= 10:
                result_message += "✅ **Successfully processed:**\n"
                for pdf in successful_pdfs:
                    result_message += f"- {pdf['id']} ({pdf['chunks']} chunks)\n"
                result_message += "\n"

            if failure_count <= 10:
                result_message += "❌ **Failed PDFs:**\n"
                for pdf in failed_pdfs:
                    result_message += f"- {pdf['id']}: {pdf['error'][:100]}...\n"

            result_message += "\nSuccessfully processed documents are searchable in your knowledge base."

        else:
            # All PDFs failed
            result_message = (
                f"❌ Failed to process any PDFs\n\n"
                f"📄 **Summary:**\n"
                f"- Attempted: {total_pdfs} PDFs\n"
                f"- All failed\n\n"
            )

            if failure_count <= 10:
                result_message += "**Errors:**\n"
                for pdf in failed_pdfs:
                    result_message += f"- {pdf['id']}: {pdf['error'][:100]}...\n"

            result_message += "\nPlease check the PDFs and try again."

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

    async def process_pdf(
        pdfRef: dict[str, Any],
        username: str,
        collection_name: str | None = None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
    ) -> str:
        """
        Processes a PDF document from Redis and ingests it into Milvus.

        Args:
            pdfRef: Reference to PDF in Redis containing pdfId and sessionId
            username: Username from session context
            collection_name: Name of the Milvus collection to upload to (optional)
            chunk_size: Optional override for chunk size
            chunk_overlap: Optional override for chunk overlap

        Returns:
            str: Success message with processing details
        """
        logger.info(
            "process_pdf called with: pdfRef=%s, username=%s, collection_name=%s",
            pdfRef,
            username,
            collection_name,
        )

        # Use config defaults if not provided
        chunk_size = chunk_size or config.chunk_size
        chunk_overlap = chunk_overlap or config.chunk_overlap

        # Default collection name to username if not provided
        if not collection_name:
            collection_name = username

        try:
            # Validate inputs
            if not pdfRef or not isinstance(pdfRef, dict):
                return "Error: Invalid PDF reference provided."

            pdf_id = pdfRef.get("pdfId")
            session_id = pdfRef.get("sessionId")

            if not pdf_id or not session_id:
                return "Error: PDF reference must contain pdfId and sessionId."

            if not username:
                return "Error: Valid username required for PDF processing."

            if not collection_name:
                return "Error: Collection name must be specified."

            logger.info(
                "Processing PDF %s for user %s into collection %s",
                pdf_id,
                username,
                collection_name,
            )

            # Construct Redis key following the pattern from imageStorage
            redis_key = f"pdf:{session_id}:{pdf_id}"

            # Retrieve PDF data from Redis
            try:
                pdf_data_json = redis_client.execute_command("JSON.GET", redis_key)

                if not pdf_data_json:
                    logger.error(
                        "PDF %s not found in Redis (key: %s)", pdf_id, redis_key
                    )
                    return (
                        "Error: PDF not found in storage. "
                        "The file may have expired or the session may be "
                        "invalid. Please try uploading the PDF again."
                    )

                # Parse the JSON data
                pdf_record = json.loads(pdf_data_json)

                # Extract base64 data and metadata
                pdf_base64 = pdf_record.get("data")
                filename = pdf_record.get("filename", f"{pdf_id}.pdf")

                if not pdf_base64:
                    logger.error("PDF data is empty for PDF %s", pdf_id)
                    return "Error: Retrieved PDF data is empty."

                logger.info(
                    "Successfully retrieved PDF from Redis (filename: %s)", filename
                )

                # Decode base64 to bytes
                pdf_bytes = base64.b64decode(pdf_base64)

            except redis.RedisError as e:
                logger.error("Redis error retrieving PDF: %s", e)
                return f"Error accessing PDF storage: {str(e)}"
            except Exception as e:
                logger.error("Error processing PDF data: %s", e)
                return f"Error processing PDF data: {str(e)}"

            # Create temporary directory for user
            temp_dir = Path(f"/data/{username}")
            temp_dir.mkdir(parents=True, exist_ok=True)

            # Save PDF to temporary file
            pdf_path = temp_dir / filename
            try:
                with open(pdf_path, "wb") as f:
                    f.write(pdf_bytes)
                logger.info("Saved PDF to %s", pdf_path)
            except Exception as e:
                logger.error("Error saving PDF to disk: %s", e)
                return f"Error saving PDF: {str(e)}"

            # Process with NvIngest
            try:
                with (
                    Ingestor(client=nv_client)
                    .files([str(pdf_path)])
                    .extract(
                        extract_text=True,
                        extract_tables=False,
                        extract_charts=False,
                        extract_images=False,
                        extract_infographics=False,
                        text_depth="page",
                    )
                    .split(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
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
                    logger.info("Starting PDF ingestion for %s...", filename)
                    results, failures = ingestor.ingest(
                        show_progress=True, return_failures=True
                    )

                    success_count = len(results)
                    failure_count = len(failures)

                    logger.info(
                        "Completed PDF ingestion: %s successful, %s failures",
                        success_count,
                        failure_count,
                    )

            except Exception as e:
                logger.error("NvIngest processing error: %s", e, exc_info=True)
                return f"Error processing PDF with NvIngest: {str(e)}"
            finally:
                # Clean up temporary file
                try:
                    if pdf_path.exists():
                        pdf_path.unlink()
                        logger.info("Cleaned up temporary file: %s", pdf_path)
                except Exception as e:
                    logger.warning("Failed to clean up temp file: %s", e)

            # Prepare response message
            if failure_count == 0:
                return (
                    f"✅ Successfully processed PDF '{filename}'\n\n"
                    f"- Extracted and indexed {success_count} text chunks\n"
                    f"- Stored in collection '{collection_name}'\n"
                    f"- Chunk size: {chunk_size} characters with "
                    f"{chunk_overlap} overlap\n\n"
                    "The document is now searchable in your knowledge base!"
                )
            else:
                return (
                    f"⚠️ Partially processed PDF '{filename}'\n\n"
                    f"- Successfully indexed {success_count} chunks\n"
                    f"- Failed to process {failure_count} chunks\n"
                    f"- Stored in collection '{collection_name}'\n\n"
                    "Some content may be missing from the search index."
                )

        except Exception as e:
            logger.error("Unexpected error in process_pdf: %s", e, exc_info=True)
            return f"An unexpected error occurred: {str(e)}"

    # Yield the router function as the main entry point
    yield FunctionInfo.from_fn(
        nv_ingest_router,
        description="Process single or multiple PDF files for ingestion into vector database or list available collections. Accepts a request object that may contain pdfRef (single PDF) or pdfRefs (array of PDFs), username, and collection_name for PDF processing. All PDFs in a batch will be uploaded to the same collection.",
    )
