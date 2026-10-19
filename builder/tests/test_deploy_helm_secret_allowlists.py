"""deploy.sh and the chart must accept the same workload Secret keys.

deploy.sh filters `.env` into each workload Secret (`fnmatch` globs), while
`createSecret` installs validate `env.data` keys with a `regexMatch` allowlist.
A key on only one side reaches a workload in one install path and is silently
dropped or rejected in the other.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = ROOT / "helm" / "daedalus" / "templates"
DEPLOY = ROOT / "deploy.sh"

WORKLOADS = {
    "BACKEND": "secret-backend.yaml",
    "FRONTEND": "secret-frontend.yaml",
    "STREAM_WORKER": "secret-frontend-stream-worker.yaml",
}

# Deliberate differences. Both sets must stay exact so a stale entry fails.
EXCEPTIONS = {
    "BACKEND": {
        # deploy.sh keeps Milvus and MinIO credentials out of the bulk env
        # Secret: scripts/sync_rag_secrets.py mirrors them into the Secrets
        # that retrieval.*.auth.existingSecret references. Chart installs may
        # still supply any Milvus/MinIO setting directly.
        "helm_only": {"MILVUS_*", "MINIO_*"},
        "deploy_only": {
            "MILVUS_URI",
            "MILVUS_DATABASE",
            "MILVUS_METADATA_TIMEOUT_SECONDS",
            "MILVUS_SEARCH_TIMEOUT_SECONDS",
            "MINIO_ENDPOINT",
            "MINIO_BUCKET",
        },
    },
}


def expand(pattern):
    """Expand the chart's `^(A|B_[A-Z0-9_]+)$` grammar into glob strings.

    Supports literals, nested alternation groups and `[...]+` runs, which
    become `*`. Anything else fails so the comparison cannot silently drift.
    """
    assert pattern.startswith("^") and pattern.endswith("$"), pattern
    body = pattern[1:-1]

    def alternatives(index):
        options, current = set(), {""}
        while index < len(body) and body[index] != ")":
            char = body[index]
            if char == "|":
                options |= current
                current, index = {""}, index + 1
            elif char == "(":
                inner, index = alternatives(index + 1)
                assert body[index] == ")", body
                current = {prefix + item for prefix in current for item in inner}
                index += 1
            elif char == "[":
                end = body.index("]+", index)
                current = {prefix + "*" for prefix in current}
                index = end + 2
            else:
                assert char.isalnum() or char == "_", (char, body)
                current = {prefix + char for prefix in current}
                index += 1
        return options | current, index

    globs, end = alternatives(0)
    assert end == len(body), body
    return globs


def helm_allowlist(template):
    text = (TEMPLATES / template).read_text(encoding="utf-8")
    match = re.search(r'regexMatch "(\^.+\$)" \$k', text)
    assert match is not None, template
    return match.group(1)


def deploy_allowlist(group):
    match = re.search(
        rf"\n  {group}_SECRET_KEYS=\(\n(.*?)\n  \)\n",
        DEPLOY.read_text(encoding="utf-8"),
        re.S,
    )
    assert match is not None, group
    return set(match.group(1).split())


def test_expansion_matches_the_chart_regex():
    # Guard the expander itself: every expanded glob, instantiated, must be
    # accepted by the original regular expression, and vice versa.
    for template in WORKLOADS.values():
        pattern = helm_allowlist(template)
        for glob in expand(pattern):
            assert re.fullmatch(pattern, glob.replace("*", "1")), (template, glob)
    assert expand("^(A|B_(C|D)_[0-9]+_E)$") == {"A", "B_C_*_E", "B_D_*_E"}


def test_deploy_and_chart_secret_allowlists_agree():
    for group, template in WORKLOADS.items():
        pattern = helm_allowlist(template)
        helm = expand(pattern)
        deploy = deploy_allowlist(group)
        expected = EXCEPTIONS.get(group, {"helm_only": set(), "deploy_only": set()})

        assert helm - deploy == expected["helm_only"], group
        assert deploy - helm == expected["deploy_only"], group
        # Exceptions narrow deploy.sh; the chart still accepts those keys.
        for key in expected["deploy_only"]:
            assert re.fullmatch(pattern, key), (group, key)
