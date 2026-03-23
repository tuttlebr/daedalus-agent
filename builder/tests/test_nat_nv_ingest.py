"""Unit tests for nat_nv_ingest configuration and data models."""

from nat_nv_ingest.nat_nv_ingest import NvIngestFunctionConfig

# ---------------------------------------------------------------------------
# NvIngestFunctionConfig
# ---------------------------------------------------------------------------


class TestNvIngestFunctionConfig:
    def test_defaults(self):
        config = NvIngestFunctionConfig()
        assert config.nv_ingest_host == "localhost"
        assert config.nv_ingest_port == 7670
        assert config.milvus_uri == "http://localhost:19530"
        assert config.minio_endpoint == "localhost:9000"
        assert config.minio_access_key == "minioadmin"
        assert config.minio_secret_key == "minioadmin"
        assert config.chunk_size == 1024
        assert config.chunk_overlap == 150
        assert config.embedder_dim == 2048
        assert config.recreate_collection is False
        assert config.default_collection_name == "user_uploads"

    def test_redis_url_default(self):
        config = NvIngestFunctionConfig()
        assert "localhost" in config.redis_url

    def test_custom_host_port(self):
        config = NvIngestFunctionConfig(
            nv_ingest_host="nv-ingest-service",
            nv_ingest_port=7671,
        )
        assert config.nv_ingest_host == "nv-ingest-service"
        assert config.nv_ingest_port == 7671

    def test_custom_chunk_settings(self):
        config = NvIngestFunctionConfig(chunk_size=512, chunk_overlap=64)
        assert config.chunk_size == 512
        assert config.chunk_overlap == 64

    def test_custom_milvus_uri(self):
        config = NvIngestFunctionConfig(milvus_uri="http://milvus:19530")
        assert config.milvus_uri == "http://milvus:19530"

    def test_recreate_collection_flag(self):
        config = NvIngestFunctionConfig(recreate_collection=True)
        assert config.recreate_collection is True

    def test_custom_collection_name(self):
        config = NvIngestFunctionConfig(default_collection_name="my_docs")
        assert config.default_collection_name == "my_docs"

    def test_custom_embedder_dim(self):
        config = NvIngestFunctionConfig(embedder_dim=1024)
        assert config.embedder_dim == 1024

    def test_minio_credentials(self):
        config = NvIngestFunctionConfig(
            minio_access_key="access123",
            minio_secret_key="secret456",
        )
        assert config.minio_access_key == "access123"
        assert config.minio_secret_key == "secret456"


# ---------------------------------------------------------------------------
# html_to_markdown_udf module importability
# ---------------------------------------------------------------------------


class TestHtmlToMarkdownUdfImport:
    def test_module_importable(self):
        """The html_to_markdown_udf module should be importable without errors."""
        import nat_nv_ingest.html_to_markdown_udf as html_mod  # noqa: F401

        assert html_mod is not None
