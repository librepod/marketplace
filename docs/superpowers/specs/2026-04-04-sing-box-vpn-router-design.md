# sing-box VPN Router for wg-easy

Date: 2026-04-04

## Problem

wg-easy provides a WireGuard VPN server for clients (phones, laptops) to connect to the homelab cluster. Currently, all client traffic exits directly through the cluster's internet connection. We need domain/IP-based routing so that selected traffic (Telegram, custom domains) exits through a VPN, Russian sites go direct, and everything else goes direct.

## Solution

Add [sing-box](https://sing-box.sagernet.org/) as a transparent routing proxy inside the wg-easy pod, using iptables tproxy to intercept WireGuard client traffic and route it based on domain/IP rules through appropriate outbounds.

## Architecture

```
Phone/Laptop
     │
     │ WireGuard tunnel (UDP :51820 via Traefik)
     ▼
┌──────────────────────────────────────────────────┐
│ Pod: wg-easy (namespace: wg-easy)                │
│                                                  │
│  ┌──────────────┐   iptables    ┌─────────────┐ │
│  │  wg-easy     │   tproxy      │  sing-box    │ │
│  │  (WireGuard) │──────────────►│  (router)    │ │
│  │  :51820 WG   │   DNS redirect│  :12345 tproxy│ │
│  │  :51821 UI   │               │  :5353 DNS   │ │
│  └──────────────┘               └──────┬───────┘ │
│                                        │         │
│  ┌──────────────┐                      │         │
│  │ iptables-init│ (sets up rules,      │         │
│  │ (long-lived) │  then sleeps)        │         │
│  └──────────────┘                      │         │
└────────────────────────────────────────┼─────────┘
                                         │
                          ┌──────────────┼──────────┐
                          ▼                         ▼
                  ┌──────────────┐         ┌──────────────┐
                  │ VPN Exit (WG)│         │ Direct       │
                  │ sing-box     │         │ Internet     │
                  │ outbound     │         │              │
                  └──────────────┘         └──────────────┘
```

### Traffic flow

1. Client connects to WireGuard (existing wg-easy, unchanged)
2. `iptables-init` container sets up tproxy rules: all TCP/UDP from `wg0` -> sing-box port 12345, DNS -> sing-box port 5353
3. sing-box sniffs domains from TLS SNI/HTTP Host, matches routing rules, sends to appropriate outbound
4. Routing rules: Russian sites -> direct, Telegram + custom domains -> VPN exit, default -> direct

### Design decisions

- **Sidecar pattern**: sing-box runs as a sidecar in the wg-easy pod (shared network namespace). This avoids cross-pod networking complexity and lets iptables rules reference `wg0` directly.
- **iptables-init as long-lived container**: Not an initContainer because `wg0` is created dynamically by wg-easy at startup. The container waits for `wg0` to appear, then applies rules and sleeps.
- **Kustomize Component**: All sing-box resources live in `apps/wg-easy/components/sing-box-router/` as a `kind: Component`. The overlay includes it via `components:` field. Disabling the router is removing one line.
- **Env var substitution in sing-box config**: sing-box supports `${ENV_VAR}` in its JSON config. VPN credentials are stored in a Kubernetes Secret and injected via `envFrom`, keeping secrets out of ConfigMaps.
- **tproxy + DNS redirect**: Transparent proxy intercepts all traffic without client configuration. DNS redirect ensures sing-box sees domain names for routing decisions.
- **Sniff mode**: `sniff: true` on the tproxy inbound extracts domain names from TLS SNI/HTTP Host headers, enabling domain-based routing without FakeIP complexity.

## File structure

```
apps/wg-easy/
├── base/                              # Unchanged
├── components/
│   └── sing-box-router/               # NEW Kustomize component
│       ├── kustomization.yaml         # kind: Component
│       ├── sing-box-config.yaml       # ConfigMap with sing-box JSON config
│       ├── patch-deployment.yaml      # Strategic merge patch adding sidecars
│       ├── vpn-exit-secret.env        # VPN exit credentials (WireGuard keys)
│       └── wg-easy-dns.env            # DNS override: INIT_DNS=127.0.0.1
├── overlays/
│   └── librepod/
│       ├── kustomization.yaml         # Modified: add components: [] entry
│       ├── ingressroute-http.yaml     # Unchanged
│       ├── ingressroute-udp.yaml      # Unchanged
│       ├── patch-pvc.yaml             # Unchanged
│       └── wg-easy.env                # Unchanged
└── metadata.yaml                      # Unchanged
```

## Component details

### `kustomization.yaml` (Component)

```yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

configMapGenerator:
- name: sing-box-config
  files:
  - config.json=sing-box-config.yaml
- name: wg-easy
  envs:
  - wg-easy-dns.env
  behavior: merge

secretGenerator:
- name: vpn-exit-credentials
  envs:
  - vpn-exit-secret.env

patches:
- path: patch-deployment.yaml
```

### `sing-box-config.yaml`

sing-box JSON configuration with:
- **DNS**: `remote-dns` (tls://8.8.8.8 via direct) + `local-dns` (local resolver). Russian sites use local DNS.
- **Inbounds**: tproxy on 127.0.0.1:12345 (with sniff enabled), DNS on 127.0.0.1:5353
- **Outbounds**: `direct-out`, `vpn-exit` (WireGuard outbound using env var substitution), `block-out`
- **Route rules**:
  - DNS protocol -> dns-out
  - geosite-category-ru -> direct-out
  - Telegram IPs (91.108.0.0/16) -> vpn-exit
  - Custom domains -> vpn-exit (placeholder for user-specific domains)
  - final -> direct-out
- **Rule sets**: Remote geosite-category-ru from SagerNet/sing-geosite

### `patch-deployment.yaml` (Strategic merge patch)

Adds to the wg-easy Deployment:
- **sing-box container**: `ghcr.io/sagernet/sing-box:latest`, NET_ADMIN capability, envFrom vpn-exit-credentials secret, sing-box-config volume mount. Resources: 64-256Mi memory, 100-500m CPU.
- **iptables-init container**: `alpine:latest`, installs iptables, waits for wg0 interface, applies tproxy rules (mangle/PREROUTING for TCP/UDP) and DNS redirect (nat/PREROUTING), then `sleep infinity`. NET_ADMIN + NET_RAW capabilities, lib-modules volume mount (readOnly).
- **Volumes**: sing-box-config ConfigMap volume (new). The `lib-modules` hostPath volume already exists in the base deployment and is only referenced as a volumeMount in the iptables-init container.

### `vpn-exit-secret.env`

```
VPN_SERVER=nl-server.example.com
VPN_SERVER_PORT=51820
VPN_LOCAL_ADDRESS=10.10.0.2/32
VPN_PRIVATE_KEY=<redacted>
VPN_PEER_PUBLIC_KEY=<redacted>
```

### `wg-easy-dns.env`

```
INIT_DNS=127.0.0.1
```

Points WireGuard clients' DNS to sing-box within the shared pod network namespace.

### Overlay change

One line added to `overlays/librepod/kustomization.yaml`:

```yaml
components:
- ../../components/sing-box-router
```

## Routing policy

| Traffic | Route |
|---------|-------|
| Russian sites (geosite-category-ru) | Direct |
| Telegram (91.108.0.0/16) | VPN exit |
| Custom domains (configurable) | VPN exit |
| Everything else | Direct |

## Error handling

| Failure | Impact | Mitigation |
|---------|--------|------------|
| sing-box crashes | Routed traffic drops | Container auto-restart. sing-box restarts in <1s |
| VPN exit unreachable | Telegram/custom domains unreachable | Direct traffic unaffected. sing-box logs errors |
| iptables rules lost (pod restart) | Traffic bypasses sing-box | iptables-init re-applies on every start |
| wg-easy restarts (wg0 recreated) | Stale iptables rules | Full pod restart reinitializes everything |

## Observability

- sing-box logs to stdout at info level: `kubectl logs <pod> -c sing-box`
- iptables-init logs on rule application: `kubectl logs <pod> -c iptables-init`
- No web dashboard in initial implementation (future enhancement)

## Future enhancements

- Additional VPN exit pods (AmneziaWG, VLESS) as separate SOCKS5 services
- sing-box web dashboard for real-time monitoring
- Custom domain list via ConfigMap for easy user editing
- FakeIP mode as alternative to tproxy (simpler, no iptables)
- Health probes for sing-box container
