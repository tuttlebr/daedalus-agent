# Temporary patch of the Helm nginx image until upstream rebuilds it.
FROM mirror.gcr.io/nginxinc/nginx-unprivileged:1.31.6-alpine-slim@sha256:ac4d9c7e457c6510b95ac72dd84b27f7cc68ecb9a83fbd44f05a6460cf08aba4
USER root
RUN apk add --no-cache 'zlib=1.3.2-r1'
# Restore the upstream unprivileged user; the entrypoint, command, stop signal,
# exposed port and configuration paths are inherited unchanged.
USER 101
