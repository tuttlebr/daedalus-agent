#!/usr/bin/env bash
set -euo pipefail

# Keep credentials out of process arguments and Redis ACL syntax. The active
# default user is also needed for Redis to replay persisted AOF transactions.
if [[ ! "${REDIS_USERNAME:-}" =~ ^[A-Za-z0-9._-]+$ || -z "${REDIS_PASSWORD:-}" ]]; then
  echo 'REDIS_USERNAME must be a simple ACL username and REDIS_PASSWORD must be set' >&2
  exit 1
fi
umask 077
password_hash=$(printf '%s' "$REDIS_PASSWORD" | sha256sum | cut -d' ' -f1)
{
  if [[ "$REDIS_USERNAME" != default ]]; then
    replay_hash=$(head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1)
    printf 'user default on #%s ~* &* +@all\n' "$replay_hash"
  fi
  printf 'user %s on #%s ~* &* +@all -@dangerous +info\n' "$REDIS_USERNAME" "$password_hash"
} >/tmp/compose-users.acl

exec redis-server --aclfile /tmp/compose-users.acl --protected-mode yes "$@"
