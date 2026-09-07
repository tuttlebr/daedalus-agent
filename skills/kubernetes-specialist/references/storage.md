# Persistent storage

Trace PVC → PV → StorageClass/CSI driver → node placement → mounted filesystem
→ application read/write behavior. Inspect binding mode, access mode, capacity,
reclaim policy, topology, mount options and ownership before changing storage.

- A Pending PVC may be waiting for a consumer; correlate scheduler and volume
  events. A Bound PVC does not prove a mount or successful application I/O.
- Preserve populated PVCs/PVs and StatefulSet claim identity. StorageClass or
  access-mode changes may require a data migration; never delete/recreate a
  claim as a generic repair.
- Distinguish node-local storage from shared NFS and confirm the client's lock,
  permission and mount contract. Do not change mount options from an old example.
- Validate resize and snapshot/clone support against the installed CSI driver.
  Application-consistent recovery can require more than a volume snapshot.
- Use temporary emptyDir only for disposable data; memory-backed volumes count
  against memory. Do not retain sandbox workspaces by adding a PVC.

For a requested migration or recovery, define ownership, backup/restore evidence,
RPO/RTO, cutover and rollback before mutation. Validate using a separate target
where possible; never overwrite the live volume merely to test restoration.
Report storage readiness and verified application data separately.
