"""Unit tests for nat_nv_ingest configuration and pure helpers."""

import asyncio
import threading
from unittest.mock import MagicMock

import pytest
from nat_nv_ingest.nat_nv_ingest import (
    DEFAULT_DOCUMENT_INGEST_MAX_SIZE_BYTES,
    DEFAULT_DOCUMENT_MARKDOWN_MAX_CHARS,
    DEFAULT_DOCUMENT_OBJECT_PREFIX,
    DEFAULT_DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS,
    ERROR_MESSAGE_CHAR_LIMIT,
    DocumentStorageError,
    IngestResult,
    NvIngestFunctionConfig,
    _apply_char_limit,
    _build_ingestor,
    _can_access_stored_document,
    _dedup_document_refs,
    _dedup_entries,
    _document_object_request_timeout_seconds,
    _document_object_settings,
    _document_size_error,
    _estimated_decoded_size,
    _expected_document_object_key,
    _extract_dense_dim,
    _load_document_bytes,
    _make_document_minio_client,
    _milvus_client_kwargs,
    _milvus_vdb_auth_kwargs,
    _normalize_for_dedup,
    _text_quality_score,
    _truncate_error,
    _validate_embedding_dimension,
    classify_collection_scope,
    clean_markdown,
    clean_table_markdown,
    document_ingest_max_size_bytes,
    document_markdown_max_chars,
    format_batch_response,
    format_single_doc_response,
    legacy_user_upload_collection_name,
    normalize_collection_part,
    nv_ingest_function,
    plan_user_collection_migrations,
    private_user_collection_part,
    resolve_user_collection_name,
    results_to_markdown,
    user_collection_migration_names,
    user_upload_collection_name,
    validate_collection_scope,
    validate_user_collection_write_scope,
)

# ---------------------------------------------------------------------------
# NvIngestFunctionConfig
# ---------------------------------------------------------------------------


class TestNvIngestFunctionConfig:
    def test_defaults(self, monkeypatch):
        monkeypatch.delenv("MILVUS_USERNAME", raising=False)
        monkeypatch.delenv("MILVUS_USER", raising=False)
        monkeypatch.delenv("MILVUS_PASSWORD", raising=False)
        monkeypatch.delenv("MILVUS_TOKEN", raising=False)
        monkeypatch.delenv("MINIO_ENDPOINT", raising=False)
        monkeypatch.delenv("MINIO_ACCESS_KEY", raising=False)
        monkeypatch.delenv("MINIO_SECRET_KEY", raising=False)
        monkeypatch.delenv("MINIO_BUCKET", raising=False)

        config = NvIngestFunctionConfig()
        assert config.nv_ingest_host == "localhost"
        assert config.nv_ingest_port == 7670
        assert config.milvus_uri == "http://localhost:19530"
        assert config.milvus_username is None
        assert config.milvus_password is None
        assert config.milvus_token is None
        assert config.minio_endpoint == ""
        assert config.minio_access_key == ""
        assert config.minio_secret_key == ""
        assert config.minio_bucket == "nv-ingest"
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

    def test_custom_milvus_auth(self):
        config = NvIngestFunctionConfig(
            milvus_username="root",
            milvus_password="Milvus",
        )
        assert _milvus_client_kwargs(config) == {
            "uri": "http://localhost:19530",
            "token": "root:Milvus",
        }
        assert _milvus_vdb_auth_kwargs(config) == {
            "username": "root",
            "password": "Milvus",
        }

    def test_custom_milvus_token_auth(self):
        config = NvIngestFunctionConfig(milvus_token="root:Milvus")
        assert _milvus_client_kwargs(config) == {
            "uri": "http://localhost:19530",
            "token": "root:Milvus",
        }
        assert _milvus_vdb_auth_kwargs(config) == {
            "username": "root",
            "password": "Milvus",
        }

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

    def test_pipeline_field_defaults(self):
        """New config fields added during the improvement pass."""
        config = NvIngestFunctionConfig()
        assert config.tokenizer == "meta-llama/Llama-3.2-1B"
        assert config.minio_bucket == "nv-ingest"
        assert config.extract_method == "pdfium"
        assert config.max_documents_per_batch == 20
        assert config.batch_concurrency == 1
        assert config.worker_pool_size == 16
        assert config.use_v2_api is False
        assert config.pdf_pages_per_chunk == 32
        assert config.enable_image_filter is True
        assert config.enable_captioning is False
        assert config.caption_model_name is None
        assert config.caption_endpoint_url is None
        assert config.caption_api_key is None
        assert config.redis_socket_timeout == 30
        assert config.redis_connect_timeout == 5
        assert config.ingest_max_retries == 2
        assert config.ingest_retry_delay == 1.0
        assert config.ingest_timeout_seconds == 300.0

    def test_build_ingestor_passes_milvus_auth_to_vdb_upload(self, monkeypatch):
        class FakeIngestor:
            vdb_upload_kwargs = None

            def __init__(self, client):
                self.client = client

            def buffers(self, _buffers):
                return self

            def extract(self, **_kwargs):
                return self

            def filter(self, **_kwargs):
                return self

            def split(self, **_kwargs):
                return self

            def dedup(self):
                return self

            def embed(self):
                return self

            def vdb_upload(self, **kwargs):
                FakeIngestor.vdb_upload_kwargs = kwargs
                return self

        import nat_nv_ingest.nat_nv_ingest as mod

        monkeypatch.setattr(mod, "Ingestor", FakeIngestor)

        _build_ingestor(
            nv_client=object(),
            document_bytes=b"hello",
            filename="hello.md",
            config=NvIngestFunctionConfig(
                milvus_username="root",
                milvus_password="Milvus",
            ),
            collection_name="docs",
            chunk_size=1024,
            chunk_overlap=150,
        )

        assert FakeIngestor.vdb_upload_kwargs["username"] == "root"
        assert FakeIngestor.vdb_upload_kwargs["password"] == "Milvus"

    @pytest.mark.parametrize(
        ("filename", "expected_method"),
        [
            ("notes.txt", None),
            ("document.pdf", "pdfium"),
            ("document.docx", "render_as_pdf"),
            ("slides.pptx", "render_as_pdf"),
        ],
    )
    def test_build_ingestor_uses_supported_extract_method(
        self, monkeypatch, filename, expected_method
    ):
        class FakeIngestor:
            extract_kwargs = None

            def __init__(self, client):
                self.client = client

            def buffers(self, _buffers):
                return self

            def extract(self, **kwargs):
                FakeIngestor.extract_kwargs = kwargs
                return self

            def filter(self, **_kwargs):
                return self

        import nat_nv_ingest.nat_nv_ingest as mod

        monkeypatch.setattr(mod, "Ingestor", FakeIngestor)
        _build_ingestor(
            nv_client=object(),
            document_bytes=b"runtime contract",
            filename=filename,
            config=NvIngestFunctionConfig(),
            collection_name="docs",
            chunk_size=1024,
            chunk_overlap=150,
            extract_only=True,
        )

        if expected_method is None:
            assert "extract_method" not in FakeIngestor.extract_kwargs
        else:
            assert FakeIngestor.extract_kwargs["extract_method"] == expected_method
        assert "render_as_pdf" not in FakeIngestor.extract_kwargs


class TestCollectionResolution:
    def test_normalizes_collection_parts(self):
        assert normalize_collection_part("Brandon Smith@example.com") == (
            "brandon_smith_example_com"
        )
        assert normalize_collection_part("123") == "u_123"

    def test_user_upload_collection_name_uses_base_and_user(self):
        collection = user_upload_collection_name("Brandon Smith")
        assert collection.startswith("user_uploads_brandon_smith_")
        assert len(collection.rsplit("_", 1)[-1]) == 64

    @pytest.mark.parametrize(
        "left,right",
        [
            ("a-b", "a_b"),
            ("Alice", "alice"),
            ("x" * 80 + "a", "x" * 80 + "b"),
        ],
    )
    def test_private_collection_names_do_not_share_lossy_normalization_collisions(
        self, left, right
    ):
        assert normalize_collection_part(left) == normalize_collection_part(right)
        assert private_user_collection_part(left) != private_user_collection_part(right)
        assert user_upload_collection_name(left) != user_upload_collection_name(right)

    def test_migration_helper_exposes_legacy_and_current_names(self):
        legacy, current = user_collection_migration_names("alice")
        assert legacy == "user_uploads_alice"
        assert current == user_upload_collection_name("alice")
        assert legacy != current
        assert legacy_user_upload_collection_name("alice") == legacy
        assert resolve_user_collection_name(legacy, "alice") == current

    def test_migration_plan_fails_closed_for_ambiguous_legacy_collection(self):
        with pytest.raises(ValueError, match="maps to multiple subjects"):
            plan_user_collection_migrations(["a-b", "a_b"])

    def test_migration_plan_maps_distinct_legacy_collections(self):
        plan = plan_user_collection_migrations(["alice", "bob"])
        assert plan == {
            "user_uploads_alice": user_upload_collection_name("alice"),
            "user_uploads_bob": user_upload_collection_name("bob"),
        }

    def test_resolve_scopes_explicit_collection_to_user(self):
        assert resolve_user_collection_name(
            "My Docs", "brandon"
        ) == user_upload_collection_name("brandon", "my_docs")

    def test_resolve_allows_shared_collection_allowlist(self):
        assert resolve_user_collection_name("nvidia", "brandon") == "nvidia"
        assert resolve_user_collection_name("vetpartner", "brandon") == "vetpartner"

    def test_classifies_shared_and_user_scoped_collections(self):
        assert classify_collection_scope("nvidia") == "shared"
        assert classify_collection_scope("My Docs") == "user"

    def test_validates_matching_collection_scope(self):
        assert validate_collection_scope("nvidia", "shared") == "shared"
        assert validate_collection_scope("my_docs_brandon", "user") == "user"

    def test_rejects_scope_mismatch_for_shared_collection(self):
        try:
            validate_collection_scope("nvidia", "user")
        except ValueError as exc:
            assert "does not match" in str(exc)
        else:
            raise AssertionError("Expected collection scope mismatch")

    def test_user_facing_write_scope_rejects_shared_collection(self):
        with pytest.raises(ValueError, match="Shared collection writes"):
            validate_user_collection_write_scope("nvidia", "shared")

    def test_resolve_allows_current_user_collection_exactly(self):
        expected = user_upload_collection_name("brandon", "brandon")
        assert resolve_user_collection_name("brandon", "brandon") == expected
        assert resolve_user_collection_name(expected, "brandon") == expected

    def test_resolve_does_not_allow_cross_user_suffix(self):
        assert resolve_user_collection_name(
            "user_uploads_alice", "brandon"
        ) == user_upload_collection_name("brandon", "user_uploads_alice")

    def test_resolve_derives_per_user_default(self):
        assert resolve_user_collection_name(None, "brandon") == (
            user_upload_collection_name("brandon")
        )


def test_user_document_tool_rejects_legacy_cross_user_assertion(monkeypatch):
    async def _run():
        import nat_nv_ingest.nat_nv_ingest as mod

        def _trusted_identity(asserted=""):
            if asserted and asserted != "alice":
                raise ValueError(
                    "supplied user identity does not match the authenticated request"
                )
            return "alice"

        monkeypatch.setattr(mod, "resolve_authenticated_user_id", _trusted_identity)
        generator = nv_ingest_function(NvIngestFunctionConfig(), MagicMock())
        function_info = await generator.__anext__()
        try:
            return await function_info.fn(
                operation="search",
                query="show me private documents",
                username="mallory",
            )
        finally:
            await generator.aclose()

    result = asyncio.run(_run())

    assert "denied" in result.lower()
    assert "does not match" in result.lower()


def test_user_document_tool_lists_only_callers_collection_and_shared_allowlist(
    monkeypatch,
):
    async def _run():
        import nat_nv_ingest.nat_nv_ingest as mod

        event_loop_thread = threading.get_ident()
        client_threads = {}

        class FakeMilvusClient:
            def __init__(self, **_kwargs):
                client_threads["construct"] = threading.get_ident()

            def list_collections(self):
                client_threads["list"] = threading.get_ident()
                return [
                    user_upload_collection_name("bob"),
                    "private_finance",
                    "nvidia",
                    user_upload_collection_name("alice"),
                    "vetpartner",
                ]

        monkeypatch.setattr(mod, "MilvusClient", FakeMilvusClient)
        monkeypatch.setattr(
            mod,
            "resolve_authenticated_user_id",
            lambda _asserted="": "alice",
        )
        generator = nv_ingest_function(NvIngestFunctionConfig(), MagicMock())
        function_info = await generator.__anext__()
        try:
            result = await function_info.fn(operation="list_collections")
            assert client_threads["construct"] != event_loop_thread
            assert client_threads["list"] != event_loop_thread
            return result
        finally:
            await generator.aclose()

    result = asyncio.run(_run())

    assert result.splitlines() == [
        "Available collections:",
        "nvidia",
        user_upload_collection_name("alice"),
        "vetpartner",
    ]
    assert user_upload_collection_name("bob") not in result
    assert "private_finance" not in result


def test_user_document_tool_rejects_shared_ingest_before_storage(monkeypatch):
    async def _run():
        import nat_nv_ingest.nat_nv_ingest as mod

        monkeypatch.setattr(
            mod,
            "resolve_authenticated_user_id",
            lambda _asserted="": "alice",
        )
        generator = nv_ingest_function(NvIngestFunctionConfig(), MagicMock())
        function_info = await generator.__anext__()
        try:
            return await function_info.fn(
                operation="ingest",
                documentRef={"documentId": "doc-1", "sessionId": "session-1"},
                collection_name="nvidia",
                collection_scope="shared",
            )
        finally:
            await generator.aclose()

    result = asyncio.run(_run())

    assert "Shared collection writes are not permitted" in result


def test_user_document_tool_delegates_ingestion_to_one_processor(monkeypatch):
    async def _run():
        import nat_nv_ingest.nat_nv_ingest as mod

        created = []

        class FakeProcessor:
            def __init__(self, config):
                self.config = config
                self.calls = []
                created.append(self)

            async def process_document(self, **kwargs):
                self.calls.append(("ingest", kwargs))
                return {
                    "status": "success",
                    "filename": "single.pdf",
                    "chunks": 1,
                    "failures": 0,
                    "pages": 1,
                    "collection": "user_uploads_alice",
                    "markdown": "",
                    "error": "",
                }

            async def process_multiple_documents(self, **kwargs):
                self.calls.append(("batch", kwargs))
                return "batch-result"

            async def extract_document(self, **kwargs):
                self.calls.append(("extract", kwargs))
                return {
                    "status": "success",
                    "filename": "single.pdf",
                    "pages": 1,
                    "markdown": "extracted",
                    "truncated": False,
                    "original_chars": 9,
                    "error": "",
                }

        monkeypatch.setattr(mod, "NvIngestDocumentProcessor", FakeProcessor)
        monkeypatch.setattr(
            mod,
            "resolve_authenticated_user_id",
            lambda _asserted="": "alice",
        )

        config = NvIngestFunctionConfig()
        generator = nv_ingest_function(config, MagicMock())
        function_info = await generator.__anext__()
        try:
            single = await function_info.fn(
                operation="ingest",
                documentRef={"documentId": "one", "sessionId": "session"},
            )
            batch = await function_info.fn(
                operation="ingest",
                documentRefs=[{"documentId": "two", "sessionId": "session"}],
            )
            extracted = await function_info.fn(
                operation="extract",
                documentRef={"documentId": "three", "sessionId": "session"},
            )
        finally:
            await generator.aclose()

        return config, created, single, batch, extracted

    config, created, single, batch, extracted = asyncio.run(_run())

    assert len(created) == 1
    assert created[0].config is config
    assert [name for name, _kwargs in created[0].calls] == [
        "ingest",
        "batch",
        "extract",
    ]
    assert all(kwargs["username"] == "alice" for _name, kwargs in created[0].calls)
    assert "Successfully processed" in single
    assert batch == "batch-result"
    assert "extracted" in extracted


def test_autonomous_document_ingest_fails_closed_on_ambiguous_reservation(
    monkeypatch,
):
    monkeypatch.setenv("DOCUMENT_OBJECT_ENDPOINT", "minio:9000")
    monkeypatch.setenv("DOCUMENT_OBJECT_ACCESS_KEY", "access")
    monkeypatch.setenv("DOCUMENT_OBJECT_SECRET_KEY", "secret")
    monkeypatch.setenv("DOCUMENT_OBJECT_BUCKET", "nv-ingest")

    async def _run():
        import json

        import nat_nv_ingest.nat_nv_ingest as mod
        from nat_helpers import idempotency
        from nat_helpers.idempotency import Reservation

        captured = {}
        created = []
        object_key = _expected_document_object_key(
            prefix=DEFAULT_DOCUMENT_OBJECT_PREFIX,
            username="alice",
            session_id="session-1",
            document_id="doc-1",
        )
        record = json.dumps(
            {
                "id": "doc-1",
                "sessionId": "session-1",
                "userId": "alice",
                "storage": "object-v1",
                "objectKey": object_key,
                "objectBucket": "nv-ingest",
                "etag": "etag-1",
                "size": 12,
            }
        )

        class FakeProcessor:
            def __init__(self, config):
                self.config = config
                self.calls = []
                created.append(self)

            async def _get_redis(self):
                redis_client = MagicMock()
                redis_client.execute_command.return_value = record
                return redis_client

            async def process_document(self, **kwargs):
                self.calls.append(kwargs)
                raise AssertionError("ambiguous reservation must not repeat ingestion")

        async def reserve_operation(**kwargs):
            captured.update(kwargs)
            return Reservation("key", None, "in_progress")

        monkeypatch.setattr(mod, "NvIngestDocumentProcessor", FakeProcessor)
        monkeypatch.setattr(
            mod, "resolve_authenticated_user_id", lambda _asserted="": "alice"
        )
        monkeypatch.setattr(
            mod, "execution_id_from_context_or_none", lambda: "execution-1"
        )
        monkeypatch.setattr(idempotency, "reserve_operation", reserve_operation)

        generator = nv_ingest_function(
            NvIngestFunctionConfig(
                minio_endpoint="minio:9000",
                minio_access_key="access",
                minio_secret_key="secret",
            ),
            MagicMock(),
        )
        function_info = await generator.__anext__()
        try:
            result = await function_info.fn(
                operation="ingest",
                documentRef={"documentId": "doc-1", "sessionId": "session-1"},
            )
        finally:
            await generator.aclose()
        return result, captured, created

    result, captured, created = asyncio.run(_run())

    assert "wasn't repeated" in result
    assert created[0].calls == []
    assert captured["user_id"] == "alice"
    assert captured["execution_id"] == "execution-1"
    assert captured["arguments"]["collection"] == user_upload_collection_name("alice")
    assert captured["arguments"]["documents"][0]["objectKey"].endswith(
        "/session-1/doc-1"
    )


class TestStoredDocumentAccess:
    def test_allows_current_document_owner(self):
        assert _can_access_stored_document({"userId": "brandon"}, "brandon") is True

    def test_denies_other_document_owner(self):
        assert _can_access_stored_document({"userId": "alice"}, "brandon") is False

    def test_denies_authenticated_user_access_to_ownerless_document(self):
        # F-011 regression: an authenticated user must not read an un-owned
        # (legacy/anonymous) upload that could belong to someone else.
        assert _can_access_stored_document({}, "brandon") is False
        assert _can_access_stored_document({"userId": ""}, "brandon") is False

    def test_allows_anonymous_access_to_ownerless_document(self):
        # Anonymous/unauthenticated self-access to an un-owned upload is allowed
        # (the frontend session-scoped check is the primary gate).
        assert _can_access_stored_document({}, "") is True
        assert _can_access_stored_document({}, None) is True
        assert _can_access_stored_document({}, "anonymous") is True


class TestDedupDocumentRefs:
    def test_drops_repeated_document_ids_keeping_first(self):
        refs = [
            {"documentId": "a", "sessionId": "s1"},
            {"documentId": "b", "sessionId": "s1"},
            {"documentId": "a", "sessionId": "s2"},  # repeat of "a"
        ]
        out = _dedup_document_refs(refs)
        assert [r["documentId"] for r in out] == ["a", "b"]
        assert out[0]["sessionId"] == "s1"  # first occurrence wins

    def test_keeps_refs_without_document_id(self):
        refs = [{"sessionId": "s1"}, {"sessionId": "s2"}]
        assert _dedup_document_refs(refs) == refs

    def test_empty(self):
        assert _dedup_document_refs([]) == []


class TestEmbeddingDimensionValidation:
    class _Client:
        def __init__(self, collections, desc):
            self._collections = collections
            self._desc = desc

        def list_collections(self):
            return self._collections

        def describe_collection(self, _name):
            return self._desc

    def test_extract_dense_dim_prefers_named_field(self):
        desc = {
            "fields": [
                {"name": "id", "params": {}},
                {"name": "vector", "params": {"dim": 1024}},
            ]
        }
        assert _extract_dense_dim(desc, "vector") == 1024

    def test_extract_dense_dim_falls_back_to_first_dim(self):
        desc = {"fields": [{"name": "emb", "params": {"dim": 768}}]}
        assert _extract_dense_dim(desc, "vector") == 768

    def test_extract_dense_dim_none_when_absent(self):
        assert _extract_dense_dim({"fields": []}, "vector") is None

    def test_mismatch_raises(self):
        # F-010 regression: existing collection dim != configured embedder_dim.
        client = self._Client(
            ["nvidia"], {"fields": [{"name": "vector", "params": {"dim": 1024}}]}
        )
        config = NvIngestFunctionConfig(embedder_dim=2048)
        with pytest.raises(ValueError, match="dimension mismatch"):
            _validate_embedding_dimension(config, "nvidia", client=client)

    def test_matching_dim_does_not_raise(self):
        client = self._Client(
            ["nvidia"], {"fields": [{"name": "vector", "params": {"dim": 2048}}]}
        )
        config = NvIngestFunctionConfig(embedder_dim=2048)
        _validate_embedding_dimension(config, "nvidia", client=client)

    def test_absent_collection_is_noop(self):
        client = self._Client([], {})
        config = NvIngestFunctionConfig(embedder_dim=2048)
        _validate_embedding_dimension(config, "nvidia", client=client)


# ---------------------------------------------------------------------------
# clean_markdown
# ---------------------------------------------------------------------------


class TestCleanMarkdown:
    def test_empty_string(self):
        assert clean_markdown("") == ""

    def test_decodes_html_entities(self):
        assert clean_markdown("A&nbsp;&amp;&lt;B&gt;") == "A &<B>"

    def test_strips_wrapper_tags(self):
        assert clean_markdown("<p>hello</p>") == "hello"
        assert clean_markdown("<span>hi</span>") == "hi"

    def test_br_becomes_newline(self):
        assert clean_markdown("a<br>b") == "a\nb"

    def test_smart_quotes_normalized(self):
        assert clean_markdown("“hello”") == '"hello"'
        assert clean_markdown("it’s") == "it's"

    def test_dehyphenation(self):
        assert clean_markdown("hy-\nphen") == "hyphen"

    def test_unicode_invisibles_removed(self):
        assert clean_markdown("a​b﻿c") == "abc"

    def test_whitespace_collapsed(self):
        assert clean_markdown("a   b\t\tc\n\n\n\nd") == "a b c\n\nd"


# ---------------------------------------------------------------------------
# clean_table_markdown
# ---------------------------------------------------------------------------


class TestCleanTableMarkdown:
    def test_empty_string(self):
        assert clean_table_markdown("") == ""

    def test_strips_html_in_cells(self):
        table = "| <span>a</span> | b |\n|---|---|\n| c | d |"
        result = clean_table_markdown(table)
        assert "<span>" not in result
        assert "| a | b |" in result

    def test_drops_empty_trailing_rows(self):
        table = "| a | b |\n| --- | --- |\n| c | d |\n|   |"
        result = clean_table_markdown(table)
        assert result.rstrip().splitlines()[-1] == "| c | d |"

    def test_pads_short_rows(self):
        table = "| a | b | c |\n| --- | --- | --- |\n| x |"
        result = clean_table_markdown(table)
        lines = result.splitlines()
        assert lines[-1].count("|") == 4  # 3 cells + 2 edges = 4 pipes


# ---------------------------------------------------------------------------
# _text_quality_score + _normalize_for_dedup
# ---------------------------------------------------------------------------


class TestTextQualityScore:
    def test_empty(self):
        assert _text_quality_score("") == 0.0

    def test_clean_text(self):
        assert _text_quality_score("hello world") == 1.0

    def test_garbled(self):
        # Half alphanumeric, half symbols
        assert _text_quality_score("abcd!!!!") == 0.5

    def test_ordering(self):
        good = _text_quality_score("the quick brown fox")
        bad = _text_quality_score("!@#$%^&*()")
        assert good > bad


class TestNormalizeForDedup:
    def test_splits_on_whitespace(self):
        assert _normalize_for_dedup("The Quick Brown FOX") == {
            "the",
            "quick",
            "brown",
            "fox",
        }

    def test_strips_punctuation(self):
        assert _normalize_for_dedup("hello, world!") == {"hello", "world"}


# ---------------------------------------------------------------------------
# _dedup_entries
# ---------------------------------------------------------------------------


def _text_entry(page: int, content: str, *, quality_high: bool = True) -> dict:
    """Build a minimal text-type entry for dedup tests."""
    return {
        "document_type": "text",
        "metadata": {
            "content": content,
            "content_metadata": {"page_number": page},
        },
    }


class TestDedupEntries:
    def test_empty_list(self):
        assert _dedup_entries([]) == []

    def test_single_entry(self):
        e = _text_entry(1, "hello world")
        assert _dedup_entries([e]) == [e]

    def test_different_pages_not_dedup(self):
        a = _text_entry(1, "the quick brown fox")
        b = _text_entry(2, "the quick brown fox")
        assert len(_dedup_entries([a, b])) == 2

    def test_same_page_similar_content_dedups(self):
        a = _text_entry(1, "the quick brown fox jumps over the lazy dog")
        b = _text_entry(1, "The quick brown fox jumps over the lazy dog!")
        result = _dedup_entries([a, b])
        assert len(result) == 1

    def test_same_page_different_content_kept(self):
        a = _text_entry(1, "one two three four five")
        b = _text_entry(1, "completely different words here")
        assert len(_dedup_entries([a, b])) == 2

    def test_non_text_entries_passed_through(self):
        image_entry = {
            "document_type": "image",
            "metadata": {
                "image_metadata": {"caption": "chart"},
                "content_metadata": {"page_number": 1},
            },
        }
        result = _dedup_entries([image_entry])
        assert result == [image_entry]


# ---------------------------------------------------------------------------
# results_to_markdown
# ---------------------------------------------------------------------------


class TestResultsToMarkdown:
    def test_empty_results(self):
        assert results_to_markdown([]) == ("", 0)
        assert results_to_markdown([[]]) == ("", 0)

    def test_text_entry(self):
        entry = _text_entry(1, "Hello, world!")
        md, pages = results_to_markdown([[entry]])
        assert "Hello, world!" in md
        assert pages == 1

    def test_page_breaks(self):
        entries = [
            _text_entry(1, "page one text"),
            _text_entry(2, "page two text"),
        ]
        md, pages = results_to_markdown([entries])
        assert "---" in md
        assert pages == 2

    def test_image_with_caption(self):
        entry = {
            "document_type": "image",
            "metadata": {
                "image_metadata": {"caption": "a bar chart"},
                "content_metadata": {"page_number": 1},
            },
        }
        md, pages = results_to_markdown([[entry]])
        assert "*[Image: a bar chart]*" in md
        assert pages == 1

    def test_structured_table(self):
        entry = {
            "document_type": "structured",
            "metadata": {
                "table_metadata": {"table_content": "| a | b |\n|---|---|\n| 1 | 2 |"},
                "content_metadata": {"page_number": 1},
            },
        }
        md, _ = results_to_markdown([[entry]])
        assert "| a | b |" in md

    def test_audio_transcript(self):
        entry = {
            "document_type": "audio",
            "metadata": {
                "audio_metadata": {"audio_transcript": "hello spoken"},
                "content_metadata": {"page_number": 1},
            },
        }
        md, _ = results_to_markdown([[entry]])
        assert "> hello spoken" in md


# ---------------------------------------------------------------------------
# format_single_doc_response
# ---------------------------------------------------------------------------


def _success_result(**overrides) -> IngestResult:
    base: IngestResult = {
        "status": "success",
        "filename": "report.pdf",
        "chunks": 47,
        "failures": 0,
        "pages": 5,
        "collection": "user_uploads",
        "markdown": "# extracted content\n\nparagraph text",
        "error": "",
    }
    base.update(overrides)  # type: ignore[typeddict-item]
    return base


class TestFormatSingleDocResponse:
    def test_failure_returns_error(self):
        result: IngestResult = {
            "status": "failure",
            "filename": "x.pdf",
            "chunks": 0,
            "failures": 0,
            "pages": 0,
            "collection": "",
            "markdown": "",
            "error": "Error: Document not found in storage.",
        }
        out = format_single_doc_response(result)
        assert out == "Error: Document not found in storage."

    def test_success_with_markdown_appends_footer(self):
        out = format_single_doc_response(_success_result())
        assert "extracted content" in out
        assert "1 document indexed" in out
        assert "5 pages" in out
        assert "47 chunks" in out

    def test_success_without_markdown_emits_receipt(self):
        out = format_single_doc_response(_success_result(markdown=""))
        assert out.startswith("✅ Successfully processed")  # ✅
        assert "1 document indexed" in out
        assert "5 pages" in out

    def test_partial_receipt(self):
        result = _success_result(status="partial", failures=3, markdown="")
        out = format_single_doc_response(result)
        assert out.startswith("⚠️ Partially processed")  # ⚠️
        assert "47 chunks successful, 3 failed" in out


# ---------------------------------------------------------------------------
# format_batch_response — includes the Tier 0 regression test
# ---------------------------------------------------------------------------


class TestFormatBatchResponse:
    def test_all_success_emits_frontend_phrases(self):
        """Regression for the batch misclassification bug.

        Before the structured-return refactor, every successful batch document
        was silently classified as failed because `process_document` returned
        the extracted markdown and the batch handler grepped it for
        "Successfully processed". This test locks in the correct behavior:
        structured success results produce a success summary with the
        frontend-parseable phrases.
        """
        successful = [
            {"id": "a.pdf", "chunks": 10, "pages": 2, "status": "success"},
            {"id": "b.pdf", "chunks": 15, "pages": 3, "status": "success"},
            {"id": "c.pdf", "chunks": 20, "pages": 4, "status": "success"},
        ]
        out = format_batch_response(
            total_documents=3,
            successful_documents=successful,
            failed_documents=[],
            total_chunks=45,
            total_pages=9,
            collection_name="user_uploads",
            chunk_size=1024,
            chunk_overlap=150,
        )
        assert "Successfully processed all 3 documents" in out
        assert "3 documents indexed" in out
        assert "9 pages" in out
        # per-file entries
        assert "a.pdf" in out and "b.pdf" in out and "c.pdf" in out
        # must NOT contain the failure header
        assert "Failed to process any documents" not in out

    def test_partial_batch(self):
        out = format_batch_response(
            total_documents=3,
            successful_documents=[
                {"id": "a.pdf", "chunks": 10, "pages": 2, "status": "success"}
            ],
            failed_documents=[{"id": "b.pdf", "error": "oops"}],
            total_chunks=10,
            total_pages=2,
            collection_name="user_uploads",
            chunk_size=1024,
            chunk_overlap=150,
        )
        assert "Partially completed batch processing" in out
        assert "1 documents indexed" in out
        assert "2 pages" in out
        assert "b.pdf" in out

    def test_all_failed(self):
        out = format_batch_response(
            total_documents=2,
            successful_documents=[],
            failed_documents=[
                {"id": "a.pdf", "error": "boom"},
                {"id": "b.pdf", "error": "bang"},
            ],
            total_chunks=0,
            total_pages=0,
            collection_name="user_uploads",
            chunk_size=1024,
            chunk_overlap=150,
        )
        assert "Failed to process any documents" in out
        assert "a.pdf" in out and "b.pdf" in out


# ---------------------------------------------------------------------------
# Progress callback for process_multiple_documents
# ---------------------------------------------------------------------------


class TestProcessMultipleDocumentsProgress:
    def test_progress_callback_is_invoked_per_document(self):
        """``process_multiple_documents`` reports structured progress events."""
        import asyncio
        from unittest.mock import patch

        from nat_nv_ingest.nat_nv_ingest import (
            NvIngestDocumentProcessor,
            NvIngestFunctionConfig,
        )

        processor = NvIngestDocumentProcessor(NvIngestFunctionConfig())

        async def fake_process_document(
            documentRef, username, collection_name, progress_callback=None, **_
        ):
            if progress_callback:
                await progress_callback(
                    {
                        "phase": "fetching",
                        "current": documentRef["filename"],
                        "message": "Fetching from Redis",
                    }
                )
            return {
                "status": "success",
                "filename": documentRef["filename"],
                "chunks": 1,
                "failures": 0,
                "pages": 1,
                "collection": collection_name,
                "markdown": "",
                "error": "",
            }

        events: list[dict] = []

        async def progress_cb(progress: dict) -> None:
            events.append(progress)

        refs = [
            {"documentId": "d1", "sessionId": "s", "filename": "a.pdf"},
            {"documentId": "d2", "sessionId": "s", "filename": "b.pdf"},
            {"documentId": "d3", "sessionId": "s", "filename": "c.pdf"},
        ]

        with patch.object(
            processor, "process_document", side_effect=fake_process_document
        ):
            asyncio.run(
                processor.process_multiple_documents(
                    documentRefs=refs,
                    username="alice",
                    collection_name="alice",
                    progress_callback=progress_cb,
                )
            )

        assert events[0]["completed"] == 0
        assert events[0]["total"] == 3
        assert events[0]["phase"] == "queued"
        assert any(e["phase"] == "fetching" and e["current"] == "a.pdf" for e in events)
        completion_events = [e for e in events if e["completed"] > 0]
        assert any(
            e["completed"] == 3
            and e["total"] == 3
            and e["current"] == "c.pdf"
            and e["phase"] == "completed"
            for e in completion_events
        )
        completed_counts = [e["completed"] for e in events]
        assert completed_counts == sorted(completed_counts)
        assert all(e["total"] == 3 for e in events)
        assert all("percent" in e for e in events)

    def test_progress_callback_exception_is_swallowed(self):
        """A raising callback must not break ingestion."""
        import asyncio
        from unittest.mock import patch

        from nat_nv_ingest.nat_nv_ingest import (
            NvIngestDocumentProcessor,
            NvIngestFunctionConfig,
        )

        processor = NvIngestDocumentProcessor(NvIngestFunctionConfig())

        async def fake_process_document(documentRef, username, collection_name, **_):
            return {
                "status": "success",
                "filename": documentRef["filename"],
                "chunks": 1,
                "failures": 0,
                "pages": 1,
                "collection": collection_name,
                "markdown": "",
                "error": "",
            }

        async def broken_cb(_progress):
            raise RuntimeError("kaboom")

        refs = [{"documentId": "d1", "sessionId": "s", "filename": "a.pdf"}]

        with patch.object(
            processor, "process_document", side_effect=fake_process_document
        ):
            output = asyncio.run(
                processor.process_multiple_documents(
                    documentRefs=refs,
                    username="alice",
                    collection_name="alice",
                    progress_callback=broken_cb,
                )
            )

        assert "Successfully processed all 1 documents" in output

    def test_streamed_failure_message_is_truncated(self):
        """Per-document streamed error text is capped (F-017b)."""
        import asyncio
        from unittest.mock import patch

        from nat_nv_ingest.nat_nv_ingest import (
            ERROR_MESSAGE_CHAR_LIMIT,
            NvIngestDocumentProcessor,
            NvIngestFunctionConfig,
        )

        processor = NvIngestDocumentProcessor(NvIngestFunctionConfig())

        long_error = "boom " * 200  # well over the cap

        async def fake_process_document(documentRef, username, collection_name, **_):
            return {
                "status": "failure",
                "filename": documentRef["filename"],
                "chunks": 0,
                "failures": 0,
                "pages": 0,
                "collection": collection_name,
                "markdown": "",
                "error": long_error,
            }

        events: list[dict] = []

        async def progress_cb(progress: dict) -> None:
            events.append(progress)

        refs = [{"documentId": "d1", "sessionId": "s", "filename": "a.pdf"}]

        with patch.object(
            processor, "process_document", side_effect=fake_process_document
        ):
            asyncio.run(
                processor.process_multiple_documents(
                    documentRefs=refs,
                    username="alice",
                    collection_name="alice",
                    progress_callback=progress_cb,
                )
            )

        failed_events = [
            e
            for e in events
            if e.get("phase") == "failed" and e.get("current") == "a.pdf"
        ]
        assert failed_events, "expected a streamed failure event"
        message = failed_events[-1]["message"]
        # The full untruncated error must not leak into the streamed message.
        assert long_error not in message
        assert "..." in message
        # Bounded: prefix + filename framing only.
        assert len(message) <= len("Failed a.pdf: ") + ERROR_MESSAGE_CHAR_LIMIT + 3

    def test_streamed_exception_message_is_truncated(self):
        """An exception (not a failure result) is also truncated when streamed."""
        import asyncio
        from unittest.mock import patch

        from nat_nv_ingest.nat_nv_ingest import (
            ERROR_MESSAGE_CHAR_LIMIT,
            NvIngestDocumentProcessor,
            NvIngestFunctionConfig,
        )

        processor = NvIngestDocumentProcessor(NvIngestFunctionConfig())

        long_text = "kaboom " * 100

        async def raising_process_document(*_args, **_kwargs):
            raise RuntimeError(long_text)

        events: list[dict] = []

        async def progress_cb(progress: dict) -> None:
            events.append(progress)

        refs = [{"documentId": "d1", "sessionId": "s", "filename": "a.pdf"}]

        with patch.object(
            processor, "process_document", side_effect=raising_process_document
        ):
            asyncio.run(
                processor.process_multiple_documents(
                    documentRefs=refs,
                    username="alice",
                    collection_name="alice",
                    progress_callback=progress_cb,
                )
            )

        failed_events = [e for e in events if e.get("phase") == "failed"]
        assert failed_events
        message = failed_events[-1]["message"]
        assert long_text.strip() not in message
        assert "..." in message
        assert len(message) <= len("Failed a.pdf: ") + ERROR_MESSAGE_CHAR_LIMIT + 3


# ---------------------------------------------------------------------------
# Error truncation (F-017b) — surfaced error text is capped
# ---------------------------------------------------------------------------


class TestTruncateError:
    def test_short_error_passes_through(self):
        assert _truncate_error("boom") == "boom"

    def test_long_error_is_capped_with_ellipsis(self):
        long = "x" * (ERROR_MESSAGE_CHAR_LIMIT + 50)
        out = _truncate_error(long)
        assert out == "x" * ERROR_MESSAGE_CHAR_LIMIT + "..."
        assert len(out) == ERROR_MESSAGE_CHAR_LIMIT + 3

    def test_exactly_at_limit_not_truncated(self):
        exact = "y" * ERROR_MESSAGE_CHAR_LIMIT
        assert _truncate_error(exact) == exact

    def test_coerces_exception_to_string(self):
        assert _truncate_error(ValueError("nope")) == "nope"

    def test_honors_custom_limit(self):
        assert _truncate_error("abcdef", limit=3) == "abc..."


# ---------------------------------------------------------------------------
# Document size cap (F-020) — oversized uploads rejected before decode
# ---------------------------------------------------------------------------


class TestDocumentSizeCap:
    def test_default_max_size_from_env_when_unset(self, monkeypatch):
        monkeypatch.delenv("DOCUMENT_INGEST_MAX_SIZE_BYTES", raising=False)
        assert (
            document_ingest_max_size_bytes() == DEFAULT_DOCUMENT_INGEST_MAX_SIZE_BYTES
        )

    def test_env_override_is_respected(self, monkeypatch):
        monkeypatch.setenv("DOCUMENT_INGEST_MAX_SIZE_BYTES", "12345")
        assert document_ingest_max_size_bytes() == 12345

    def test_invalid_env_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("DOCUMENT_INGEST_MAX_SIZE_BYTES", "not-a-number")
        assert (
            document_ingest_max_size_bytes() == DEFAULT_DOCUMENT_INGEST_MAX_SIZE_BYTES
        )

    def test_non_positive_env_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("DOCUMENT_INGEST_MAX_SIZE_BYTES", "0")
        assert (
            document_ingest_max_size_bytes() == DEFAULT_DOCUMENT_INGEST_MAX_SIZE_BYTES
        )

    def test_estimated_decoded_size_matches_real_decode(self):
        import base64

        raw = b"hello world, this is a small document payload"
        encoded = base64.b64encode(raw).decode("ascii")
        assert _estimated_decoded_size(encoded) == len(raw)


class TestApplyCharLimit:
    def test_none_limit_returns_full_markdown(self):
        assert _apply_char_limit("abcdef", None) == ("abcdef", False)

    def test_under_limit_not_truncated(self):
        assert _apply_char_limit("abc", 10) == ("abc", False)

    def test_equal_length_not_truncated(self):
        assert _apply_char_limit("abc", 3) == ("abc", False)

    def test_over_limit_truncates(self):
        assert _apply_char_limit("abcdef", 3) == ("abc", True)

    def test_empty_markdown(self):
        assert _apply_char_limit("", None) == ("", False)
        assert _apply_char_limit("", 5) == ("", False)


class TestDocumentMarkdownMaxChars:
    def test_default_when_unset(self, monkeypatch):
        monkeypatch.delenv("DOCUMENT_MARKDOWN_MAX_CHARS", raising=False)
        assert document_markdown_max_chars() == DEFAULT_DOCUMENT_MARKDOWN_MAX_CHARS

    def test_env_override_is_respected(self, monkeypatch):
        monkeypatch.setenv("DOCUMENT_MARKDOWN_MAX_CHARS", "500000")
        assert document_markdown_max_chars() == 500000

    def test_invalid_env_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("DOCUMENT_MARKDOWN_MAX_CHARS", "not-a-number")
        assert document_markdown_max_chars() == DEFAULT_DOCUMENT_MARKDOWN_MAX_CHARS

    def test_non_positive_env_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("DOCUMENT_MARKDOWN_MAX_CHARS", "0")
        assert document_markdown_max_chars() == DEFAULT_DOCUMENT_MARKDOWN_MAX_CHARS

    def test_size_error_none_when_within_limit(self):
        import base64

        encoded = base64.b64encode(b"tiny").decode("ascii")
        assert _document_size_error(encoded, max_bytes=1_000) is None

    def test_size_error_returned_when_over_limit(self):
        import base64

        encoded = base64.b64encode(b"x" * 500).decode("ascii")
        err = _document_size_error(encoded, max_bytes=100)
        assert err is not None
        assert err.startswith("Error:")
        assert "maximum allowed size" in err

    def test_process_document_rejects_oversized_payload(self, monkeypatch):
        """Oversized uploads fail cleanly before base64 decoding."""
        import asyncio
        import base64
        import json
        from unittest.mock import AsyncMock, MagicMock, patch

        from nat_nv_ingest.nat_nv_ingest import NvIngestDocumentProcessor

        monkeypatch.setenv("DOCUMENT_INGEST_MAX_SIZE_BYTES", "100")

        processor = NvIngestDocumentProcessor(NvIngestFunctionConfig())

        oversized = base64.b64encode(b"x" * 500).decode("ascii")
        document_record = json.dumps(
            {"data": oversized, "filename": "big.pdf", "userId": "alice"}
        )

        fake_redis = MagicMock()
        fake_redis.execute_command.return_value = document_record

        with (
            patch.object(processor, "_get_redis", AsyncMock(return_value=fake_redis)),
            patch.object(processor, "_get_nv_client", AsyncMock()) as get_nv_client,
        ):
            result = asyncio.run(
                processor.process_document(
                    documentRef={"documentId": "d1", "sessionId": "s"},
                    username="alice",
                    collection_name="alice",
                )
            )

        assert result["status"] == "failure"
        assert "maximum allowed size" in result["error"]
        assert result["filename"] == "big.pdf"
        # Rejected before any NV-Ingest work began.
        get_nv_client.assert_not_called()


class TestDocumentObjectStorage:
    def test_request_timeout_defaults_to_five_minutes(self, monkeypatch):
        monkeypatch.delenv("DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS", raising=False)
        assert _document_object_request_timeout_seconds() == (
            DEFAULT_DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS / 1000
        )

    def test_request_timeout_accepts_bounded_override(self, monkeypatch):
        monkeypatch.setenv("DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS", "1250")
        assert _document_object_request_timeout_seconds() == 1.25

    @pytest.mark.parametrize("value", ["invalid", "0", "99", "900001"])
    def test_request_timeout_rejects_invalid_values(self, monkeypatch, value):
        monkeypatch.setenv("DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS", value)
        with pytest.raises(DocumentStorageError, match="request timeout is invalid"):
            _document_object_request_timeout_seconds()

    def test_minio_client_has_bounded_http_timeouts(self, monkeypatch):
        import sys
        from types import SimpleNamespace
        from unittest.mock import MagicMock, patch

        monkeypatch.setenv("DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS", "2500")
        minio_client = MagicMock()
        minio_constructor = MagicMock(return_value=minio_client)
        http_client = MagicMock()
        timeout = MagicMock()

        with (
            patch.dict(
                sys.modules,
                {"minio": SimpleNamespace(Minio=minio_constructor)},
            ),
            patch(
                "nat_nv_ingest.nat_nv_ingest.urllib3.Timeout",
                return_value=timeout,
            ) as make_timeout,
            patch(
                "nat_nv_ingest.nat_nv_ingest.urllib3.PoolManager",
                return_value=http_client,
            ) as make_pool,
        ):
            result = _make_document_minio_client(
                "minio:9000",
                "access",
                "secret",
                "session-token",
                True,
                "us-east-1",
            )

        assert result is minio_client
        make_timeout.assert_called_once_with(total=2.5, connect=2.5, read=2.5)
        make_pool.assert_called_once_with(timeout=timeout, retries=False)
        minio_constructor.assert_called_once_with(
            "minio:9000",
            access_key="access",
            secret_key="secret",
            session_token="session-token",
            secure=True,
            region="us-east-1",
            http_client=http_client,
        )

    def test_document_object_settings_do_not_reuse_nv_ingest_minio_config(
        self, monkeypatch
    ):
        for name in (
            "DOCUMENT_OBJECT_ENDPOINT",
            "DOCUMENT_OBJECT_ACCESS_KEY",
            "DOCUMENT_OBJECT_SECRET_KEY",
            "DOCUMENT_OBJECT_BUCKET",
        ):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("MINIO_ENDPOINT", "minio:9000")
        monkeypatch.setenv("MINIO_ACCESS_KEY", "broad-access")
        monkeypatch.setenv("MINIO_SECRET_KEY", "broad-secret")
        monkeypatch.setenv("MINIO_BUCKET", "nv-ingest")

        with pytest.raises(DocumentStorageError, match="is not configured"):
            _document_object_settings()

    def test_legacy_base64_record_remains_readable(self):
        import base64

        payload = b"%PDF-legacy"
        result, filename = asyncio.run(
            _load_document_bytes(
                document_record={
                    "data": base64.b64encode(payload).decode("ascii"),
                    "filename": "legacy.pdf",
                    "userId": "alice",
                },
                document_id="doc-1",
                session_id="session-1",
                username="alice",
                config=NvIngestFunctionConfig(),
            )
        )
        assert result == payload
        assert filename == "legacy.pdf"

    def test_object_record_is_streamed_with_exact_size(self, monkeypatch):
        from unittest.mock import MagicMock, patch

        monkeypatch.setenv("DOCUMENT_OBJECT_ENDPOINT", "minio:9000")
        monkeypatch.setenv("DOCUMENT_OBJECT_ACCESS_KEY", "access")
        monkeypatch.setenv("DOCUMENT_OBJECT_SECRET_KEY", "secret")
        monkeypatch.delenv("DOCUMENT_OBJECT_SESSION_TOKEN", raising=False)
        monkeypatch.setenv("DOCUMENT_OBJECT_BUCKET", "documents")
        payload = b"%PDF-object"
        key = _expected_document_object_key(
            prefix=DEFAULT_DOCUMENT_OBJECT_PREFIX,
            username="alice",
            session_id="session-1",
            document_id="doc-1",
        )
        response = MagicMock()
        chunks = iter([payload[:4], payload[4:], b""])
        response.read.side_effect = lambda _size: next(chunks)
        client = MagicMock()
        client.get_object.return_value = response
        config = NvIngestFunctionConfig()

        with patch(
            "nat_nv_ingest.nat_nv_ingest._make_document_minio_client",
            return_value=client,
        ):
            result, filename = asyncio.run(
                _load_document_bytes(
                    document_record={
                        "storage": "object-v1",
                        "objectKey": key,
                        "objectBucket": "documents",
                        "size": len(payload),
                        "filename": "object.pdf",
                        "userId": "alice",
                    },
                    document_id="doc-1",
                    session_id="session-1",
                    username="alice",
                    config=config,
                )
            )

        assert result == payload
        assert filename == "object.pdf"
        client.get_object.assert_called_once_with("documents", key)
        response.close.assert_called_once()
        response.release_conn.assert_called_once()

    def test_object_record_passes_temporary_session_token(self, monkeypatch):
        from unittest.mock import MagicMock, patch

        monkeypatch.setenv("DOCUMENT_OBJECT_SESSION_TOKEN", "temporary-token")
        monkeypatch.setenv("DOCUMENT_OBJECT_ENDPOINT", "minio:9000")
        monkeypatch.setenv("DOCUMENT_OBJECT_ACCESS_KEY", "access")
        monkeypatch.setenv("DOCUMENT_OBJECT_SECRET_KEY", "secret")
        monkeypatch.setenv("DOCUMENT_OBJECT_BUCKET", "documents")
        payload = b"%PDF-object"
        key = _expected_document_object_key(
            prefix=DEFAULT_DOCUMENT_OBJECT_PREFIX,
            username="alice",
            session_id="session-1",
            document_id="doc-1",
        )
        response = MagicMock()
        response.read.side_effect = [payload, b""]
        client = MagicMock()
        client.get_object.return_value = response
        config = NvIngestFunctionConfig()

        with patch(
            "nat_nv_ingest.nat_nv_ingest._make_document_minio_client",
            return_value=client,
        ) as make_client:
            result, _ = asyncio.run(
                _load_document_bytes(
                    document_record={
                        "storage": "object-v1",
                        "objectKey": key,
                        "objectBucket": "documents",
                        "size": len(payload),
                        "filename": "object.pdf",
                        "userId": "alice",
                    },
                    document_id="doc-1",
                    session_id="session-1",
                    username="alice",
                    config=config,
                )
            )

        assert result == payload
        make_client.assert_called_once_with(
            "minio:9000",
            "access",
            "secret",
            "temporary-token",
            False,
            "us-east-1",
        )

    def test_object_record_rejects_a_foreign_key_before_fetch(self, monkeypatch):
        monkeypatch.setenv("DOCUMENT_OBJECT_ENDPOINT", "minio:9000")
        monkeypatch.setenv("DOCUMENT_OBJECT_ACCESS_KEY", "access")
        monkeypatch.setenv("DOCUMENT_OBJECT_SECRET_KEY", "secret")
        monkeypatch.setenv("DOCUMENT_OBJECT_BUCKET", "nv-ingest")
        record = {
            "storage": "object-v1",
            "objectKey": "daedalus-documents/foreign/session-1/doc-1",
            "objectBucket": "nv-ingest",
            "size": 10,
            "filename": "object.pdf",
            "userId": "alice",
        }
        with pytest.raises(DocumentStorageError, match="reference is invalid"):
            asyncio.run(
                _load_document_bytes(
                    document_record=record,
                    document_id="doc-1",
                    session_id="session-1",
                    username="alice",
                    config=NvIngestFunctionConfig(),
                )
            )
