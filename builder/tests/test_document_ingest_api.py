"""Schema-level tests for the /v1/documents/* FastAPI routes."""

import asyncio
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
    MarkdownRequest,
    _create_markdown_download_response,
    _default_config,
    _markdown_filename,
    _redis_url,
    _require_trusted_user,
    _resolve_request,
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


class _RecordingRouter:
    """Record route registrations; conftest replaces FastAPI with a MagicMock."""

    def __init__(self, prefix="", **_kwargs):
        self.prefix = prefix
        self.routes = set()

    def post(self, path, **_kwargs):
        def decorate(handler):
            self.routes.add(("POST", self.prefix + path))
            return handler

        return decorate


class TestRouter:
    def test_rollback_routes_match_the_paths_rust_proxies(self, monkeypatch):
        # With DAEDALUS_PREPARATION=python, Rust's document_ingest_api.rs and
        # document_api.rs forward exactly these paths to this router.
        import importlib.util

        import fastapi

        monkeypatch.setattr(fastapi, "APIRouter", _RecordingRouter)
        spec = importlib.util.spec_from_file_location(
            "document_ingest_route_contract", document_ingest_api.__file__
        )
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, module)
        spec.loader.exec_module(module)

        assert module.router.routes == {
            ("POST", "/v1/documents/ingest"),
            ("POST", "/v1/documents/ingest/stream"),
            ("POST", "/v1/documents/extract"),
            ("POST", "/v1/documents/markdown"),
        }

    @pytest.mark.parametrize("fail", [False, True])
    def test_public_stream_keeps_internal_indexing_out_of_progress(
        self, monkeypatch, fail
    ):
        """Rollback emits the same public phases as native ingestion.

        The processor still reports its write boundary internally, including
        before an uncertain write failure. It must not add a public SSE event.
        """
        import importlib.util

        import fastapi

        monkeypatch.setattr(fastapi, "APIRouter", _RecordingRouter)
        spec = importlib.util.spec_from_file_location(
            "document_ingest_stream_contract", document_ingest_api.__file__
        )
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, module)
        spec.loader.exec_module(module)
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        monkeypatch.setattr(
            module, "StreamingResponse", lambda content, **_kwargs: content
        )
        emitted = []
        fields = {
            "completed": 0,
            "total": 1,
            "current": "a.txt",
            "currentIndex": 1,
            "chunks": None,
            "pages": None,
            "failures": None,
            "attempt": None,
        }
        processing = {
            **fields,
            "percent": 42,
            "phase": "processing",
            "message": "Processing document",
        }
        indexing = {
            **fields,
            "percent": 70,
            "phase": "indexing",
            "message": "NV-Ingest extraction finished; writing chunks to Milvus",
        }
        postprocessing = {
            **fields,
            "percent": 95,
            "phase": "postprocessing",
            "message": "Finishing document",
        }

        class Processor:
            async def process_multiple_documents(self, *, progress_callback, **_):
                for event in (processing, indexing, postprocessing):
                    emitted.append(event)
                    await progress_callback(event)
                if fail:
                    raise RuntimeError("synthetic internal error")
                return "Processed document"

        monkeypatch.setattr(module, "_processor", Processor)

        async def collect():
            stream = await module.ingest_stream(
                module.IngestRequest(
                    documentRef=module.DocumentRef(documentId="d", sessionId="s")
                ),
                "alice",
            )
            return [chunk async for chunk in stream]

        frames = [
            (
                chunk.splitlines()[0].removeprefix("event: "),
                json.loads(chunk.splitlines()[1].removeprefix("data: ")),
            )
            for chunk in asyncio.run(collect())
        ]
        terminal = (
            ("error", {"detail": "Document operation failed."})
            if fail
            else (
                "complete",
                {
                    "status": "success",
                    "collection": "user_uploads",
                    "documents": 1,
                    "output": "Processed document",
                },
            )
        )
        assert emitted == [processing, indexing, postprocessing]
        assert frames == [
            (
                "progress",
                {
                    "completed": 0,
                    "total": 1,
                    "current": None,
                    "currentIndex": None,
                    "percent": 0,
                    "phase": "queued",
                    "message": "Queued 1 document for ingestion",
                },
            ),
            ("progress", processing),
            ("progress", postprocessing),
            terminal,
        ]


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

    def test_resolve_request_rejects_shared_collection_write(self, monkeypatch):
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)

        req = IngestRequest(
            documentRef=DocumentRef(documentId="doc-a", sessionId="sess-1"),
            collection_name="nvidia",
            collection_scope="shared",
            username="alice",
        )
        with pytest.raises(_FakeHTTPException) as exc_info:
            _resolve_request(req, "alice")

        assert exc_info.value.status_code == 403
        assert "Shared collection writes" in exc_info.value.detail

    @pytest.mark.parametrize("body_username", ["mallory", " mallory "])
    def test_body_username_cannot_select_another_identity(
        self, monkeypatch, body_username
    ):
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)
        req = IngestRequest(
            documentRef=DocumentRef(documentId="doc-a", sessionId="sess-1"),
            username=body_username,
        )

        with pytest.raises(_FakeHTTPException) as exc_info:
            _resolve_request(req, "alice")

        assert exc_info.value.status_code == 403

    def test_trusted_identity_selects_the_private_collection(self, monkeypatch):
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        req = IngestRequest(
            documentRefs=[DocumentRef(documentId="doc-a", sessionId="sess-1")]
        )

        username, refs, collection, scope, _provenance = _resolve_request(
            req, " alice "
        )

        # Without a collection the upload targets the advertised private
        # default, the one default search reads, not one named after the user.
        assert (username, collection, scope) == ("alice", "user_uploads", "user")
        assert refs == [{"documentId": "doc-a", "sessionId": "sess-1"}]

    def test_rejects_batches_above_the_request_limit(self, monkeypatch):
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)
        monkeypatch.setattr(document_ingest_api, "MAX_DOCUMENTS_PER_REQUEST", 1)
        req = IngestRequest(
            documentRefs=[
                DocumentRef(documentId="doc-a", sessionId="sess-1"),
                DocumentRef(documentId="doc-b", sessionId="sess-1"),
            ]
        )

        with pytest.raises(_FakeHTTPException) as exc_info:
            _resolve_request(req, "alice")

        assert exc_info.value.status_code == 413

    def test_rejects_empty_document_id(self):
        with pytest.raises(ValidationError):
            DocumentRef(documentId="", sessionId="sess-1")

    def test_rejects_empty_session_id(self):
        with pytest.raises(ValidationError):
            DocumentRef(documentId="doc-a", sessionId="")


class TestMarkdownRequest:
    def test_requires_document_ref(self):
        with pytest.raises(ValidationError):
            MarkdownRequest(username="alice")

    def test_accepts_single_document_ref(self):
        req = MarkdownRequest(
            documentRef=DocumentRef(documentId="doc-a", sessionId="sess-1"),
            username="alice",
        )
        assert req.documentRef.documentId == "doc-a"
        assert req.username == "alice"

    def test_rejects_empty_document_id(self):
        with pytest.raises(ValidationError):
            MarkdownRequest(
                documentRef=DocumentRef(documentId="", sessionId="sess-1"),
            )


class TestMarkdownFilename:
    def test_strips_extension_and_appends_md(self):
        assert _markdown_filename("Report Q3.pdf") == "Report_Q3.md"

    def test_strips_path_traversal(self):
        assert _markdown_filename("../../etc/passwd") == "passwd.md"

    def test_sanitizes_header_injection_chars(self):
        result = _markdown_filename('a"; rm -rf;.docx')
        assert result.endswith(".md")
        for bad in ('"', ";", " ", "\n", "/", "\\"):
            assert bad not in result

    def test_empty_and_none_fall_back(self):
        assert _markdown_filename("") == "document.md"
        assert _markdown_filename(None) == "document.md"

    def test_dotfile_falls_back(self):
        # rsplit('.', 1)[0] on ".gitignore" is empty -> fall back.
        assert _markdown_filename(".gitignore") == "document.md"

    def test_bounds_length(self):
        result = _markdown_filename("a" * 500 + ".pdf")
        assert result.endswith(".md")
        assert len(result) <= 131  # 128 stem + ".md"


class TestMarkdownDownload:
    def test_requests_the_complete_document_without_a_char_limit(self, monkeypatch):
        markdown_body = "# Full document\n\nLast paragraph.\n"
        calls = []

        class FakeProcessor:
            async def extract_document(self, **kwargs):
                calls.append(kwargs)
                return {
                    "status": "success",
                    "filename": "report.pdf",
                    "pages": 3,
                    "markdown": markdown_body,
                    "truncated": False,
                    "original_chars": len(markdown_body),
                    "error": "",
                }

        monkeypatch.setattr(document_ingest_api, "_processor", FakeProcessor)
        monkeypatch.setattr(
            document_ingest_api,
            "Response",
            lambda **kwargs: kwargs,
        )

        response = asyncio.run(
            _create_markdown_download_response(
                MarkdownRequest(
                    documentRef=DocumentRef(
                        documentId="doc-a",
                        sessionId="session-a",
                    ),
                    username="alice",
                ),
                "alice",
            )
        )

        assert calls == [
            {
                "documentRef": {
                    "documentId": "doc-a",
                    "sessionId": "session-a",
                },
                "username": "alice",
                "char_limit": None,
            }
        ]
        assert response["content"] == markdown_body.encode("utf-8")
        assert response["media_type"] == "text/markdown; charset=utf-8"
        assert "X-Document-Truncated" not in response["headers"]

    def test_body_username_cannot_download_another_users_document(self, monkeypatch):
        calls = []

        class FakeProcessor:
            async def extract_document(self, **kwargs):
                calls.append(kwargs)
                raise AssertionError("ownership mismatch reached the extractor")

        monkeypatch.setattr(document_ingest_api, "_processor", FakeProcessor)
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)

        with pytest.raises(_FakeHTTPException) as exc_info:
            asyncio.run(
                _create_markdown_download_response(
                    MarkdownRequest(
                        documentRef=DocumentRef(
                            documentId="doc-a", sessionId="session-a"
                        ),
                        username="mallory",
                    ),
                    "alice",
                )
            )

        assert exc_info.value.status_code == 403
        assert calls == []

    def test_rejects_an_incomplete_markdown_result(self, monkeypatch):
        class FakeProcessor:
            async def extract_document(self, **_kwargs):
                return {
                    "status": "success",
                    "filename": "report.pdf",
                    "pages": 3,
                    "markdown": "partial",
                    "truncated": True,
                    "original_chars": 100,
                    "error": "",
                }

        monkeypatch.setattr(document_ingest_api, "_processor", FakeProcessor)
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)

        with pytest.raises(_FakeHTTPException) as exc_info:
            asyncio.run(
                _create_markdown_download_response(
                    MarkdownRequest(
                        documentRef=DocumentRef(
                            documentId="doc-a",
                            sessionId="session-a",
                        ),
                        username="alice",
                    ),
                    "alice",
                )
            )

        assert exc_info.value.status_code == 500
        assert "incomplete Markdown" in exc_info.value.detail


class TestExtractFailureMapping:
    def test_unclassified_failure_does_not_expose_internal_detail(self, monkeypatch):
        private_error = "database secret-host password=private"
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)

        with pytest.raises(_FakeHTTPException) as exc_info:
            document_ingest_api._raise_for_extract_failure(private_error)

        assert exc_info.value.status_code == 500
        assert exc_info.value.detail == "Document operation failed."
        assert private_error not in exc_info.value.detail

    @pytest.mark.parametrize(
        "message,status",
        [
            ("Error: Document not found in storage.", 404),
            ("Error: The file may have expired.", 404),
            (
                "Error: Document exceeds the maximum allowed size (100 bytes).",
                413,
            ),
            (
                "Error extracting document with NvIngest: timed out after 300 seconds.",
                504,
            ),
            ("Error: Invalid document reference provided.", 400),
            ("Error: Valid username required for document extraction.", 400),
            ("Error: Retrieved document data is empty.", 400),
            ("An unexpected error occurred: boom", 500),
        ],
    )
    def test_maps_failure_to_status(self, monkeypatch, message, status):
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)
        with pytest.raises(_FakeHTTPException) as exc_info:
            document_ingest_api._raise_for_extract_failure(message)
        assert exc_info.value.status_code == status

    @pytest.mark.parametrize(
        "message,kind,status",
        [
            ("Error: You do not have access to this document.", "forbidden", 403),
            (
                "Error accessing document storage: Connection refused",
                "unavailable",
                503,
            ),
            (
                "Error accessing document object storage. "
                "Please upload the document again.",
                "unavailable",
                503,
            ),
            # Untyped text never grants an authorization status, as in Rust.
            ("Error accessing document storage: Connection refused", "", 500),
        ],
    )
    def test_maps_typed_storage_failures_like_rust(
        self, monkeypatch, message, kind, status
    ):
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)
        with pytest.raises(_FakeHTTPException) as exc_info:
            document_ingest_api._raise_for_extract_failure(message, kind)
        assert exc_info.value.status_code == status


class _FakeRedisError(Exception):
    pass


class TestStorageOutageStatus:
    """The Python rollback route classifies the extractor's real failures."""

    @staticmethod
    def _download(monkeypatch, *, redis_getter, load_bytes=None):
        from nat_nv_ingest import nat_nv_ingest as ingest

        monkeypatch.setattr(ingest.redis, "RedisError", _FakeRedisError)
        if load_bytes is not None:
            monkeypatch.setattr(ingest, "_load_document_bytes", load_bytes)

        class Processor:
            async def extract_document(self, **kwargs):
                return await ingest._extract_document_to_markdown(
                    config=ingest.NvIngestFunctionConfig(),
                    redis_getter=redis_getter,
                    nv_getter=None,
                    **kwargs,
                )

        monkeypatch.setattr(document_ingest_api, "_processor", Processor)
        monkeypatch.setattr(document_ingest_api, "HTTPException", _FakeHTTPException)
        with pytest.raises(_FakeHTTPException) as exc_info:
            asyncio.run(
                _create_markdown_download_response(
                    MarkdownRequest(
                        documentRef=DocumentRef(documentId="d", sessionId="s"),
                        username="alice",
                    ),
                    "alice",
                )
            )
        return exc_info.value

    @staticmethod
    def _redis_with(record):
        class Client:
            def execute_command(self, *_args):
                return json.dumps(record)

        async def getter():
            return Client()

        return getter

    def test_unreachable_redis_is_service_unavailable(self, monkeypatch):
        async def unreachable():
            raise _FakeRedisError("Error 111 connecting to redis:6379.")

        error = self._download(monkeypatch, redis_getter=unreachable)
        assert error.status_code == 503
        assert error.detail.startswith("Error accessing document storage")

    def test_object_storage_outage_is_service_unavailable(self, monkeypatch):
        from nat_nv_ingest import nat_nv_ingest as ingest

        async def outage(**_kwargs):
            raise ingest.DocumentStorageUnavailableError(
                "Error accessing document object storage. "
                "Please upload the document again."
            )

        error = self._download(
            monkeypatch,
            redis_getter=self._redis_with({"userId": "alice", "filename": "a.pdf"}),
            load_bytes=outage,
        )
        assert error.status_code == 503

    def test_another_users_document_is_forbidden(self, monkeypatch):
        error = self._download(
            monkeypatch,
            redis_getter=self._redis_with({"userId": "bob", "filename": "a.pdf"}),
        )
        assert error.status_code == 403
        assert "do not have access" in error.detail

    def test_invalid_stored_reference_keeps_its_client_status(self, monkeypatch):
        from nat_nv_ingest import nat_nv_ingest as ingest

        async def invalid(**_kwargs):
            raise ingest.DocumentStorageError(
                "Error: Stored document object reference is invalid."
            )

        error = self._download(
            monkeypatch,
            redis_getter=self._redis_with({"userId": "alice", "filename": "a.pdf"}),
            load_bytes=invalid,
        )
        assert error.status_code == 400


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
        monkeypatch.delenv("MINIO_ACCESS_KEY", raising=False)
        monkeypatch.delenv("MINIO_SECRET_KEY", raising=False)

        config = _default_config()

        assert config.redis_url == "redis://daedalus-redis.daedalus.svc.cluster.local"
        assert config.nv_ingest_host == "nv-ingest.daedalus.svc.cluster.local"
        assert config.milvus_uri == "http://milvus.daedalus.svc.cluster.local:19530"
        assert config.milvus_username is None
        assert config.milvus_password is None
        assert config.milvus_token is None
        assert config.minio_access_key == ""
        assert config.minio_secret_key == ""

    def test_default_config_uses_milvus_auth_env(self, monkeypatch):
        monkeypatch.setenv("MILVUS_USERNAME", "root")
        monkeypatch.setenv("MILVUS_PASSWORD", "Milvus")
        monkeypatch.setenv("MILVUS_TOKEN", "root:Milvus")

        config = _default_config()

        assert config.milvus_username == "root"
        assert config.milvus_password == "Milvus"
        assert config.milvus_token == "root:Milvus"
