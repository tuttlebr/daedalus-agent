# Request recovery and data lifecycle

## Ownership and account changes

Chat submission reserves a conversation ID and binds `ownerId` before enqueuing
work. Conversation updates, reads, traces, and finalization check the same
authoritative record and user membership. Existing records without `ownerId`
are adopted on an authorized write; client history or selection copies do not
grant ownership. RedisJSON and plain JSON string records remain supported.
If expiry or deletion precedes the final conversation write, an old queued job
cannot recreate that record or write into another user's later use of the ID.
Finalization records the
suppressed conversation write and finishes cleanup without publishing or
retaining a replacement conversation. The job's own terminal result remains
available through its normal owner-protected status path.

Deletion concurrent with later finalization phases is not a transaction across
Redis publication and the external memory service. A finalizer that already
saved its authorized result can still publish or retain it while deletion runs;
the selected-conversation cache also has a separate update. Do not interpret
conversation deletion as revoking in-flight external retention or erasing facts.

Update the frontend, WebSocket server and stream worker together. Existing
unowned legacy jobs are deliberately suppressed; resubmit from an authorized
conversation after reconciling any tool side effects. Rolling back to older
writers removes the new ownership guarantees even though the additive JSON
fields are compatible. No bulk data rewrite is required.

Configured accounts determine login eligibility; retained Redis credentials
and history are not an enablement flag. Restart every frontend and WebSocket
process after changing account configuration. Removed users' API sessions are
revoked before sliding TTL refresh, and WebSocket sessions are checked during
handshake and periodic revalidation. Historical records remain available for
an operator's separate retention decision. This is not remote OAuth token
revocation or cancellation of already accepted work.

## Stream termination contracts

The generic NAT chat adapter accepts an assistant final/finish event, `[DONE]`,
or clean transport EOF as completion for compatibility with configured
OpenAI-compatible backends. An explicit stream exception, cancellation or
deadline is a failure. Clean EOF by itself cannot prove that a remote provider
intended its last token; a gateway that silently truncates a successful stream
can therefore still look complete. Prefer providers that emit explicit final
events and validate new providers with interrupted and clean-EOF fixtures.

The Image API adapter retains its compatibility contract: a clean provider EOF
with only partial images promotes the last partial for each image to a result.
An exception while streaming does not promote a partial. This does not prove
that a preview reached the provider's intended final quality. The frontend
requires the backend's completed/image-result event; a partial-only backend
stream is rejected. The first-party document ingestion protocol is stricter:
it requires an explicit successful `complete` event and treats EOF without
that event as incomplete. SSE parsing accepts LF and CRLF boundaries.

## Media and outbound requests

SVG uploads are rasterized before original bytes are stored. Legacy SVG reads
are also rasterized and all image responses carry a sandbox CSP. Ownership
checks still precede access. Previously cached pre-upgrade responses can persist
until their existing cache lifetime ends; new responses apply the new policy.

Both Create and chat editing accept at most 16 image references, matching the
attachment picker. Each request has a 64 MiB aggregate base64-decoded input
budget and a separate 64 MiB multipart byte budget, including a panel mask.
Identical references reuse bytes only within that authorized request while
retaining order and multiplicity. Repeated output parts still consume the
multipart budget. These are encoded-file byte limits, not a measurement or
upper bound on image decoder pixel memory. Existing decoder safeguards remain.

Push subscriptions accept only HTTPS on the standard port for FCM, Mozilla's
push service and Apple push subdomains, with valid Web Push keys. Registration
and sending both validate the destination and discard unsupported legacy
records. Helm disables push by default; enabling it requires VAPID keys and
the matching provider egress policy described in the chart README. Standard
NetworkPolicy needs explicit provider CIDRs; Cilium supports the documented
provider names. No real provider is contacted by repository tests.
The endpoint list follows [Apple's Web Push requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
and the [Web Push server examples](https://web.dev/articles/push-notifications-server-codelab).

Rate counters now increment and establish expiry atomically. Legacy counters
without a TTL are repaired when checked; ordinary login lockout durations and
the existing rate-limit availability policy remain unchanged.

## Retention and deletion

| Data                                | Retention and deletion contract                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversations                       | Seven-day TTL refreshed by an accepted save/reservation. Deleting a conversation removes its owned record and private history/selection copies; it does not erase previously retained Hindsight facts or uploaded source objects.                                                                                                                                                                                                                                                    |
| Upload metadata                     | `DOCUMENT_OBJECT_EXPIRY_SECONDS`, default seven days from upload. Missing/expired references are rejected for the submitted turn; expired historical references are omitted so later conversation turns remain usable.                                                                                                                                                                                                                                                               |
| Source objects                      | Explicit deletion removes the object before metadata. Compose derives the Seaweed prefix TTL from the same expiry setting, rounded upward to a representable duration. Existing objects keep their original TTL. Kubernetes/external S3 requires an operator-managed lifecycle policy; expiry headers alone do not delete bytes. See runtime image documentation for the measured expiry and physical reclamation distinction.                                                       |
| Milvus vectors                      | Ingestion creates a separate durable representation. Source-object expiry and conversation deletion do not imply vector deletion. The current application exposes ingest/extract/search/list operations, not vector deletion. Vector retention/deletion requires an operator-managed Milvus procedure outside these APIs; the migration utility copies and verifies without deleting either collection. Verify the database, owner and collection before a separate operator action. |
| Uploaded images                     | Seven-day Redis TTL, refreshed by the authorized touch path. Upload derivatives and originals share a record. Explicit image deletion does not delete copies already incorporated into external tool outputs.                                                                                                                                                                                                                                                                        |
| Hindsight facts and knowledge pages | Durable service data, independent of chat/document TTLs. Memory Center clear and approved chat clear invalidate derived automatic-context caches as well as durable content. Profile replacement retains and verifies the replacement before deleting only the captured old documents. Partial cleanup can leave both generations and is reported. See the Hindsight integration guide.                                                                                              |
| Browser caches                      | Blob URLs have reference-counted lifetime. IndexedDB step snapshots are compressed caches of server history; they are not an ownership authority or the sole conversation record. Cache cleanup does not constitute server deletion.                                                                                                                                                                                                                                                 |

Logical expiry, a successful S3 DELETE, compaction/vacuum reclamation, and backup
retention are distinct operator concerns. Backups and third-party tool side
effects need their own retention policies. Do not infer secure physical erasure
from a missing application reference.

## Operator capability checks

Existing `/health/ready` backend diagnostics report required versus optional
MCP capabilities, Redis availability, configurable Hindsight readiness and
Milvus collection availability. Required dependencies return 503; optional
unavailability is reported as degraded. Frontend `/api/health?ready=1` checks
Redis and its local WebSocket sidecar. These interfaces already provide the
operator detail recommended by the review; no new public credential-bearing
diagnostic endpoint is needed.

Readiness does not execute a model, test embedding dimensions, refresh a real
OAuth grant, verify bucket IAM, or prove that all optional tools work. Run a
synthetic request in a disposable deployment using test accounts when validating
those boundaries. Never substitute readiness for the complete request checks.
