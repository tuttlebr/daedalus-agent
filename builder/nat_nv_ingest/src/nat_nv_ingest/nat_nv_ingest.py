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

    async def list_collections(request: dict[str, Any] | None = None) -> list[str]:
        """
        Lists all available Milvus collections.

        Args:
            request: Optional dictionary with filter parameters (currently unused)

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
                        "I couldn't retrieve the PDF document. "
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
                        extract_tables=True,
                        extract_charts=True,
                        extract_images=False,
                        table_output_format="markdown",
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

    # The callables are wrapped in FunctionInfo objects
    yield FunctionInfo.from_fn(list_collections, description=list_collections.__doc__)
    yield FunctionInfo.from_fn(process_pdf, description=process_pdf.__doc__)
