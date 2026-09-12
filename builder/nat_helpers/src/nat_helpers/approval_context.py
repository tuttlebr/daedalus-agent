"""Request-local provenance for control messages emitted by the approval gate."""

from contextlib import contextmanager
from contextvars import ContextVar

_MARKERS: ContextVar[set[str] | None] = ContextVar(
    "daedalus_approval_markers", default=None
)


@contextmanager
def approval_marker_scope(*, new_request: bool = False):
    # The mutable set is intentionally shared by copied asyncio tool contexts.
    # Only the server-side gate can register a marker; tool text cannot do so.
    if not new_request and _MARKERS.get() is not None:
        yield
        return
    token = _MARKERS.set(set())
    try:
        yield
    finally:
        _MARKERS.reset(token)


def register_approval_marker(marker: str) -> str:
    markers = _MARKERS.get()
    if markers is not None:
        markers.add(marker)
    return marker


def is_trusted_approval_marker(marker: str) -> bool:
    markers = _MARKERS.get()
    return markers is not None and marker in markers
