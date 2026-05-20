"""Schema-level tests for the /v1/documents/* FastAPI routes."""

import sys
from pathlib import Path

# document_ingest_api.py lives at the workspace root inside the Docker image.
# Make it importable from the builder/ test run, too.
_BUILDER_ROOT = Path(__file__).resolve().parent.parent
if str(_BUILDER_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUILDER_ROOT))

import pytest  # noqa: E402
import document_ingest_api  # noqa: E402
from document_ingest_api import (  # noqa: E402
    DocumentRef,
    IngestRequest,
    _default_config,
    _redis_url,
    _require_trusted_user,
    router,
)
from pydantic import ValidationError  # noqa: E402


class TestRouter:
    def test_router_exists(self):
        # FastAPI is mocked in conftest, so we can't introspect routes here -
        # just confirm the module imported and exposed a router object.
        assert router is not None

    def test_requires_trusted_user_header(self):
        class FakeHTTPException(Exception):
            def __init__(self, status_code, detail):
                super().__init__(detail)
                self.status_code = status_code
                self.detail = detail

        original = document_ingest_api.HTTPException
        document_ingest_api.HTTPException = FakeHTTPException
        try:
            with pytest.raises(FakeHTTPException) as exc_info:
                _require_trusted_user(None)
        finally:
            document_ingest_api.HTTPException = original
        assert exc_info.value.status_code == 401

    def test_accepts_trusted_user_header(self):
        assert _require_trusted_user(" alice ") == "alice"

    def test_requires_internal_token_when_configured(self, monkeypatch):
        class FakeHTTPException(Exception):
            def __init__(self, status_code, detail):
                super().__init__(detail)
                self.status_code = status_code
                self.detail = detail

        monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "secret-token")
        original = document_ingest_api.HTTPException
        document_ingest_api.HTTPException = FakeHTTPException
        try:
            with pytest.raises(FakeHTTPException) as exc_info:
                _require_trusted_user("alice", None)
        finally:
            document_ingest_api.HTTPException = original
        assert exc_info.value.status_code == 401

    def test_accepts_matching_internal_token(self, monkeypatch):
        monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "secret-token")
        assert _require_trusted_user(" alice ", "secret-token") == "alice"


class TestIngestRequest:
    def test_accepts_multi_document_refs(self):
        req = IngestRequest(
            documentRefs=[
                DocumentRef(documentId="doc-a", sessionId="sess-1"),
                DocumentRef(documentId="doc-b", sessionId="sess-1"),
            ],
            collection_name="nvidia",
            username="alice",
        )

        assert len(req.documentRefs or []) == 2
        assert req.collection_name == "nvidia"
        assert req.username == "alice"

    def test_rejects_empty_document_id(self):
        with pytest.raises(ValidationError):
            DocumentRef(documentId="", sessionId="sess-1")

    def test_rejects_empty_session_id(self):
        with pytest.raises(ValidationError):
            DocumentRef(documentId="doc-a", sessionId="")


class TestConfig:
    def test_redis_url_adds_separate_port(self, monkeypatch):
        monkeypatch.setenv("REDIS_URL", "redis://redis.example")
        monkeypatch.setenv("REDIS_PORT", "6379")

        assert _redis_url() == "redis://redis.example:6379"

    def test_default_config_uses_cluster_services(self, monkeypatch):
        monkeypatch.delenv("REDIS_URL", raising=False)
        monkeypatch.delenv("REDIS_PORT", raising=False)
        monkeypatch.delenv("NV_INGEST_HOST", raising=False)
        monkeypatch.delenv("MILVUS_URI", raising=False)

        config = _default_config()

        assert config.redis_url == "redis://daedalus-redis.daedalus.svc.cluster.local"
        assert config.nv_ingest_host == "nv-ingest.nv-ingest.svc.cluster.local"
        assert config.milvus_uri == "http://milvus.milvus.svc.cluster.local:19530"
