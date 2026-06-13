ARG BASE_IMAGE_URL=ubuntu
ARG BASE_IMAGE_TAG=24.04
ARG NAT_VERSION
ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.9.15

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv_base

FROM ${BASE_IMAGE_URL}:${BASE_IMAGE_TAG} AS base
ARG NAT_VERSION
ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.9.15

COPY --from=uv_base /uv /uvx /bin/

ENV TZ=America/New_York
ENV PYTHONDONTWRITEBYTECODE=1
ENV UV_HTTP_TIMEOUT=300
ENV UV_CONCURRENT_BUILDS=4
ENV UV_CONCURRENT_INSTALLS=4
ENV UV_CONCURRENT_DOWNLOADS=4

RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update && \
    apt upgrade -y && \
    apt-get install --no-install-recommends -y \
    build-essential \
    ca-certificates \
    clang \
    curl \
    ffmpeg \
    git \
    jq \
    python3-pip \
    tzdata && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone && \
    apt clean && \
    update-ca-certificates

ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /workspace

RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    uv venv --python ${PYTHON_VERSION} /workspace/.venv && \
    . /workspace/.venv/bin/activate && \
    uv pip install --prerelease=allow \
    "nvidia-nat[redis,mcp,langchain,phoenix,async_endpoints] @ git+https://github.com/NVIDIA/NeMo-Agent-Toolkit.git@${NAT_VERSION}" \
    "pydantic<2.14"

ENV PATH="/workspace/.venv/bin:$PATH"

FROM base AS backend
SHELL ["/bin/bash", "-c"]
WORKDIR /workspace
RUN source /workspace/.venv/bin/activate

ARG BUILDER_PACKAGES="nat_helpers visual_media nat_nv_ingest smart_milvus webscrape rss_feed vtt_interpreter agent_skills serpapi_search perplexity_search content_distiller source_verifier user_interaction autonomous_agent"

# Install dependency metadata before copying source so normal code edits do not
# invalidate the expensive dependency resolution and download layer.
COPY nat_helpers/pyproject.toml /workspace/nat_helpers/
COPY visual_media/pyproject.toml /workspace/visual_media/
COPY nat_nv_ingest/pyproject.toml /workspace/nat_nv_ingest/
COPY smart_milvus/pyproject.toml /workspace/smart_milvus/
COPY webscrape/pyproject.toml /workspace/webscrape/
COPY rss_feed/pyproject.toml /workspace/rss_feed/
COPY vtt_interpreter/pyproject.toml /workspace/vtt_interpreter/
COPY agent_skills/pyproject.toml /workspace/agent_skills/
COPY serpapi_search/pyproject.toml /workspace/serpapi_search/
COPY perplexity_search/pyproject.toml /workspace/perplexity_search/
COPY content_distiller/pyproject.toml /workspace/content_distiller/
COPY source_verifier/pyproject.toml /workspace/source_verifier/
COPY user_interaction/pyproject.toml /workspace/user_interaction/
COPY autonomous_agent/pyproject.toml /workspace/autonomous_agent/

RUN for package in ${BUILDER_PACKAGES}; do \
    mkdir -p "/workspace/${package}/src/${package}" && \
    touch "/workspace/${package}/src/${package}/__init__.py"; \
    done

RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    uv pip install --prerelease=allow \
    $(for package in ${BUILDER_PACKAGES}; do printf ' -e %s' "${package}"; done)

ENV PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright
RUN playwright install chromium --with-deps

COPY nat_helpers /workspace/nat_helpers
COPY visual_media /workspace/visual_media
COPY nat_nv_ingest /workspace/nat_nv_ingest
COPY smart_milvus /workspace/smart_milvus
COPY webscrape /workspace/webscrape
COPY rss_feed /workspace/rss_feed
COPY vtt_interpreter /workspace/vtt_interpreter
COPY agent_skills /workspace/agent_skills
COPY serpapi_search /workspace/serpapi_search
COPY perplexity_search /workspace/perplexity_search
COPY content_distiller /workspace/content_distiller
COPY source_verifier /workspace/source_verifier
COPY user_interaction /workspace/user_interaction
COPY autonomous_agent /workspace/autonomous_agent

RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    uv pip install --no-deps --prerelease=allow \
    $(for package in ${BUILDER_PACKAGES}; do printf ' -e %s' "${package}"; done)

RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall visual_media && \
    NAT_VERSION= nat workflow reinstall nat_nv_ingest && \
    NAT_VERSION= nat workflow reinstall smart_milvus && \
    NAT_VERSION= nat workflow reinstall webscrape && \
    NAT_VERSION= nat workflow reinstall rss_feed && \
    NAT_VERSION= nat workflow reinstall vtt_interpreter && \
    NAT_VERSION= nat workflow reinstall agent_skills && \
    NAT_VERSION= nat workflow reinstall serpapi_search && \
    NAT_VERSION= nat workflow reinstall perplexity_search && \
    NAT_VERSION= nat workflow reinstall content_distiller && \
    NAT_VERSION= nat workflow reinstall source_verifier && \
    NAT_VERSION= nat workflow reinstall user_interaction

COPY entrypoint.py /workspace/entrypoint.py
COPY llm_diagnostics.py /workspace/llm_diagnostics.py
COPY mcp_patches.py /workspace/mcp_patches.py
COPY image_api.py /workspace/image_api.py
COPY document_ingest_api.py /workspace/document_ingest_api.py
COPY profile_import_api.py /workspace/profile_import_api.py
COPY --from=skills . /skills

# Ensure baked files are accessible when running as non-root (K8s securityContext),
# and provide NAT's cwd-relative async job temp directory.
RUN chmod -R a+rX \
    /workspace/nat_helpers \
    /workspace/visual_media \
    /workspace/nat_nv_ingest \
    /workspace/smart_milvus \
    /workspace/webscrape \
    /workspace/rss_feed \
    /workspace/vtt_interpreter \
    /workspace/agent_skills \
    /workspace/serpapi_search \
    /workspace/perplexity_search \
    /workspace/content_distiller \
    /workspace/source_verifier \
    /workspace/user_interaction \
    /workspace/autonomous_agent \
    /workspace/entrypoint.py \
    /workspace/llm_diagnostics.py \
    /workspace/mcp_patches.py \
    /workspace/image_api.py \
    /workspace/document_ingest_api.py \
    /workspace/profile_import_api.py \
    /skills && \
    mkdir -p /workspace/.tmp && \
    chmod 1777 /workspace/.tmp

WORKDIR /workspace
ENTRYPOINT ["python", "entrypoint.py"]
