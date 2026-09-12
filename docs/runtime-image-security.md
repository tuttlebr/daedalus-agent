# Runtime image inventory and applicability

`deployment-images.json` is the scan inventory for repository-built services
and immutable upstream runtime images on amd64 and arm64. `scripts/check_image_inventory.py`
compares it with rendered root Compose, browser Compose, and default/custom
Helm. New services and changed digests fail the check until accounted for.
CI, release and `make docker` use the same upstream scan entrypoint; the
existing backend/frontend/Redis scans retain their HIGH/CRITICAL gates and
the backend's exact two OCI docstring-example exceptions.

Run `python3 scripts/check_image_inventory.py --scan-upstream` with Docker,
Helm and Trivy installed. It inventories before scanning and checks every
upstream image on both declared architectures even if another has findings.
Platform selection is explicit and scanner architecture metadata must match;
remote image reads prevent a host-cached variant from substituting another architecture. No production service or cluster
is used. Applicability probes copy the native executable from an ephemeral,
network-disabled container that is never started. ELF architecture and Go
function-symbol controls are checked without executing image code. Raw scanner results remain visible alongside any applicability
decision; scanner or evidence failures stop the gate.

The current nginx pins update to 1.31.5; Compose uses the official Alpine slim
variant because it needs only the built-in proxy/gzip modules. Helm keeps the
unprivileged image. SeaweedFS updates from 4.39 to stable 4.46. Preserve an
object-store volume backup before an operational upgrade; this implementation
does not migrate or delete user volumes. Validate reading existing objects
before allowing new writes after rollback.

## One bounded gRPC applicability record

SeaweedFS 4.46 retains gRPC `v1.85.0-dev`, within the reported version range of
[CVE-2026-84445](https://github.com/grpc/grpc-go/security/advisories/GHSA-2v4p-qf9q-27wj).
That advisory requires an xDS server. The pinned executable links ordinary
`grpc.NewServer`; its vulnerable xDS constructor and internal server code are
absent. The [upstream constructor](https://github.com/seaweedfs/seaweedfs/blob/4.46/weed/pb/grpc_client_server.go#L183-L207)
and master/filer/volume callers agree with the native binary evidence.

`security/image-vex.json` records `not_affected` with justification
`vulnerable_code_not_present`, not a patched dependency. The gate requires the
exact image digest, separately reviewed amd64 or arm64 architecture, binary path,
package, installed version and advisory, and
rechecks ELF architecture, positive ordinary-gRPC/transport symbols and absent
xDS symbols.
Missing evidence, a changed digest, another finding, or expiry on
2026-10-11 fails closed. The raw Seaweed scan still reports the affected
dependency. Prefer a subsequent stable image with patched gRPC; do not extend
these records without fresh source/binary/advisory review.
Use `--platform linux/arm64` to scan that variant explicitly; the binary probe
works across host architectures and does not require emulation. Other
architectures have no applicability record and fail closed.

The previously blocked Thrift primary advisory is available as the Apache
maintainer's [original oss-security post](https://www.openwall.com/lists/oss-security/2026/07/24/33).
It confirms versions before 0.24.0 are affected. The updated Seaweed image no
longer reports the old Thrift dependency finding.

Development JavaScript updates separately resolve the reviewed Vitest,
Browserslist/baseline mapping, brace expansion, js-yaml, selector-parser and
Undici advisories. No production audit or security threshold was weakened.

## Compose object retention

Compose now derives Seaweed's document-prefix TTL from
`DOCUMENT_OBJECT_EXPIRY_SECONDS`, the same setting used for application object
metadata. Seaweed represents TTLs as a count of at most 255 minutes, hours,
days, weeks, months or years. `scripts/document_object_ttl.sh` rounds upward
to a representable interval; it never truncates below the application lifetime.
The setting must be a positive integer of at most 255 years. The default seven
days is unchanged. Physical bytes can remain until the rounded TTL and
Seaweed's volume reclamation; API access still expires at the metadata deadline.

Reclamation is a separate, asynchronous event. In a disposable Seaweed 4.46
experiment, a 2 MiB object under a one-minute rule became unreadable after
60.1 seconds, while its volume still occupied 2,101,248 allocated bytes.
Automatic TTL volume garbage collection removed that data file after
125.2 seconds; a seven-day control remained readable and allocated. No forced
vacuum or clock change was used. This is an observed idle-volume example,
not an exact disk-erasure deadline. Seaweed's
[volume expiry logic](https://github.com/seaweedfs/seaweedfs/blob/4.46/weed/storage/volume.go#L423-L479)
counts from the volume's last write and includes minute rounding and a
removal delay. Further writes to a shared volume can postpone reclamation.
Operators with a strict physical-deletion deadline must account for their
object-store volume lifecycle in addition to the application's access TTL.

The prefix rule applies to new writes. Existing objects keep their previous
physical TTL; changing the setting does not restore already expired bytes or
rewrite existing object lifetimes. For deployments that previously configured
metadata longer than seven days, preserve and re-upload still-needed originals
before their old physical expiry. Vector, memory and cache deletion remain
separate lifecycle contracts; object expiry does not silently delete vectors.
