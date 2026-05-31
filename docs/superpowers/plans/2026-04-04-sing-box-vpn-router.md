# sing-box VPN Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sing-box as a transparent traffic routing sidecar to the wg-easy deployment using a Kustomize Component, enabling domain/IP-based VPN routing for WireGuard clients.

**Architecture:** sing-box and an iptables-init container run as sidecars in the wg-easy pod (shared network namespace). iptables tproxy intercepts all WireGuard client traffic and redirects it to sing-box, which routes based on domain/IP rules. A single WireGuard outbound validates the full chain. All changes live in `apps/wg-easy/components/sing-box-router/`.

**Tech Stack:** sing-box, iptables/tproxy, Kustomize Components, Kubernetes Secrets, WireGuard

**Spec:** `docs/superpowers/specs/2026-04-04-sing-box-vpn-router-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/wg-easy/components/sing-box-router/kustomization.yaml` | Create | Component definition with generators and patches |
| `apps/wg-easy/components/sing-box-router/sing-box-config.yaml` | Create | sing-box JSON routing configuration |
| `apps/wg-easy/components/sing-box-router/patch-deployment.yaml` | Create | Strategic merge patch adding sidecar containers |
| `apps/wg-easy/components/sing-box-router/vpn-exit-secret.env` | Create | VPN exit credentials template (WireGuard keys) |
| `apps/wg-easy/components/sing-box-router/wg-easy-dns.env` | Create | DNS override: INIT_DNS=127.0.0.1 |
| `apps/wg-easy/overlays/librepod/kustomization.yaml` | Modify | Add `components:` entry for sing-box-router |

---

### Task 1: Create component directory and kustomization.yaml

**Files:**
- Create: `apps/wg-easy/components/sing-box-router/kustomization.yaml`

- [ ] **Step 1: Create the component directory**

```bash
mkdir -p apps/wg-easy/components/sing-box-router
```

- [ ] **Step 2: Write the component kustomization.yaml**

Create `apps/wg-easy/components/sing-box-router/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

generatorOptions:
  disableNameSuffixHash: true

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

Note: `disableNameSuffixHash: true` is required so the deployment patch can reference `vpn-exit-credentials` and `sing-box-config` by their exact names. Kustomize's name reference transformer is less reliable across Component boundaries. The existing `step-certificates/components/init-container` component in this repo uses the same pattern.

- [ ] **Step 3: Verify the directory structure**

```bash
ls -la apps/wg-easy/components/sing-box-router/
```

Expected: `kustomization.yaml` exists.

- [ ] **Step 4: Commit**

```bash
git add apps/wg-easy/components/sing-box-router/kustomization.yaml
git commit -m "feat(wg-easy): add sing-box-router component skeleton"
```

---

### Task 2: Create sing-box routing configuration

**Files:**
- Create: `apps/wg-easy/components/sing-box-router/sing-box-config.yaml`

This is the core routing logic. sing-box config uses `${ENV_VAR}` substitution for VPN credentials injected from the Secret at runtime.

- [ ] **Step 1: Write the sing-box config**

Create `apps/wg-easy/components/sing-box-router/sing-box-config.yaml`:

```json
{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {
        "tag": "remote-dns",
        "address": "tls://8.8.8.8",
        "detour": "direct-out"
      },
      {
        "tag": "local-dns",
        "address": "local"
      }
    ],
    "rules": [
      {
        "rule_set": "geosite-category-ru",
        "server": "local-dns"
      }
    ]
  },
  "inbounds": [
    {
      "type": "tproxy",
      "tag": "tproxy-in",
      "listen": "127.0.0.1",
      "listen_port": 12345,
      "sniff": true,
      "sniff_override_destination": false
    },
    {
      "type": "dns",
      "tag": "dns-in",
      "listen": "127.0.0.1",
      "listen_port": 5353
    }
  ],
  "outbounds": [
    {
      "type": "direct",
      "tag": "direct-out"
    },
    {
      "type": "wireguard",
      "tag": "vpn-exit",
      "server": "${VPN_SERVER}",
      "server_port": ${VPN_SERVER_PORT},
      "local_address": ["${VPN_LOCAL_ADDRESS}"],
      "private_key": "${VPN_PRIVATE_KEY}",
      "peer_public_key": "${VPN_PEER_PUBLIC_KEY}",
      "mtu": 1280
    },
    {
      "type": "block",
      "tag": "block-out"
    }
  ],
  "route": {
    "rules": [
      {
        "protocol": "dns",
        "outbound": "dns-out"
      },
      {
        "rule_set": "geosite-category-ru",
        "outbound": "direct-out"
      },
      {
        "ip_cidr": ["91.108.0.0/16"],
        "outbound": "vpn-exit"
      }
    ],
    "rule_set": [
      {
        "type": "remote",
        "tag": "geosite-category-ru",
        "format": "binary",
        "url": "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ru.srs",
        "download_detour": "direct-out"
      }
    ],
    "final": "direct-out",
    "auto_detect_interface": true
  }
}
```

Key points about this config:
- `sniff: true` extracts domain names from TLS SNI/HTTP Host for domain-based routing
- `sniff_override_destination: false` keeps original destination IP (needed for direct connections)
- `${VPN_*}` env vars are substituted at runtime from the vpn-exit-credentials Secret
- DNS on port 5353 handles client DNS queries; Russian sites resolve via local DNS (cluster DNS)
- Routing: Russian sites -> direct, Telegram (91.108.0.0/16) -> VPN exit, default -> direct

- [ ] **Step 2: Validate JSON syntax**

```bash
python3 -c "import json; json.load(open('apps/wg-easy/components/sing-box-router/sing-box-config.yaml'))"
```

Expected: no output (valid JSON).

- [ ] **Step 3: Commit**

```bash
git add apps/wg-easy/components/sing-box-router/sing-box-config.yaml
git commit -m "feat(wg-easy): add sing-box routing config with WG outbound"
```

---

### Task 3: Create VPN exit credentials template and DNS override

**Files:**
- Create: `apps/wg-easy/components/sing-box-router/vpn-exit-secret.env`
- Create: `apps/wg-easy/components/sing-box-router/wg-easy-dns.env`

- [ ] **Step 1: Write VPN exit credentials template**

Create `apps/wg-easy/components/sing-box-router/vpn-exit-secret.env`:

```
VPN_SERVER=nl-server.example.com
VPN_SERVER_PORT=51820
VPN_LOCAL_ADDRESS=10.10.0.2/32
VPN_PRIVATE_KEY=REPLACE_WITH_ACTUAL_KEY
VPN_PEER_PUBLIC_KEY=REPLACE_WITH_ACTUAL_KEY
```

Note: These are placeholder values. Real credentials must be replaced before deployment. Since `secretGenerator` adds a hash suffix, the Secret name in the deployment patch references `vpn-exit-credentials` (the base name).

- [ ] **Step 2: Write DNS override for wg-easy**

Create `apps/wg-easy/components/sing-box-router/wg-easy-dns.env`:

```
INIT_DNS=127.0.0.1
```

This overrides the wg-easy configmap's `INIT_DNS` value. With `behavior: merge`, Kustomize merges this into the existing `wg-easy` ConfigMap, changing the DNS that WireGuard clients receive to `127.0.0.1` (sing-box DNS listener within the shared pod network namespace).

- [ ] **Step 3: Commit**

```bash
git add apps/wg-easy/components/sing-box-router/vpn-exit-secret.env
git add apps/wg-easy/components/sing-box-router/wg-easy-dns.env
git commit -m "feat(wg-easy): add VPN exit secret template and DNS override"
```

---

### Task 4: Create deployment patch for sidecar containers

**Files:**
- Create: `apps/wg-easy/components/sing-box-router/patch-deployment.yaml`

This is the most critical file. It's a strategic merge patch that adds two containers (sing-box, iptables-init) and one new volume (sing-box-config) to the existing wg-easy deployment.

The existing base deployment (`apps/wg-easy/base/deployment.yaml`) already has:
- Container `wg-easy` with NET_ADMIN, SYS_MODULE capabilities
- Volume `lib-modules` (hostPath /lib/modules) — already defined, only needs volumeMount in new containers
- Volume `config` (PVC), `tun` (hostPath /dev/net/tun)
- sysctls: `net.ipv4.ip_forward=1`, `net.ipv4.conf.all.src_valid_mark=1`

- [ ] **Step 1: Write the deployment patch**

Create `apps/wg-easy/components/sing-box-router/patch-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wg-easy
spec:
  template:
    spec:
      containers:
      - name: sing-box
        image: ghcr.io/sagernet/sing-box:latest
        command:
        - sing-box
        - run
        - -c
        - /etc/sing-box/config.json
        securityContext:
          capabilities:
            add:
            - NET_ADMIN
            - NET_RAW
        envFrom:
        - secretRef:
            name: vpn-exit-credentials
        volumeMounts:
        - name: sing-box-config
          mountPath: /etc/sing-box
        resources:
          requests:
            memory: "64Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "500m"

      - name: iptables-init
        image: alpine:latest
        command:
        - /bin/sh
        - -c
        - |
          apk add --no-cache iptables iproute2
          echo "Waiting for wg0 interface..."
          while ! ip link show wg0 > /dev/null 2>&1; do sleep 1; done
          echo "wg0 found, applying iptables rules..."
          # Redirect all TCP from WG clients to sing-box tproxy
          iptables -t mangle -A PREROUTING -i wg0 -p tcp -j TPROXY \
            --on-port 12345 --tproxy-mark 0x1/0x1
          # Redirect UDP (except DNS) to sing-box tproxy
          iptables -t mangle -A PREROUTING -i wg0 -p udp ! --dport 53 -j TPROXY \
            --on-port 12345 --tproxy-mark 0x1/0x1
          # Redirect DNS to sing-box DNS handler
          iptables -t nat -A PREROUTING -i wg0 -p udp --dport 53 -j REDIRECT \
            --to-port 5353
          echo "iptables rules applied successfully"
          sleep infinity
        securityContext:
          capabilities:
            add:
            - NET_ADMIN
            - NET_RAW
        volumeMounts:
        - name: lib-modules
          mountPath: /lib/modules
          readOnly: true

      volumes:
      - name: sing-box-config
        configMap:
          name: sing-box-config
```

Key implementation details:
- **sing-box container**: Mounts the ConfigMap at `/etc/sing-box`, loads `config.json` from it. `envFrom` injects VPN credentials from the Secret for `${ENV_VAR}` substitution.
- **iptables-init container**: Runs as a long-lived container (not initContainer) because `wg0` is created dynamically by wg-easy at startup. Uses `apk add --no-cache iptables iproute2` to get both `iptables` and `ip` commands. Waits for `wg0`, applies tproxy + DNS redirect rules, then `sleep infinity`.
- **lib-modules volumeMount**: References the existing `lib-modules` volume from the base deployment (hostPath `/lib/modules`), needed by iptables to load kernel modules.
- **sing-box-config volume**: New ConfigMap volume, created by the component's configMapGenerator.

- [ ] **Step 2: Commit**

```bash
git add apps/wg-easy/components/sing-box-router/patch-deployment.yaml
git commit -m "feat(wg-easy): add deployment patch with sing-box + iptables sidecars"
```

---

### Task 5: Wire the component into the librepod overlay

**Files:**
- Modify: `apps/wg-easy/overlays/librepod/kustomization.yaml`

The overlay's kustomization needs a `components:` section pointing to the new component.

Current content of `apps/wg-easy/overlays/librepod/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
- ../../base
- ingressroute-http.yaml
- ingressroute-udp.yaml

images:
- name: ghcr.io/wg-easy/wg-easy
  newTag: "15.2"

configMapGenerator:
- name: wg-easy
  envs:
  - wg-easy.env
  behavior: merge

patches:
- path: patch-pvc.yaml
```

- [ ] **Step 1: Add components section**

Add a `components:` block after the `resources:` block in `apps/wg-easy/overlays/librepod/kustomization.yaml`:

```yaml
components:
- ../../components/sing-box-router
```

The file should now read:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
- ../../base
- ingressroute-http.yaml
- ingressroute-udp.yaml

components:
- ../../components/sing-box-router

images:
- name: ghcr.io/wg-easy/wg-easy
  newTag: "15.2"

configMapGenerator:
- name: wg-easy
  envs:
  - wg-easy.env
  behavior: merge

patches:
- path: patch-pvc.yaml
```

- [ ] **Step 2: Build the kustomization and verify output**

```bash
kustomize build apps/wg-easy/overlays/librepod
```

Expected: YAML output containing:
- The original namespace, PVC, services, and deployment
- The deployment now has 3 containers: `wg-easy`, `sing-box`, `iptables-init`
- A `sing-box-config` ConfigMap with the full JSON config
- A `vpn-exit-credentials` Secret
- The `wg-easy` ConfigMap has `INIT_DNS=127.0.0.1`

If the build fails, debug using:
```bash
kustomize build apps/wg-easy/overlays/librepod 2>&1 | head -50
```

- [ ] **Step 3: Verify sidecar containers appear in the deployment**

```bash
kustomize build apps/wg-easy/overlays/librepod | yq '. | select(.kind=="Deployment") | .spec.template.spec.containers[].name'
```

Expected output:
```
wg-easy
sing-box
iptables-init
```

- [ ] **Step 4: Verify ConfigMap merge (INIT_DNS override)**

```bash
kustomize build apps/wg-easy/overlays/librepod | yq '. | select(.kind=="ConfigMap" and .metadata.name | startswith("wg-easy")) | .data'
```

Expected: contains `INIT_DNS: 127.0.0.1` along with the other overlay env vars (`TZ`, `INIT_HOST`).

- [ ] **Step 5: Verify sing-box config has env var placeholders**

```bash
kustomize build apps/wg-easy/overlays/librepod | yq '. | select(.kind=="ConfigMap" and .metadata.name | startswith("sing-box-config")) | .data["config.json"]' | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['outbounds'][1]['server'])"
```

Expected: `${VPN_SERVER}` (literal placeholder, not resolved — resolution happens at sing-box runtime).

- [ ] **Step 6: Commit**

```bash
git add apps/wg-easy/overlays/librepod/kustomization.yaml
git commit -m "feat(wg-easy): wire sing-box-router component into librepod overlay"
```

---

### Task 6: Validate with kubeconform

**Files:** None (validation only)

- [ ] **Step 1: Run kubeconform on the full build**

```bash
kustomize build apps/wg-easy/overlays/librepod | kubeconform \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  -strict -summary
```

Expected: all resources pass. Note: kubeconform may not have schemas for Traefik IngressRouteUDP CRDs — those failures are expected and pre-existing.

- [ ] **Step 2: If any issues found, fix and re-run**

Fix any validation issues in the relevant files, then re-run the build + kubeconform.

---

### Task 7: Final review commit

- [ ] **Step 1: Review all changes**

```bash
git log --oneline -6
```

Expected: commits for component skeleton, sing-box config, secrets/DNS, deployment patch, overlay wiring.

- [ ] **Step 2: Verify final file structure**

```bash
find apps/wg-easy/components/sing-box-router -type f | sort
```

Expected:
```
apps/wg-easy/components/sing-box-router/kustomization.yaml
apps/wg-easy/components/sing-box-router/patch-deployment.yaml
apps/wg-easy/components/sing-box-router/sing-box-config.yaml
apps/wg-easy/components/sing-box-router/vpn-exit-secret.env
apps/wg-easy/components/sing-box-router/wg-easy-dns.env
```

- [ ] **Step 3: Do a final clean build**

```bash
kustomize build apps/wg-easy/overlays/librepod > /dev/null
```

Expected: exit code 0, no errors.

---

### Task 8: Deploy to librepod-dev cluster and verify

This task deploys the manifests imperatively to the dev cluster (`192.168.2.180`) using `kubectl apply`, then verifies the pod comes up healthy with all three containers running. **Do not use FluxCD** — push directly via kubectl.

**Prerequisites:**
- The dev cluster kubeconfig is at `./192.168.2.180.config` (repo root)
- The `vpn-exit-secret.env` must contain real credentials before deploying (replace placeholder values)
- wg-easy may already be deployed on the cluster — this will update it in place

- [ ] **Step 1: Apply the manifests to the dev cluster**

```bash
kustomize build apps/wg-easy/overlays/librepod | kubectl --kubeconfig ./192.168.2.180.config apply -f -
```

Expected: resources created/updated. The ConfigMap, Secret, and Deployment changes should be listed.

- [ ] **Step 2: Wait for the pod to roll out**

```bash
kubectl --kubeconfig ./192.168.2.180.config rollout status deployment/wg-easy -n wg-easy --timeout=120s
```

Expected: "deployment "wg-easy" successfully rolled out"

- [ ] **Step 3: Verify all three containers are running**

```bash
kubectl --kubeconfig ./192.168.2.180.config get pods -n wg-easy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{range .status.containerStatuses[*]}{.name}":"{.state.running.ready}{","}{end}{"\n"}{end}'
```

Expected: pod is `Running`, and all three containers (`wg-easy:true`, `sing-box:true`, `iptables-init:true`) show as ready.

- [ ] **Step 4: Check iptables-init logs — rules should be applied**

```bash
kubectl --kubeconfig ./192.168.2.180.config logs -n wg-easy -c iptables-init -l app.kubernetes.io/name=wg-easy
```

Expected output contains:
```
Waiting for wg0 interface...
wg0 found, applying iptables rules...
iptables rules applied successfully
```

If it's still "Waiting for wg0 interface...", the wg-easy container may not be fully started yet. Wait a moment and re-check.

- [ ] **Step 5: Check sing-box logs — should show startup without errors**

```bash
kubectl --kubeconfig ./192.168.2.180.config logs -n wg-easy -c sing-box -l app.kubernetes.io/name=wg-easy --tail=20
```

Expected: sing-box logs showing it started and is listening on `127.0.0.1:12345` (tproxy) and `127.0.0.1:5353` (DNS). No error-level log lines.

- [ ] **Step 6: Verify iptables rules are in place**

```bash
kubectl --kubeconfig ./192.168.2.180.config exec -n wg-easy -c iptables-init -l app.kubernetes.io/name=wg-easy -- iptables -t mangle -L PREROUTING -n -v
```

Expected: two TPROXY rules for TCP and UDP on port 12345, with `wg0` as the input interface.

Also check the NAT rule:
```bash
kubectl --kubeconfig ./192.168.2.180.config exec -n wg-easy -c iptables-init -l app.kubernetes.io/name=wg-easy -- iptables -t nat -L PREROUTING -n -v
```

Expected: one REDIRECT rule for UDP port 53 → port 5353.

- [ ] **Step 7: Connect a WireGuard client and test routing**

Connect a device to the WireGuard VPN (via the wg-easy UI or existing client config). Then verify:

```bash
# Check that the client appears in sing-box logs
kubectl --kubeconfig ./192.168.2.180.config logs -n wg-easy -c sing-box -l app.kubernetes.io/name=wg-easy --tail=30
```

Expected: sing-box logs show connection/routing activity from the client's IP (e.g., `10.6.0.x`). Russian site requests should route via `direct-out`, Telegram IPs should route via `vpn-exit`.

- [ ] **Step 8: If issues found, debug and fix**

Common issues:
- **sing-box crashLoopBackOff**: Check logs for config errors. Verify env vars are injected (`kubectl exec -c sing-box ... -- env | grep VPN_`).
- **iptables-init stuck on "Waiting for wg0"**: wg-easy may have failed to create the WireGuard interface. Check wg-easy container logs.
- **VPN exit not working**: Verify VPN credentials in the Secret are correct and the remote server is reachable from the cluster.
- **DNS not resolving**: Verify the DNS redirect rule exists and sing-box DNS listener is on port 5353.

After fixing, re-apply:
```bash
kustomize build apps/wg-easy/overlays/librepod | kubectl --kubeconfig ./192.168.2.180.config apply -f -
kubectl --kubeconfig ./192.168.2.180.config rollout restart deployment/wg-easy -n wg-easy
```
