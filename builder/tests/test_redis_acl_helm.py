"""Render the chart's Redis ACL and check each workload can reach its keys."""

import os
import re
import shlex
import subprocess
import sys
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
    # runtime/src/memory.rs and nat_helpers.hindsight_memory_context caches.
    "memory cache": "daedalus:memory:session:v1:user-1:conversation-1",
    # runtime/src/output.rs and nat_helpers.tool_output_compaction.
    "tool output": "daedalus:tool-output:v1:user-1:reference-1",
    # runtime/src/document_reservations.rs and nat_helpers.idempotency.
    "idempotency receipt": "daedalus:idempotency:v1:a:b:c:d",
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
    # Retired families no backend code reads or writes: the Redis memory store
    # (now Hindsight), the RSS cache, and unread MCP execution receipts.
    "nat:memory:user-1:memory-1",
    "rss_feed:https://feeds.example/rss",
    "approval-receipt:digest-1",
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


@pytest.mark.parametrize("tls", [False, True])
def test_health_probes_reject_redis_error_replies(tmp_path, tls):
    # Unauthenticated Redis is rejected at render time, so the probes are
    # exercised with authentication only.
    rendered = subprocess.run(
        [
            "helm",
            "template",
            "probe",
            str(CHART),
            "--set",
            f"redis.tls.enabled={str(tls).lower()}",
            "--set",
            "redis.tls.existingSecret=fixture-tls",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    ).stdout
    container = next(
        document["spec"]["template"]["spec"]["containers"][0]
        for document in yaml.safe_load_all(rendered)
        if document
        and document["kind"] == "Deployment"
        and document["metadata"]["name"].endswith("-redis")
    )
    # redis-cli exits zero for Redis error replies, including NOAUTH. Exercise
    # the exact rendered probe, not just its command spelling.
    cli = tmp_path / "redis-cli"
    cli.write_text(
        f"#!{sys.executable}\nimport os\nprint(os.environ['FIXTURE_REPLY'])\n"
    )
    cli.chmod(0o700)
    for name in ("livenessProbe", "readinessProbe"):
        command = container[name]["exec"]["command"]
        assert ("--tls" in command) is tls
        assert "--user" in command
        for reply in (
            "PONG",
            "NOAUTH Authentication required.",
            "WRONGPASS invalid credentials",
        ):
            result = subprocess.run(
                command,
                env={
                    **os.environ,
                    "PATH": f"{tmp_path}:{os.environ['PATH']}",
                    "FIXTURE_REPLY": reply,
                },
                capture_output=True,
                text=True,
                timeout=5,
            )
            assert (result.returncode == 0) is (reply == "PONG"), (name, reply)


def _render(*values):
    args = ["helm", "template", "test", str(CHART)]
    for value in values:
        args.extend(["--set", value])
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    return result


def _documents(result):
    assert result.returncode == 0, result.stderr
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def test_redis_accepts_connections_only_from_this_release_workloads():
    documents = _documents(_render())
    policy = next(
        doc
        for doc in documents
        if doc["kind"] == "NetworkPolicy"
        and doc["metadata"]["name"] == "test-daedalus-redis"
    )
    assert policy["spec"]["policyTypes"] == ["Ingress"]
    [rule] = policy["spec"]["ingress"]
    components = {
        peer["podSelector"]["matchLabels"]["app.kubernetes.io/component"]
        for peer in rule["from"]
    }
    assert components == {
        "frontend",
        "frontend-stream-worker",
        "backend-default",
        "autonomous-agent",
    }
    for peer in rule["from"]:
        assert (
            peer["podSelector"]["matchLabels"]["app.kubernetes.io/instance"] == "test"
        )
    assert rule["ports"] == [{"protocol": "TCP", "port": 6379}]

    cilium = _documents(_render("backend.networkPolicy.cilium.enabled=true"))
    redis_cilium = next(
        doc
        for doc in cilium
        if doc["kind"] == "CiliumNetworkPolicy"
        and doc["metadata"]["name"] == "test-daedalus-redis-cilium"
    )
    [ingress] = redis_cilium["spec"]["ingress"]
    assert {
        peer["matchLabels"]["app.kubernetes.io/component"]
        for peer in ingress["fromEndpoints"]
    } == components


def test_redis_is_not_restarted_by_the_redeploy_nonce():
    documents = _documents(_render("forceRedeploy=1234"))
    deployments = {
        doc["metadata"]["name"]: doc for doc in documents if doc["kind"] == "Deployment"
    }
    redis = deployments["test-daedalus-redis"]
    annotations = redis["spec"]["template"]["metadata"]["annotations"]
    assert "deploy-timestamp" not in annotations
    assert redis["spec"]["template"]["spec"]["terminationGracePeriodSeconds"] == 120
    # The application workloads still roll on the nonce.
    frontend = deployments["test-daedalus-frontend"]
    assert (
        frontend["spec"]["template"]["metadata"]["annotations"]["deploy-timestamp"]
        == "1234"
    )


def test_unauthenticated_redis_is_rejected_at_render_time():
    result = _render("redis.auth.enabled=false")
    assert result.returncode != 0
    assert "redis.auth.enabled=false is not supported" in result.stderr
