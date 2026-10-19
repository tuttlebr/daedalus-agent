"""Render the chart's Redis ACL and check each workload can reach its keys."""

import re
import shlex
import subprocess
from fnmatch import fnmatchcase
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
CHART = ROOT / "helm" / "daedalus"
IMAGE_CHECK = ROOT / "builder" / "migration" / "image_check.py"
pytestmark = pytest.mark.requires_helm

# Keys the backend process (Rust runtime and Python tools) reads or writes,
# shaped the way their owners build them.
BACKEND_KEYS = {
    # nat_helpers.image_utils: frontend-stored and generated images.
    "user image": "user:user-1:image:image-1",
    "anonymous session image": "image:session-1:image-1",
    "generated image": "generated:image:image-1",
    # nat_helpers.image_utils.fetch_video_from_redis, written by the
    # frontend's pages/api/session/videoStorage.ts.
    "user video": "user:user-1:video:video-1",
    "anonymous session video": "video:session-1:video-1",
    # nat_nv_ingest uploaded-document records.
    "uploaded document": "document:session-1:document-1",
    # runtime/src/authorization.rs and user_interaction.approval_tokens.
    "approval grant": "approval:user-1:token-1",
    "pending approval": "approval-pending:user-1:request-1",
    "approval receipt": "approval-receipt:digest-1",
    # nat_helpers.hindsight_memory_context caches and locks.
    "memory cache": "daedalus:memory:session:v1:user-1:conversation-1",
    # runtime/src/oauth.rs and daedalus_runtime/oauth.py durable grants.
    "Google OAuth grant": "nat/object_store/gmail-mcp-oauth-ro/tokens/digest-1",
}
# Authentication, conversation and autonomy state stay frontend-owned.
BACKEND_DENIED = (
    "session:session-1",
    "auth-session:session-1",
    "auth-user:user-1",
    "auth-login-attempts:user-1",
    "conversation:conversation-1",
    "user:user-1:conversations",
    "user:user-1:videos",
    "autonomy:user-1:config",
)


def rendered_acl_users():
    result = subprocess.run(
        ["helm", "template", "acl", str(CHART)],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    script = next(
        document["data"]["init-redis.sh"]
        for document in yaml.safe_load_all(result.stdout)
        if document
        and document["kind"] == "ConfigMap"
        and document["metadata"]["name"].endswith("-redis-init")
    )
    users = {}
    for line in script.replace("\\\n", " ").splitlines():
        if line.strip().startswith('write_acl_user "$'):
            arguments = shlex.split(line)
            users[arguments[1]] = arguments[4].split()
    return users


def allowed(patterns, key):
    # Redis key globs and fnmatch both let `*` span `:` and `/`.
    return any(fnmatchcase(key, pattern.removeprefix("~")) for pattern in patterns)


def test_backend_acl_covers_every_key_family_the_backend_uses():
    patterns = rendered_acl_users()["$REDIS_BACKEND_USERNAME"]

    missing = {
        name: key for name, key in BACKEND_KEYS.items() if not allowed(patterns, key)
    }
    assert missing == {}
    assert [key for key in BACKEND_DENIED if allowed(patterns, key)] == []


def test_migration_fixture_uses_the_shipped_backend_key_scopes():
    # image_check.py runs the minimal image against a fixture ACL that claims
    # to mirror the chart; a drifted copy hides NOPERM regressions.
    fixture = re.search(
        r"user backend on >synthetic-backend (.*?) \+@all", IMAGE_CHECK.read_text()
    )
    assert fixture is not None
    assert fixture.group(1).split() == rendered_acl_users()["$REDIS_BACKEND_USERNAME"]
