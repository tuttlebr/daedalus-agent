ARG BASE_IMAGE_URL=nvcr.io/nvidia/base/ubuntu
ARG BASE_IMAGE_TAG=22.04_20240212
ARG NAT_VERSION
ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.9.15

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv_base

FROM ${BASE_IMAGE_URL}:${BASE_IMAGE_TAG} AS base
ARG NAT_VERSION
ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.9.15

COPY --from=uv_base /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1
ENV UV_HTTP_TIMEOUT=300
ENV UV_CONCURRENT_BUILDS=4
ENV UV_CONCURRENT_INSTALLS=4
ENV UV_CONCURRENT_DOWNLOADS=4

ENV TZ=America/New_York

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
    "nvidia-nat[redis,mcp,langchain,phoenix] @ git+https://github.com/NVIDIA/NeMo-Agent-Toolkit.git@${NAT_VERSION}" \
    "starlette<1.0.0"

ENV PATH="/workspace/.venv/bin:$PATH"

FROM base AS backend
SHELL ["/bin/bash", "-c"]
WORKDIR /workspace
RUN source /workspace/.venv/bin/activate

COPY nat_helpers /workspace/nat_helpers
COPY image_augmentation /workspace/image_augmentation
COPY image_comprehension /workspace/image_comprehension
COPY image_generation /workspace/image_generation
COPY nat_nv_ingest /workspace/nat_nv_ingest
COPY smart_milvus /workspace/smart_milvus
COPY webscrape /workspace/webscrape
COPY rss_feed /workspace/rss_feed
COPY vtt_interpreter /workspace/vtt_interpreter
COPY agent_skills /workspace/agent_skills
COPY serpapi_search /workspace/serpapi_search
COPY json_repair_agent /workspace/json_repair_agent
COPY mas_optimizer /workspace/mas_optimizer
COPY think_tool /workspace/think_tool
COPY content_distiller /workspace/content_distiller
COPY user_interaction /workspace/user_interaction
COPY --from=skills . /skills

RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    uv pip install --prerelease=allow \
    -e nat_helpers \
    -e image_augmentation \
    -e image_comprehension \
    -e image_generation \
    -e nat_nv_ingest \
    -e smart_milvus \
    -e webscrape \
    -e rss_feed \
    -e vtt_interpreter \
    -e agent_skills \
    -e serpapi_search \
    -e json_repair_agent \
    -e mas_optimizer \
    -e think_tool \
    -e content_distiller \
    -e user_interaction

RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall image_augmentation && \
    NAT_VERSION= nat workflow reinstall image_comprehension && \
    NAT_VERSION= nat workflow reinstall image_generation && \
    NAT_VERSION= nat workflow reinstall nat_nv_ingest && \
    NAT_VERSION= nat workflow reinstall smart_milvus && \
    NAT_VERSION= nat workflow reinstall webscrape && \
    NAT_VERSION= nat workflow reinstall rss_feed && \
    NAT_VERSION= nat workflow reinstall vtt_interpreter && \
    NAT_VERSION= nat workflow reinstall agent_skills && \
    NAT_VERSION= nat workflow reinstall serpapi_search && \
    NAT_VERSION= nat workflow reinstall json_repair_agent && \
    NAT_VERSION= nat workflow reinstall mas_optimizer && \
    NAT_VERSION= nat workflow reinstall think_tool && \
    NAT_VERSION= nat workflow reinstall content_distiller && \
    NAT_VERSION= nat workflow reinstall user_interaction

ENV PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright
RUN playwright install chromium --with-deps

# Ensure all workspace files are accessible when running as non-root (K8s securityContext)
RUN chmod -R a+rX /workspace

COPY entrypoint.py /workspace/entrypoint.py
COPY llm_diagnostics.py /workspace/llm_diagnostics.py
COPY mcp_patches.py /workspace/mcp_patches.py

WORKDIR /workspace
ENTRYPOINT ["python", "entrypoint.py"]
