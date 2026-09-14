# Keep the Redis server and module versions byte-compatible with the persisted
# 7.4.0-v8 dataset while applying the fixed Ubuntu security packages that the
# upstream image no longer refreshes.
FROM redis/redis-stack-server:7.4.0-v8@sha256:798ab84d9f266936b034ab11c4d04a2b8e4b441884c5aa7d17ac951eefdf742a

USER root

COPY --chmod=755 compose-entrypoint.sh /usr/local/bin/redis-compose-entrypoint

RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade \
        gpgv \
        libssl-dev \
        libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o 977 -g 988 /data

# Match the repository's local persistent-data ownership. Kubernetes can still
# override this numeric identity through its pod security context.
USER 977:988
