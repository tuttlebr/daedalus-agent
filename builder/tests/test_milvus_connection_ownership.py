"""Tests for process-local Milvus connection ownership."""

import pytest
from nat_helpers.milvus import owned_milvus_connection_args


def test_owned_connections_keep_config_but_never_reuse_an_alias():
    source = {"token": "test-token", "alias": "shared"}

    first = owned_milvus_connection_args("readiness", source)
    second = owned_milvus_connection_args("readiness", source)

    assert source["alias"] == "shared"
    assert first["token"] == "test-token"
    assert second["token"] == "test-token"
    assert first["alias"].startswith("daedalus-readiness-")
    assert second["alias"].startswith("daedalus-readiness-")
    assert first["alias"] != second["alias"]


def test_owned_connection_rejects_an_empty_owner():
    with pytest.raises(ValueError, match="must not be empty"):
        owned_milvus_connection_args("  ")
