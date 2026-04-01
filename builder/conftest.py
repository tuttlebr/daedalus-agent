"""
Shared pytest configuration for all builder package tests.

Sets up sys.path for all package src/ directories and mocks NAT framework
and other heavy external dependencies before any test module is imported.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# sys.path: add every package's src/ directory so imports work without install
# ---------------------------------------------------------------------------
BUILDER_DIR = Path(__file__).parent
for _pkg_dir in sorted(BUILDER_DIR.iterdir()):
    _src = _pkg_dir / "src"
    if _src.is_dir() and str(_src) not in sys.path:
        sys.path.insert(0, str(_src))


# ---------------------------------------------------------------------------
# NAT framework mocks (not installable outside container)
# ---------------------------------------------------------------------------
try:
    from pydantic import BaseModel as _BaseModel

    class _FakeFunctionBaseConfig(_BaseModel):
        """Drop-in for nat.data_models.function.FunctionBaseConfig."""

        model_config = {"arbitrary_types_allowed": True}

        def __init_subclass__(cls, name: str = "", **kwargs):  # noqa: ARG003
            super().__init_subclass__(**kwargs)

except ImportError:  # pragma: no cover
    _FakeFunctionBaseConfig = MagicMock  # type: ignore[misc,assignment]


class _FakeFunctionInfo:
    """Drop-in for nat.builder.function_info.FunctionInfo."""

    def __init__(self, fn=None, description: str = ""):
        self.fn = fn
        self.description = description

    @classmethod
    def from_fn(cls, fn, description: str = "") -> "_FakeFunctionInfo":
        return cls(fn=fn, description=description)

    @classmethod
    def create(cls, single_fn=None, description: str = "") -> "_FakeFunctionInfo":
        return cls(fn=single_fn, description=description)


def _fake_register_function(config_type=None, **_kwargs):  # noqa: ARG001
    """Identity decorator replacing nat.cli.register_workflow.register_function."""

    def decorator(fn):
        return fn

    return decorator


_nat_function_info_mod = MagicMock()
_nat_function_info_mod.FunctionInfo = _FakeFunctionInfo

_nat_data_models_function_mod = MagicMock()
_nat_data_models_function_mod.FunctionBaseConfig = _FakeFunctionBaseConfig

_nat_register_mod = MagicMock()
_nat_register_mod.register_function = _fake_register_function


class _FakeRetriever:
    """Drop-in for nat.retriever.interface.Retriever."""


class _FakeRetrieverError(Exception):
    """Drop-in for nat.retriever.models.RetrieverError."""


class _FakeDocument:
    """Drop-in for nat.retriever.models.Document."""

    def __init__(self, page_content: str = "", metadata: dict | None = None):
        self.page_content = page_content
        self.metadata = metadata if metadata is not None else {}


class _FakeRetrieverOutput:
    """Drop-in for nat.retriever.models.RetrieverOutput."""

    def __init__(self, results: list | None = None):
        self.results = results if results is not None else []


_nat_retriever_interface_mod = MagicMock()
_nat_retriever_interface_mod.Retriever = _FakeRetriever

_nat_retriever_models_mod = MagicMock()
_nat_retriever_models_mod.Document = _FakeDocument
_nat_retriever_models_mod.RetrieverError = _FakeRetrieverError
_nat_retriever_models_mod.RetrieverOutput = _FakeRetrieverOutput

_NAT_MOCKS: dict[str, object] = {
    "nat": MagicMock(),
    "nat.builder": MagicMock(),
    "nat.builder.builder": MagicMock(),
    "nat.builder.framework_enum": MagicMock(),
    "nat.builder.function_info": _nat_function_info_mod,
    "nat.cli": MagicMock(),
    "nat.cli.register_workflow": _nat_register_mod,
    "nat.data_models": MagicMock(),
    "nat.data_models.function": _nat_data_models_function_mod,
    "nat.retriever": MagicMock(),
    "nat.retriever.interface": _nat_retriever_interface_mod,
    "nat.retriever.models": _nat_retriever_models_mod,
}

for _mod_name, _mock in _NAT_MOCKS.items():
    sys.modules.setdefault(_mod_name, _mock)  # type: ignore[arg-type]

# ---------------------------------------------------------------------------
# Other heavy external dependencies that may not be installed locally
# ---------------------------------------------------------------------------


class _FakeHit:
    """Drop-in for pymilvus.client.abstract.Hit (must be a real class for isinstance)."""

    def __init__(self):
        self.fields: dict = {}
        self.distance: float = 0.0


_pymilvus_abstract_mod = MagicMock()
_pymilvus_abstract_mod.Hit = _FakeHit

_EXTERNAL_MOCKS = [
    "markitdown",
    "fastfeedparser",
    "cachetools",
    "playwright",
    "playwright.async_api",
    "openai",
    "pymilvus",
    "pymilvus.client",
    "nv_ingest_client",
    "nv_ingest_client.client",
    "nv_ingest_client.util",
    "nv_ingest_client.util.process_json_files",
    "bs4",
    "PIL",
    "redis",
    "langchain_core",
    "langchain_core.embeddings",
    "langchain_core.messages",
    "optuna",
    "optuna.samplers",
    "optuna.pruners",
    "optuna.storages",
    "optuna.trial",
    "deepdiff",
    "kubernetes",
    "kubernetes.client",
    "kubernetes.config",
    # httpx handled separately below (needs real exception classes)
    "jsonschema",
    "fastapi",
    "fastapi.responses",
    "uvicorn",
]
for _mod_name in _EXTERNAL_MOCKS:
    sys.modules.setdefault(_mod_name, MagicMock())


# ---------------------------------------------------------------------------
# httpx mock: real exception classes so isinstance() works in mcp_patches
# ---------------------------------------------------------------------------
class _FakeHTTPError(Exception):
    pass


class _FakeTimeoutException(_FakeHTTPError):
    pass


class _FakeConnectTimeout(_FakeTimeoutException):
    pass


class _FakeReadTimeout(_FakeTimeoutException):
    pass


class _FakeConnectError(_FakeHTTPError):
    pass


class _FakeHTTPStatusError(_FakeHTTPError):
    def __init__(self, message="", *, request=None, response=None):
        super().__init__(message)
        self.request = request
        self.response = response


_httpx_mod = MagicMock()
_httpx_mod.ConnectTimeout = _FakeConnectTimeout
_httpx_mod.ConnectError = _FakeConnectError
_httpx_mod.ReadTimeout = _FakeReadTimeout
_httpx_mod.TimeoutException = _FakeTimeoutException
_httpx_mod.HTTPError = _FakeHTTPError
_httpx_mod.HTTPStatusError = _FakeHTTPStatusError
sys.modules.setdefault("httpx", _httpx_mod)

# pymilvus.client.abstract needs a real Hit class for isinstance() checks
sys.modules.setdefault("pymilvus.client.abstract", _pymilvus_abstract_mod)
