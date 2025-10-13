ARG BASE_IMAGE_URL=nvcr.io/nvidia/base/ubuntu
ARG BASE_IMAGE_TAG=22.04_20240212
ARG NAT_VERSION
ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.8.3

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv_base

FROM ${BASE_IMAGE_URL}:${BASE_IMAGE_TAG} AS base
ARG NAT_VERSION
ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.8.3

COPY --from=uv_base /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1
ENV UV_HTTP_TIMEOUT=300

RUN export DEBIAN_FRONTEND=noninteractive && \
    export TZ=Etc/UTC && \
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
    python3-pip && \
    apt clean && \
    update-ca-certificates

ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /workspace

RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    uv venv --python ${PYTHON_VERSION} /workspace/.venv && \
    . /workspace/.venv/bin/activate && \
    uv pip install "git+https://github.com/NVIDIA/NeMo-Agent-Toolkit.git@${NAT_VERSION}"

ENV PATH="/workspace/.venv/bin:$PATH"

FROM base AS backend
SHELL ["/bin/bash", "-c"]
WORKDIR /workspace
RUN source /workspace/.venv/bin/activate

COPY image_generation /workspace/image_generation
RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall image_generation && \
    uv pip install -e image_generation --prerelease=allow

COPY serpapi_ai /workspace/serpapi_ai
RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall serpapi_ai && \
    uv pip install -e serpapi_ai --prerelease=allow

COPY serpapi_search /workspace/serpapi_search
RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall serpapi_search && \
    uv pip install -e serpapi_search --prerelease=allow

COPY serpapi_news /workspace/serpapi_news
RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall serpapi_news && \
    uv pip install -e serpapi_news --prerelease=allow

COPY smart_milvus /workspace/smart_milvus
RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall smart_milvus && \
    uv pip install -e smart_milvus --prerelease=allow

COPY weather /workspace/weather
RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall weather && \
    uv pip install -e weather --prerelease=allow

COPY webscrape /workspace/webscrape
RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall webscrape && \
    uv pip install -e webscrape --prerelease=allow

WORKDIR /workspace
ENTRYPOINT nat serve --config_file=/workspace/config.yaml --host=0.0.0.0 --port=8000 --workers=4
