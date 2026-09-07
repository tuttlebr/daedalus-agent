# Integration-API device states

`listAdoptedDevices` and `getAdoptedDeviceDetails` return string states in the
current contract. Do not apply legacy numeric state or device-type mappings.

| Returned state                          | Interpretation                                                         |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `ONLINE`                                | Controller sees the device online; traffic health still needs evidence |
| `OFFLINE`                               | Controller reports offline; inspect power/uplink and current impact    |
| `CONNECTION_INTERRUPTED`, `ISOLATED`    | Connectivity degradation requiring context                             |
| `GETTING_READY`, `ADOPTING`, `UPDATING` | Lifecycle transition; correlate duration and intended operation        |
| `PENDING_ADOPTION`                      | Awaiting adoption; do not adopt during a health check                  |
| `DELETING`                              | Removal transition; confirm intended operation from available context  |
| `U5G_INCORRECT_TOPOLOGY`                | Reported topology problem; inspect the affected path                   |
| Unknown/new value                       | Preserve the raw value and report unknown interpretation               |

Overview fields include `id`, `name`, `model`, `macAddress`, `ipAddress`,
`state`, `supported`, `firmwareVersion`, `firmwareUpdatable`, `features` and
`interfaces`, subject to actual response presence. `features` can identify
switching/accessPoint/gateway capabilities; one device can have several.
Do not claim mutually exclusive device-category counts from overlapping features.

Use `getAdoptedDeviceLatestStatistics` for observed utilization/uptime and
`getAdoptedDeviceDetails` for interface/uplink detail. Missing metrics are
unknown. Firmware-update availability is maintenance information, not evidence
of outage or an authorization to upgrade.
