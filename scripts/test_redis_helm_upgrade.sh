#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHART="$REPO_ROOT/helm/daedalus"
CLUSTER_NAME="${KIND_CLUSTER_NAME:-daedalus-redis-upgrade}"
NAMESPACE="${REDIS_UPGRADE_NAMESPACE:-redis-upgrade-test}"
RELEASE="${REDIS_UPGRADE_RELEASE:-redis-upgrade}"
FULLNAME="redis-fixture"
REDIS_SERVICE="$FULLNAME-redis"
REDIS_SERVICE_FQDN="$REDIS_SERVICE.$NAMESPACE.svc.cluster.local"
REDIS_USER="daedalus"
AUTH_SECRET="$FULLNAME-redis-auth-external"
TLS_SECRET="$FULLNAME-redis-tls"
TLS_MOUNT_PATH="/etc/redis-tls"
OLD_PASSWORD="fixture-old-password"
NEW_PASSWORD="fixture-new-password"
OLD_TAG="7.4.0-v8"
OLD_DIGEST="sha256:798ab84d9f266936b034ab11c4d04a2b8e4b441884c5aa7d17ac951eefdf742a"
OLD_REPOSITORY="redis/redis-stack-server"
NEW_REPOSITORY="daedalus/redis"
NEW_TAG="7.4.0-v8-patched"
NEW_DIGEST=""

AUTONOMY_QUEUED='{"id":"request-queued","prompt":"queued fixture"}'
AUTONOMY_PROCESSING='{"id":"request-processing","prompt":"processing fixture"}'
AUTONOMY_CLAIM='{"claimedAt":1,"ownerToken":"fixture-owner","visibilityDeadlineAt":4102444800000}'
AUTONOMY_QUEUE_KEY="autonomy:fixture-user:queue"
AUTONOMY_PROCESSING_KEY="autonomy:fixture-user:processing"
AUTONOMY_LEASE_KEY="autonomy:fixture-user:lease"
STREAM_QUEUE_KEY="async-stream-queue"
STREAM_GROUP="daedalus-stream-workers"
STREAM_CONSUMER="fixture-worker"
STREAM_JOB_ID="stream-job-1"
STREAM_PAYLOAD_KEY="async-stream-payload:$STREAM_JOB_ID"
STREAM_LEASE_KEY="async-stream-lease:$STREAM_JOB_ID"
STREAM_STARTED_KEY="async-stream-backend-started:$STREAM_JOB_ID"
STREAM_ENTRY_ID=""
AUTONOMY_CLAIM_KEY=""
TLS_WORK_DIR=""
CLUSTER_CREATED=0
FORCE_ROLLOUT=0

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
}

cleanup() {
  local status=$?
  if [[ "$CLUSTER_CREATED" == "1" && "${KEEP_KIND_CLUSTER:-0}" != "1" ]]; then
    kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TLS_WORK_DIR" && -d "$TLS_WORK_DIR" ]]; then
    rm -rf -- "$TLS_WORK_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

for command_name in docker helm kind kubectl openssl; do
  require_command "$command_name"
done

TLS_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/daedalus-redis-upgrade.XXXXXX")"
TLS_V1_DIR="$TLS_WORK_DIR/v1"
TLS_V2_DIR="$TLS_WORK_DIR/v2"
TLS_CA_BUNDLE="$TLS_WORK_DIR/ca-overlap.crt"

generate_tls_material() {
  local output_dir="$1" ca_common_name="$2"
  local extension_file="$output_dir/server.ext"
  mkdir -p "$output_dir"

  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 \
    -subj "/CN=$ca_common_name" \
    -keyout "$output_dir/ca.key" \
    -out "$output_dir/ca.crt" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=$REDIS_SERVICE_FQDN" \
    -keyout "$output_dir/tls.key" \
    -out "$output_dir/server.csr" >/dev/null 2>&1
  cat >"$extension_file" <<EOF
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:$REDIS_SERVICE,DNS:$REDIS_SERVICE.$NAMESPACE,DNS:$REDIS_SERVICE.$NAMESPACE.svc,DNS:$REDIS_SERVICE_FQDN
EOF
  openssl x509 -req -sha256 -days 2 \
    -in "$output_dir/server.csr" \
    -CA "$output_dir/ca.crt" \
    -CAkey "$output_dir/ca.key" \
    -CAcreateserial \
    -extfile "$extension_file" \
    -out "$output_dir/tls.crt" >/dev/null 2>&1
  openssl verify -CAfile "$output_dir/ca.crt" \
    "$output_dir/tls.crt" >/dev/null
}

apply_auth_secret() {
  local current_password="$1" previous_password="$2"
  kubectl -n "$NAMESPACE" create secret generic "$AUTH_SECRET" \
    --from-literal=REDIS_PASSWORD="$current_password" \
    --from-literal=REDIS_PREVIOUS_PASSWORD="$previous_password" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}

apply_tls_secret() {
  local certificate="$1" private_key="$2" ca_certificate="$3"
  kubectl -n "$NAMESPACE" create secret generic "$TLS_SECRET" \
    --from-file=tls.crt="$certificate" \
    --from-file=tls.key="$private_key" \
    --from-file=ca.crt="$ca_certificate" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}

docker build --provenance=false -t "$NEW_REPOSITORY:$NEW_TAG" "$REPO_ROOT/redis"
kind create cluster --name "$CLUSTER_NAME" --wait 120s
CLUSTER_CREATED=1
kind load docker-image "$NEW_REPOSITORY:$NEW_TAG" --name "$CLUSTER_NAME"
kubectl create namespace "$NAMESPACE"

# A Kind hostPath is created as root and doesn't receive the pod fsGroup
# ownership adjustment that a CSI-backed volume normally provides. Provision
# the fixture directory explicitly so this test exercises the production
# non-root Redis security context instead of weakening it for the test.
docker exec "$CLUSTER_NAME-control-plane" \
  install -d -m 0770 -o 1001 -g 1001 /var/lib/daedalus-redis-upgrade-fixture

generate_tls_material "$TLS_V1_DIR" "daedalus-kind-fixture-ca-v1"
generate_tls_material "$TLS_V2_DIR" "daedalus-kind-fixture-ca-v2"
cat "$TLS_V1_DIR/ca.crt" "$TLS_V2_DIR/ca.crt" >"$TLS_CA_BUNDLE"
AUTONOMY_PROCESSING_HASH="$(
  printf '%s' "$AUTONOMY_PROCESSING" | openssl dgst -sha256 | awk '{print $NF}' | cut -c1-32
)"
AUTONOMY_CLAIM_KEY="autonomy:fixture-user:processing_claim:$AUTONOMY_PROCESSING_HASH"

apply_auth_secret "$OLD_PASSWORD" ''
apply_tls_secret \
  "$TLS_V1_DIR/tls.crt" "$TLS_V1_DIR/tls.key" "$TLS_V1_DIR/ca.crt"

kubectl apply -f - <<YAML
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: redis-fixture-manual
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: redis-fixture-pv
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: redis-fixture-manual
  hostPath:
    path: /var/lib/daedalus-redis-upgrade-fixture
    type: DirectoryOrCreate
YAML

COMMON_ARGS=(
  --namespace "$NAMESPACE"
  --set-string "global.fullnameOverride=$FULLNAME"
  --set backend.default.enabled=false
  --set backend.persistence.enabled=false
  --set backend.networkPolicy.enabled=false
  --set frontend.enabled=false
  --set nginx.enabled=false
  --set nginx.imageVolume.enabled=false
  --set ingress.enabled=false
  --set autonomousAgent.enabled=false
  --set redis.persistence.size=1Gi
  --set-string redis.persistence.storageClassName=redis-fixture-manual
  --set-string "redis.auth.username=$REDIS_USER"
  --set-string "redis.auth.existingSecret=$AUTH_SECRET"
  --set redis.tls.enabled=true
  --set-string "redis.tls.existingSecret=$TLS_SECRET"
  --timeout 8m
  --wait
  --atomic
)

upgrade_redis() {
  local repository="$1" tag="$2" digest="$3" pull_policy="$4"
  FORCE_ROLLOUT=$((FORCE_ROLLOUT + 1))
  helm upgrade --install "$RELEASE" "$CHART" \
    "${COMMON_ARGS[@]}" \
    --set-string "images.redis.repository=$repository" \
    --set-string "images.redis.tag=$tag" \
    --set-string "images.redis.digest=$digest" \
    --set-string "images.redis.pullPolicy=$pull_policy" \
    --set-string "forceRedeploy=redis-fixture-$FORCE_ROLLOUT"
  kubectl -n "$NAMESPACE" rollout status \
    "deployment/$FULLNAME-redis" --timeout=5m
}

redis_cli() {
  local password="$1"
  shift
  kubectl -n "$NAMESPACE" exec "deployment/$FULLNAME-redis" -- \
    env REDISCLI_AUTH="$password" \
    redis-cli --no-auth-warning --raw \
    --tls --cacert "$TLS_MOUNT_PATH/ca.crt" \
    --sni "$REDIS_SERVICE_FQDN" \
    -h "$REDIS_SERVICE_FQDN" -p 6379 \
    --user "$REDIS_USER" "$@"
}

assert_value() {
  local password="$1" expected="$2"
  shift 2
  local actual
  actual="$(redis_cli "$password" "$@" | tr -d '\r')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected '$expected' from Redis, got '$actual'" >&2
    exit 1
  fi
}

assert_first_output_line() {
  local password="$1" expected="$2"
  shift 2
  local actual
  actual="$(redis_cli "$password" "$@" | tr -d '\r' | sed -n '1p')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected first Redis output line '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_positive_ttl() {
  local password="$1" redis_key="$2"
  local ttl
  ttl="$(redis_cli "$password" TTL "$redis_key" | tr -d '\r')"
  if [[ ! "$ttl" =~ ^[0-9]+$ || "$ttl" -le 0 ]]; then
    echo "Expected a positive TTL for '$redis_key', got '$ttl'" >&2
    exit 1
  fi
}

assert_stream_group() {
  local password="$1"
  local groups
  groups="$(
    redis_cli "$password" XINFO GROUPS "$STREAM_QUEUE_KEY" | tr -d '\r'
  )"
  if ! grep -Fxq "$STREAM_GROUP" <<<"$groups"; then
    echo "Redis Stream consumer group '$STREAM_GROUP' is missing" >&2
    exit 1
  fi
}

assert_fixture() {
  local password="$1"
  assert_value "$password" 'session-fixture' GET 'session:fixture'
  assert_value "$password" '{"status":"running","jobId":"job-1"}' \
    JSON.GET 'job:job-1'
  assert_value "$password" 'approved' HGET 'approval:approval-1' status

  # Preserve the reliable autonomous queue and an in-flight processing claim.
  assert_value "$password" '1' LLEN "$AUTONOMY_QUEUE_KEY"
  assert_value "$password" "$AUTONOMY_QUEUED" \
    LINDEX "$AUTONOMY_QUEUE_KEY" 0
  assert_value "$password" '1' LLEN "$AUTONOMY_PROCESSING_KEY"
  assert_value "$password" "$AUTONOMY_PROCESSING" \
    LINDEX "$AUTONOMY_PROCESSING_KEY" 0
  assert_value "$password" 'fixture-owner' GET "$AUTONOMY_LEASE_KEY"
  assert_value "$password" "$AUTONOMY_CLAIM" GET "$AUTONOMY_CLAIM_KEY"
  assert_positive_ttl "$password" "$AUTONOMY_LEASE_KEY"
  assert_positive_ttl "$password" "$AUTONOMY_CLAIM_KEY"

  # Preserve the frontend Redis Stream entry, payload, and pending ownership.
  assert_value "$password" '1' XLEN "$STREAM_QUEUE_KEY"
  assert_first_output_line "$password" "$STREAM_ENTRY_ID" \
    XRANGE "$STREAM_QUEUE_KEY" "$STREAM_ENTRY_ID" "$STREAM_ENTRY_ID" COUNT 1
  assert_stream_group "$password"
  assert_first_output_line "$password" '1' \
    XPENDING "$STREAM_QUEUE_KEY" "$STREAM_GROUP"
  assert_value "$password" \
    '{"messagesForNat":[{"role":"user","content":"fixture"}],"verifiedUsername":"fixture-user"}' \
    JSON.GET "$STREAM_PAYLOAD_KEY"
  assert_value "$password" 'fixture-stream-owner' GET "$STREAM_LEASE_KEY"
  assert_value "$password" \
    '{"ownerToken":"fixture-stream-owner","startedAt":1}' \
    GET "$STREAM_STARTED_KEY"
  assert_positive_ttl "$password" "$STREAM_PAYLOAD_KEY"
  assert_positive_ttl "$password" "$STREAM_LEASE_KEY"
  assert_positive_ttl "$password" "$STREAM_STARTED_KEY"
}

assert_password_rejected() {
  local password="$1"
  local output
  output="$(redis_cli "$password" PING 2>&1 || true)"
  if [[ "$output" == *PONG* ]]; then
    echo "Redis credential unexpectedly remained valid" >&2
    exit 1
  fi
  if [[ "$output" != *WRONGPASS* && "$output" != *NOAUTH* && "$output" != *"AUTH failed"* ]]; then
    echo "Redis rejected a credential for an unexpected reason: $output" >&2
    exit 1
  fi
}

assert_default_user_rejected() {
  local application_password="$1"
  local output
  output="$(
    kubectl -n "$NAMESPACE" exec "deployment/$FULLNAME-redis" -- \
      env REDISCLI_AUTH="$application_password" \
      redis-cli --no-auth-warning --raw \
      --tls --cacert "$TLS_MOUNT_PATH/ca.crt" \
      --sni "$REDIS_SERVICE_FQDN" \
      -h "$REDIS_SERVICE_FQDN" -p 6379 PING 2>&1 || true
  )"
  if [[ "$output" == *PONG* ]]; then
    echo "Redis application credential unexpectedly authenticated as the default user" >&2
    exit 1
  fi
  if [[ "$output" != *WRONGPASS* \
    && "$output" != *NOAUTH* \
    && "$output" != *"AUTH failed"* ]]; then
    echo "Redis default-user authentication failed for an unexpected reason: $output" >&2
    exit 1
  fi
}

assert_plaintext_rejected() {
  local password="$1"
  local output
  output="$(
    kubectl -n "$NAMESPACE" exec "deployment/$FULLNAME-redis" -- \
      env REDISCLI_AUTH="$password" \
      redis-cli --no-auth-warning --raw \
      -h "$REDIS_SERVICE_FQDN" -p 6379 \
      --user "$REDIS_USER" PING 2>&1 || true
  )"
  if [[ "$output" == *PONG* ]]; then
    echo "Redis accepted plaintext traffic while TLS was required" >&2
    exit 1
  fi
  if [[ "$output" != *"closed the connection"* \
    && "$output" != *"Connection reset"* \
    && "$output" != *"Protocol error"* \
    && "$output" != *"Could not connect"* ]]; then
    echo "Plaintext Redis failed for an unexpected reason: $output" >&2
    exit 1
  fi
}

assert_mounted_certificate() {
  local expected_certificate="$1"
  local expected_hash actual_hash
  expected_hash="$(openssl dgst -sha256 "$expected_certificate" | awk '{print $NF}')"
  actual_hash="$(
    kubectl -n "$NAMESPACE" exec "deployment/$FULLNAME-redis" -- \
      sha256sum "$TLS_MOUNT_PATH/tls.crt" | awk '{print $1}'
  )"
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    echo "Redis mounted certificate hash '$actual_hash', expected '$expected_hash'" >&2
    exit 1
  fi
}

assert_ca_rejected() {
  local password="$1" rejected_ca="$2" label="$3"
  local remote_ca="/tmp/rejected-$label-ca.crt"
  local output
  kubectl -n "$NAMESPACE" exec -i "deployment/$FULLNAME-redis" -- \
    /bin/bash -c 'umask 077; cat >"$1"' _ "$remote_ca" <"$rejected_ca"
  output="$(
    kubectl -n "$NAMESPACE" exec "deployment/$FULLNAME-redis" -- \
      env REDISCLI_AUTH="$password" \
      redis-cli --no-auth-warning --raw \
      --tls --cacert "$remote_ca" \
      --sni "$REDIS_SERVICE_FQDN" \
      -h "$REDIS_SERVICE_FQDN" -p 6379 \
      --user "$REDIS_USER" PING 2>&1 || true
  )"
  if [[ "$output" == *PONG* ]]; then
    echo "Redis certificate unexpectedly validated against $label CA" >&2
    exit 1
  fi
  if [[ "$output" != *"certificate verify failed"* \
    && "$output" != *"SSL_connect failed"* ]]; then
    echo "Redis rejected $label CA for an unexpected reason: $output" >&2
    exit 1
  fi
}

upgrade_redis "$OLD_REPOSITORY" "$OLD_TAG" "$OLD_DIGEST" IfNotPresent
assert_value "$OLD_PASSWORD" PONG PING
assert_plaintext_rejected "$OLD_PASSWORD"
assert_mounted_certificate "$TLS_V1_DIR/tls.crt"
assert_password_rejected "$NEW_PASSWORD"
assert_default_user_rejected "$OLD_PASSWORD"

redis_cli "$OLD_PASSWORD" SET 'session:fixture' 'session-fixture' >/dev/null
redis_cli "$OLD_PASSWORD" JSON.SET 'job:job-1' '$' \
  '{"status":"running","jobId":"job-1"}' >/dev/null
redis_cli "$OLD_PASSWORD" HSET 'approval:approval-1' status approved >/dev/null
redis_cli "$OLD_PASSWORD" LPUSH "$AUTONOMY_QUEUE_KEY" \
  "$AUTONOMY_QUEUED" >/dev/null
redis_cli "$OLD_PASSWORD" LPUSH "$AUTONOMY_PROCESSING_KEY" \
  "$AUTONOMY_PROCESSING" >/dev/null
redis_cli "$OLD_PASSWORD" SET "$AUTONOMY_LEASE_KEY" fixture-owner EX 86400 >/dev/null
redis_cli "$OLD_PASSWORD" SET "$AUTONOMY_CLAIM_KEY" \
  "$AUTONOMY_CLAIM" EX 86400 >/dev/null

redis_cli "$OLD_PASSWORD" XGROUP CREATE \
  "$STREAM_QUEUE_KEY" "$STREAM_GROUP" 0 MKSTREAM >/dev/null
STREAM_ENTRY_ID="$(
  redis_cli "$OLD_PASSWORD" XADD \
    "$STREAM_QUEUE_KEY" '*' jobId "$STREAM_JOB_ID" | tr -d '\r'
)"
redis_cli "$OLD_PASSWORD" JSON.SET "$STREAM_PAYLOAD_KEY" '$' \
  '{"messagesForNat":[{"role":"user","content":"fixture"}],"verifiedUsername":"fixture-user"}' >/dev/null
redis_cli "$OLD_PASSWORD" EXPIRE "$STREAM_PAYLOAD_KEY" 86400 >/dev/null
redis_cli "$OLD_PASSWORD" SET "$STREAM_LEASE_KEY" \
  fixture-stream-owner EX 86400 >/dev/null
redis_cli "$OLD_PASSWORD" SET "$STREAM_STARTED_KEY" \
  '{"ownerToken":"fixture-stream-owner","startedAt":1}' EX 86400 >/dev/null
redis_cli "$OLD_PASSWORD" XREADGROUP GROUP \
  "$STREAM_GROUP" "$STREAM_CONSUMER" COUNT 1 \
  STREAMS "$STREAM_QUEUE_KEY" '>' >/dev/null

# AOF fsync defaults to every second. Wait for the fixture to reach the PVC
# without granting the application ACL user administrative SAVE access.
sleep 2
assert_fixture "$OLD_PASSWORD"

# Upgrade the exact persisted fixture to the production Redis Stack build.
upgrade_redis "$NEW_REPOSITORY" "$NEW_TAG" "$NEW_DIGEST" IfNotPresent
assert_fixture "$OLD_PASSWORD"
assert_plaintext_rejected "$OLD_PASSWORD"
assert_mounted_certificate "$TLS_V1_DIR/tls.crt"
assert_default_user_rejected "$OLD_PASSWORD"

# Rotate the external ACL Secret without a credential gap. First add the new
# credential as overlap while clients still use the old credential.
apply_auth_secret "$OLD_PASSWORD" "$NEW_PASSWORD"
upgrade_redis "$NEW_REPOSITORY" "$NEW_TAG" "$NEW_DIGEST" IfNotPresent
assert_fixture "$OLD_PASSWORD"
assert_fixture "$NEW_PASSWORD"

# Switch clients to the new credential while retaining the old overlap value.
apply_auth_secret "$NEW_PASSWORD" "$OLD_PASSWORD"
upgrade_redis "$NEW_REPOSITORY" "$NEW_TAG" "$NEW_DIGEST" IfNotPresent
assert_fixture "$NEW_PASSWORD"
assert_fixture "$OLD_PASSWORD"

# Remove the former credential after all clients can use the new one.
apply_auth_secret "$NEW_PASSWORD" ''
upgrade_redis "$NEW_REPOSITORY" "$NEW_TAG" "$NEW_DIGEST" IfNotPresent
assert_fixture "$NEW_PASSWORD"
assert_password_rejected "$OLD_PASSWORD"

# Rotate trust and the server certificate in three safe rollouts. First give
# clients an old-plus-new CA bundle while Redis still serves the old leaf.
apply_tls_secret \
  "$TLS_V1_DIR/tls.crt" "$TLS_V1_DIR/tls.key" "$TLS_CA_BUNDLE"
upgrade_redis "$NEW_REPOSITORY" "$NEW_TAG" "$NEW_DIGEST" IfNotPresent
assert_fixture "$NEW_PASSWORD"
assert_mounted_certificate "$TLS_V1_DIR/tls.crt"
assert_ca_rejected "$NEW_PASSWORD" "$TLS_V2_DIR/ca.crt" future

# Replace the server leaf and key while clients trust the overlap bundle.
apply_tls_secret \
  "$TLS_V2_DIR/tls.crt" "$TLS_V2_DIR/tls.key" "$TLS_CA_BUNDLE"
upgrade_redis "$NEW_REPOSITORY" "$NEW_TAG" "$NEW_DIGEST" IfNotPresent
assert_fixture "$NEW_PASSWORD"
assert_mounted_certificate "$TLS_V2_DIR/tls.crt"
assert_ca_rejected "$NEW_PASSWORD" "$TLS_V1_DIR/ca.crt" former

# Remove the old CA only after the new leaf is live.
apply_tls_secret \
  "$TLS_V2_DIR/tls.crt" "$TLS_V2_DIR/tls.key" "$TLS_V2_DIR/ca.crt"
upgrade_redis "$NEW_REPOSITORY" "$NEW_TAG" "$NEW_DIGEST" IfNotPresent
assert_fixture "$NEW_PASSWORD"
assert_plaintext_rejected "$NEW_PASSWORD"
assert_mounted_certificate "$TLS_V2_DIR/tls.crt"
assert_ca_rejected "$NEW_PASSWORD" "$TLS_V1_DIR/ca.crt" former

# Roll back only across byte-compatible 7.4.0-v8 images. External Secrets keep
# the secure new credential and certificate while Helm restores revision 1.
helm rollback "$RELEASE" 1 --namespace "$NAMESPACE" --wait --timeout 8m
kubectl -n "$NAMESPACE" rollout status \
  "deployment/$FULLNAME-redis" --timeout=5m
assert_fixture "$NEW_PASSWORD"
assert_password_rejected "$OLD_PASSWORD"
assert_mounted_certificate "$TLS_V2_DIR/tls.crt"
assert_ca_rejected "$NEW_PASSWORD" "$TLS_V1_DIR/ca.crt" former

# Finish on the patched image and prove the persisted fixture is unchanged.
upgrade_redis "$NEW_REPOSITORY" "$NEW_TAG" "$NEW_DIGEST" IfNotPresent
assert_fixture "$NEW_PASSWORD"
assert_password_rejected "$OLD_PASSWORD"
assert_plaintext_rejected "$NEW_PASSWORD"
assert_mounted_certificate "$TLS_V2_DIR/tls.crt"

echo "Redis persisted upgrade, TLS, compatible rollback, ACL rotation, and certificate rotation passed"
