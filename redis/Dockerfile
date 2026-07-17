# Keep the Redis server and module versions byte-compatible with the persisted
# 7.4.0-v8 dataset while applying the fixed Ubuntu security packages that the
# upstream image no longer refreshes.
FROM redis/redis-stack-server:7.4.0-v8@sha256:798ab84d9f266936b034ab11c4d04a2b8e4b441884c5aa7d17ac951eefdf742a

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade \
        gpgv=2.2.27-3ubuntu2.5 \
        libssl-dev=3.0.2-0ubuntu1.25 \
        libssl3=3.0.2-0ubuntu1.25 \
    && rm -rf /var/lib/apt/lists/*

# Kubernetes selects the non-root runtime UID to match its persistent volume.
# Local Compose keeps the upstream development default because bind-mounted
# data directories can have host-specific ownership.
