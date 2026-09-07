# Health by observed path

There is no guaranteed aggregate WAN/LAN/WLAN/VPN health operation in this
integration-API server. Use inventory, device/interface detail and statistics;
identify missing live connectivity observations explicitly.

| Surface    | Evidence and limits                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Controller | Authenticated `getInfo`; local MCP readiness alone cannot prove access                                                     |
| WAN        | Gateway/interface observations plus a real caller-path check when available; `listWanInterfaces` alone lists configuration |
| LAN        | Switch state, uplink/port details, relevant statistics and affected clients                                                |
| WLAN       | AP state, radio/interface statistics, client association; a Wi-Fi broadcast configuration is not airtime/latency proof     |
| VPN        | Tunnel/server configuration plus live state only if actually returned; configured tunnel is not a working tunnel           |

Trace the affected dependency chain, often upstream gateway → switch → AP/client.
Do not force a WAN investigation for a purely local isolated-device symptom.
Keep cause as a hypothesis until correlated with current evidence.

For Kubernetes access issues, hand the site/device/path evidence to
`kubernetes-specialist`; successful controller reads cannot establish NodePort,
Cilium, VLAN routing or application authentication health.
