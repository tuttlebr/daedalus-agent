ARG BASE_IMAGE_URL=nvcr.io/nvidia/base/ubuntu
ARG BASE_IMAGE_TAG=22.04_20240212
ARG NAT_VERSION
ARG PYTHON_VERSION=3.13
ARG UV_VERSION=0.8.3

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv_base

FROM ${BASE_IMAGE_URL}:${BASE_IMAGE_TAG} AS base
ARG NAT_VERSION
ARG PYTHON_VERSION=3.13
ARG UV_VERSION=0.8.3

COPY --from=uv_base /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1

# Install certificates
RUN export DEBIAN_FRONTEND=noninteractive && \
    export TZ=Etc/UTC && \
    apt-get update && \
    apt upgrade -y && \
    apt-get install --no-install-recommends -y \
        build-essential \
        ca-certificates \
        clang \
        curl \
        git \
        jq \
        python3-pip && \
    apt clean && \
    update-ca-certificates

# Set SSL environment variables
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Set working directory
WORKDIR /workspace

RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    uv venv --python ${PYTHON_VERSION} /workspace/.venv && \
    . /workspace/.venv/bin/activate && \
    uv pip install "git+https://github.com/NVIDIA/NeMo-Agent-Toolkit.git@${NAT_VERSION}"

# Enivronment variables for the venv
ENV PATH="/workspace/.venv/bin:$PATH"

FROM base AS backend
SHELL ["/bin/bash", "-c"]
WORKDIR /workspace
RUN source /workspace/.venv/bin/activate

# Install the image_generation package
COPY image_generation /workspace/image_generation
RUN NAT_VERSION= nat workflow reinstall image_generation
RUN uv pip install -e image_generation --prerelease=allow

# Install the smart_milvus package
COPY smart_milvus /workspace/smart_milvus
RUN NAT_VERSION= nat workflow reinstall smart_milvus
RUN uv pip install -e smart_milvus --prerelease=allow

# Install the serpapi_search package
COPY serpapi_search /workspace/serpapi_search
RUN NAT_VERSION= nat workflow reinstall serpapi_search
RUN uv pip install -e serpapi_search --prerelease=allow

# Install the serpapi_news package
COPY serpapi_news /workspace/serpapi_news
RUN NAT_VERSION= nat workflow reinstall serpapi_news
RUN uv pip install -e serpapi_news --prerelease=allow

# Install the weather package
COPY weather /workspace/weather
RUN NAT_VERSION= nat workflow reinstall weather
RUN uv pip install -e weather --prerelease=allow

# Install the webscrape package
COPY webscrape /workspace/webscrape
RUN NAT_VERSION= nat workflow reinstall webscrape
RUN uv pip install -e webscrape --prerelease=allow

# Install the aiq_aira package
# COPY --from=nvcr.io/nvidia/blueprint/aira-backend:v1.1.0 /app /workspace/aiq_aira/
# RUN NAT_VERSION= nat workflow reinstall aiq_aira
# RUN uv pip install -e aiq_aira --prerelease=allow

WORKDIR /workspace
ENTRYPOINT nat serve --config_file=/workspace/config.yaml --host=0.0.0.0 --port=8000 --workers=4
