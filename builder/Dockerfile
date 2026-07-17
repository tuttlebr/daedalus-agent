ARG BASE_IMAGE_URL=ubuntu
ARG BASE_IMAGE_TAG=24.04
ARG BASE_IMAGE_DIGEST=sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90
ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.9.15
ARG UV_IMAGE_DIGEST=sha256:4c1ad814fe658851f50ff95ecd6948673fffddb0d7994bdb019dcb58227abd52

FROM ghcr.io/astral-sh/uv:${UV_VERSION}@${UV_IMAGE_DIGEST} AS uv_base

FROM ${BASE_IMAGE_URL}:${BASE_IMAGE_TAG}@${BASE_IMAGE_DIGEST} AS runtime_base

ENV TZ=America/New_York
ENV PYTHONDONTWRITEBYTECODE=1
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV PATH="/workspace/.venv/bin:$PATH"

# Keep only binaries used by the application and its shipped skills here. Build
# tools live in the build stage and cannot be copied into the runtime image.
RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update && \
    apt-get install --no-install-recommends -y \
    ca-certificates \
    curl \
    ffmpeg \
    jq \
    python3.12 \
    tzdata && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

FROM runtime_base AS build
ARG PYTHON_VERSION=3.12
ARG TARGETARCH

COPY --from=uv_base /uv /uvx /bin/

ENV UV_HTTP_TIMEOUT=300
ENV UV_CONCURRENT_BUILDS=4
ENV UV_CONCURRENT_INSTALLS=4
ENV UV_CONCURRENT_DOWNLOADS=4

RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update && \
    apt-get install --no-install-recommends -y \
    build-essential \
    clang \
    git && \
    rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-c"]
WORKDIR /workspace

ARG BUILDER_PACKAGES="nat_helpers visual_media nat_nv_ingest smart_milvus webscrape rss_feed vtt_interpreter agent_skills perplexity_search content_distiller source_verifier user_interaction autonomous_agent llm_sandbox"

COPY requirements-runtime.in /workspace/requirements-runtime.in
COPY verify_uv_pip_check.py /workspace/verify_uv_pip_check.py
COPY pylock.runtime-linux-amd64.toml /workspace/pylock.runtime-linux-amd64.toml
COPY pylock.runtime-linux-arm64.toml /workspace/pylock.runtime-linux-arm64.toml

# Copy dependency metadata first so source-only edits retain the expensive
# hash-verified dependency installation layer.
COPY nat_helpers/pyproject.toml /workspace/nat_helpers/
COPY visual_media/pyproject.toml /workspace/visual_media/
COPY nat_nv_ingest/pyproject.toml /workspace/nat_nv_ingest/
COPY smart_milvus/pyproject.toml /workspace/smart_milvus/
COPY webscrape/pyproject.toml /workspace/webscrape/
COPY rss_feed/pyproject.toml /workspace/rss_feed/
COPY vtt_interpreter/pyproject.toml /workspace/vtt_interpreter/
COPY agent_skills/pyproject.toml /workspace/agent_skills/
COPY perplexity_search/pyproject.toml /workspace/perplexity_search/
COPY content_distiller/pyproject.toml /workspace/content_distiller/
COPY source_verifier/pyproject.toml /workspace/source_verifier/
COPY user_interaction/pyproject.toml /workspace/user_interaction/
COPY autonomous_agent/pyproject.toml /workspace/autonomous_agent/
COPY llm_sandbox/pyproject.toml /workspace/llm_sandbox/

RUN for package in ${BUILDER_PACKAGES}; do \
    mkdir -p "/workspace/${package}/src/${package}" && \
    touch "/workspace/${package}/src/${package}/__init__.py"; \
    done

# PEP 751 locks carry SHA-256 hashes for registry artifacts, the exact NAT Git
# commit, and every local editable package. Fail closed on unsupported targets.
RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    case "${TARGETARCH}" in \
      amd64) runtime_lock=/workspace/pylock.runtime-linux-amd64.toml ;; \
      arm64) runtime_lock=/workspace/pylock.runtime-linux-arm64.toml ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    uv venv --python "${PYTHON_VERSION}" /workspace/.venv && \
    uv pip install --python /workspace/.venv/bin/python \
      --require-hashes -r "${runtime_lock}"

# NAT 1.7 caps cryptography below its fixed upstream wheel, and NV-Ingest 26.3
# pins urllib3 below its fixed release. Permit only those two exact, tested
# metadata boundaries and fail the build for every other dependency conflict.
RUN set +e; \
    pip_check_output="$(uv pip check --python /workspace/.venv/bin/python 2>&1)"; \
    pip_check_status=$?; \
    set -e; \
    printf '%s\n' "${pip_check_output}"; \
    printf '%s\n' "${pip_check_output}" \
      | python /workspace/verify_uv_pip_check.py "${pip_check_status}"

COPY nat_helpers /workspace/nat_helpers
COPY visual_media /workspace/visual_media
COPY nat_nv_ingest /workspace/nat_nv_ingest
COPY smart_milvus /workspace/smart_milvus
COPY webscrape /workspace/webscrape
COPY rss_feed /workspace/rss_feed
COPY vtt_interpreter /workspace/vtt_interpreter
COPY agent_skills /workspace/agent_skills
COPY perplexity_search /workspace/perplexity_search
COPY content_distiller /workspace/content_distiller
COPY source_verifier /workspace/source_verifier
COPY user_interaction /workspace/user_interaction
COPY autonomous_agent /workspace/autonomous_agent
COPY llm_sandbox /workspace/llm_sandbox

# Setuptools creates source-tree metadata while preparing editable installs.
# The virtual environment already owns the authoritative dist-info records.
RUN find /workspace -mindepth 3 -maxdepth 3 -type d -name '*.egg-info' \
    -exec rm -rf -- {} +

COPY entrypoint.py /workspace/entrypoint.py
COPY llm_diagnostics.py /workspace/llm_diagnostics.py
COPY mcp_patches.py /workspace/mcp_patches.py
COPY runtime_contract_check.py /workspace/runtime_contract_check.py
COPY milvus_collection_migration.py /workspace/milvus_collection_migration.py
COPY image_api.py /workspace/image_api.py
COPY collection_metadata_api.py /workspace/collection_metadata_api.py
COPY document_ingest_api.py /workspace/document_ingest_api.py
COPY profile_import_api.py /workspace/profile_import_api.py

# Exercise the installed NAT ABI and all local plugin registrations before the
# runtime stage is assembled.
RUN python /workspace/runtime_contract_check.py

# Preserve the existing Compose development target while keeping its build
# toolchain out of the backend stage below.
FROM build AS base

FROM runtime_base AS backend
WORKDIR /workspace

COPY --from=build --chown=1000:1000 /workspace /workspace
COPY --from=skills --chown=1000:1000 . /skills

USER 1000:1000
ENTRYPOINT ["python", "entrypoint.py"]
