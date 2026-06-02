"""Schema-level tests for the /v1/documents/* FastAPI routes."""

import json
import sys
from pathlib import Path

# document_ingest_api.py lives at the workspace root inside the Docker image.
# Make it importable from the builder/ test run, too.
_BUILDER_ROOT = Path(__file__).resolve().parent.parent
if str(_BUILDER_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUILDER_ROOT))

import document_ingest_api  # noqa: E402
import nat_helpers.internal_auth as internal_auth  # noqa: E402
import pytest  # noqa: E402
from document_ingest_api import (  # noqa: E402
    DocumentRef,
    IngestRequest,
    _default_config,
    _redis_url,
    _require_trusted_user,
    _resolve_request,
    router,
)
from pydantic import ValidationError  # noqa: E402


class _FakeHTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _raises_status(monkeypatch, *args):
    """Call _require_trusted_user with fastapi.HTTPException swapped for a real
    exception class (it is a MagicMock under conftest), returning the status.
    The auth helpers now live in nat_helpers.internal_auth (F-019), so patch
    HTTPException there."""
    monkeypatch.setattr(internal_auth, "HTTPException", _FakeHTTPException)
    with pytest.raises(_FakeHTTPException) as exc_info:
        _require_trusted_user(*args)
    return exc_info.value.status_code


class TestRouter:
    def test_router_exists(self):
        # FastAPI is mocked in conftest, so we can't introspect routes here -
        # just confirm the module imported and exposed a router object.
        assert router is not None


class TestInternalAuth:
    def test_fails_closed_when_token_unconfigured(self, monkeypatch):
        # F-003 regression: no internal token + no explicit opt-out must REFUSE
        # (503), never fall through to trusting the caller-supplied x-user-id.
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)
        assert _raises_status(monkeypatch, "alice", None) == 503

    def test_insecure_optout_allows_when_unconfigured(self, monkeypatch):
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        assert _require_trusted_user(" alice ") == "alice"

    def test_rejects_missing_user_under_optout(self, monkeypatch):
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        assert _raises_status(monkeypatch, None) == 401

    def test_requires_internal_token_when_configured(self, monkeypatch):
        monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "secret-token")
        assert _raises_status(monkeypatch, "alice", None) == 401

    def test_accepts_matching_internal_token(self, monkeypatch):
        monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "secret-token")
        assert _require_trusted_user(" alice ", "secret-token") == "alice"

    def test_rejects_missing_user_with_token(self, monkeypatch):
        monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "secret-token")
        assert _raises_status(monkeypatch, None, "secret-token") == 401

    def test_sse_serializes_structured_progress_events(self):
        chunk = document_ingest_api._sse(
            "progress",
            {
                "completed": 0,
                "total": 1,
                "percent": 0,
                "phase": "queued",
                "message": "Queued 1 document for ingestion",
            },
        )

        event_lines = chunk.splitlines()
        assert event_lines[0] == "event: progress"
        payload = json.loads(event_lines[1].removeprefix("data: "))
        assert payload["completed"] == 0
        assert payload["total"] == 1
        assert payload["percent"] == 0
        assert payload["phase"] == "queued"


class TestIngestRequest:
    def test_accepts_multi_document_refs(self):
        req = IngestRequest(
            documentRefs=[
                DocumentRef(documentId="doc-a", sessionId="sess-1"),
                DocumentRef(documentId="doc-b", sessionId="sess-1"),
            ],
            collection_name="nvidia",
            collection_scope="shared",
            provenance={
                "uploader": "alice",
                "source": "test",
                "targetCollection": "nvidia",
            },
            username="alice",
        )

        assert len(req.documentRefs or []) == 2
        assert req.collection_name == "nvidia"
        assert req.collection_scope == "shared"
        assert req.provenance["uploader"] == "alice"
        assert req.username == "alice"

    def test_resolve_request_rejects_collection_scope_mismatch(self, monkeypatch):
        # Auth is covered separately (TestInternalAuth); opt out here so the test
        # reaches the collection-scope validation it actually exercises.
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)

        req = IngestRequest(
            documentRef=DocumentRef(documentId="doc-a", sessionId="sess-1"),
            collection_name="nvidia",
            collection_scope="user",
            username="alice",
        )
        with pytest.raises(_FakeHTTPException) as exc_info:
            _resolve_request(req, "alice")

        assert exc_info.value.status_code == 400
        assert "does not match" in exc_info.value.detail

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
        monkeypatch.delenv("MILVUS_USERNAME", raising=False)
        monkeypatch.delenv("MILVUS_USER", raising=False)
        monkeypatch.delenv("MILVUS_PASSWORD", raising=False)
        monkeypatch.delenv("MILVUS_TOKEN", raising=False)

        config = _default_config()

        assert config.redis_url == "redis://daedalus-redis.daedalus.svc.cluster.local"
        assert config.nv_ingest_host == "nv-ingest.nv-ingest.svc.cluster.local"
        assert config.milvus_uri == "http://milvus.milvus.svc.cluster.local:19530"
        assert config.milvus_username is None
        assert config.milvus_password is None
        assert config.milvus_token is None

    def test_default_config_uses_milvus_auth_env(self, monkeypatch):
        monkeypatch.setenv("MILVUS_USERNAME", "root")
        monkeypatch.setenv("MILVUS_PASSWORD", "Milvus")
        monkeypatch.setenv("MILVUS_TOKEN", "root:Milvus")

        config = _default_config()

        assert config.milvus_username == "root"
        assert config.milvus_password == "Milvus"
        assert config.milvus_token == "root:Milvus"
