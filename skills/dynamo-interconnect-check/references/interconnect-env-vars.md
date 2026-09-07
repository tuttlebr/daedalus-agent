# Transport configuration and evidence

Inspect effective settings and the selected transport in the deployed version.
NIXL supports backend plugins; UCX is not necessarily the selected backend.
NCCL collectives and NIXL KV transfers are different paths.

| Setting                                     | What to verify                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `UCX_TLS`                                   | Actual transport restriction versus automatic selection; do not force an old list |
| `UCX_NET_DEVICES`                           | Selected NIC/port and GPU affinity; unset can validly auto-select                 |
| `UCX_IB_GPU_DIRECT_RDMA`, `UCX_RNDV_SCHEME` | Version support and observed GPU-transfer behavior                                |
| `NIXL_PLUGIN_DIR`                           | Plugin location only if that build exposes the variable                           |
| `NCCL_IB_HCA`, `NCCL_SOCKET_IFNAME`         | Collective/bootstrapping interfaces and current topology                          |
| `NCCL_IB_DISABLE`                           | Whether RDMA is intentionally disabled for the tested collective path             |
| `NCCL_NET_GDR_LEVEL`, `NCCL_P2P_LEVEL`      | Supported distance policy and actual selected path                                |
| `NCCL_IB_GID_INDEX`                         | Version/fabric-specific override; avoid stale manual values                       |

Unset selectors are not failures. Start with the version's defaults unless
measured evidence justifies an override. See the
[UCX FAQ](https://openucx.readthedocs.io/en/master/faq.html) and
[NCCL environment reference](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/env.html).

## Capability versus transfer

RDMA devices/link state, GPU/NIC topology and exposed device permissions show
capability. The absence of `nvidia_peermem` alone is not decisive: supported
DMA-BUF paths may provide peer access. GDRCopy and NVLink are not universal
requirements. Missing probe binaries are inconclusive, never a pass.

To prove a path, use compatible shipped NIXL tooling with the actual peer roles,
placement, payload and intended transport. Record integrity, transferred bytes,
completion and timing. A `command -v` result or successful HTTP completion cannot
prove a pairwise transfer, RDMA selection or performance.

Do not install modules, modify policy, create privileged debug pods or inject
load as part of a passive inspection. Those need the requested action scope
and runtime capability. Report the unvalidated layer explicitly.
