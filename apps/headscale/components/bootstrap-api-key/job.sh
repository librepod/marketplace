#!/bin/sh
# Bootstraps Secret/headscale-api-key on first install so headplane can start
# with OIDC enabled (headplane's config validator hard-fails without this key).
#
# Flow: wait for headscale -> skip if the Secret already exists (idempotent) ->
# mint a long-lived key by exec'ing `headscale apikeys create` in the headscale
# container -> write the Secret. headplane's volume is REQUIRED (optional: false
# in components/headplane/deployment.yaml), so its pod waits in ContainerCreating
# until this Secret exists and then auto-starts — no CrashLoopBackOff, and no
# need for this Job to restart headplane.
#
# IMAGE DEPENDENCY: minting execs `headscale apikeys create` in the headscale
# container, which requires the headscale CLI to be callable via exec. This is
# true for the pinned v0.28.0-debug image. If you switch to the distroless
# non-debug image, exec the binary by its full path instead, or move minting to
# a unix-socket sidecar in the headscale pod (headscale's default unix_socket
# allows unauthenticated CLI access from within the pod). See headscale config:
# unix_socket: /var/run/headscale/headscale.sock
set -eu

NS="${HEADSCALE_NAMESPACE:-headscale}"
EXP="${API_KEY_EXPIRATION:-999d}"

# The alpine image has no kubectl. Download one matching the cluster's ACTUAL
# minor version — discovered from the API at runtime, never hard-pinned. A fixed
# channel like stable-1.34 would silently fall outside kubectl's ±1 skew window
# once the cluster upgrades past 1.35, breaking this Job a year+ from now.
if ! command -v kubectl >/dev/null 2>&1; then
  SA=/var/run/secrets/kubernetes.io/serviceaccount
  # busybox wget has no --ca-certificate flag and verifies TLS strictly, so build
  # a bundle that trusts the cluster CA (for the in-cluster /version call) on top
  # of the system CAs, and point wget at it via SSL_CERT_FILE.
  cat /etc/ssl/certs/ca-certificates.crt "$SA/ca.crt" > /tmp/ca-bundle.crt 2>/dev/null || cat "$SA/ca.crt" > /tmp/ca-bundle.crt
  export SSL_CERT_FILE=/tmp/ca-bundle.crt
  # system:authenticated can read /version (discovery), so the SA token is enough.
  VER_JSON="$(wget -q -O - --header="Authorization: Bearer $(cat "$SA/token")" https://kubernetes.default.svc/version)"
  MAJ="$(echo "$VER_JSON" | sed -n 's/.*"major": *"\([0-9]*\)".*/\1/p')"
  MIN="$(echo "$VER_JSON" | sed -n 's/.*"minor": *"\([0-9]*\)".*/\1/p')"
  if [ -z "$MAJ" ] || [ -z "$MIN" ]; then
    echo "ERROR: could not parse cluster version from /version: $VER_JSON" >&2
    exit 1
  fi
  # Full version from /version's gitVersion (e.g. v1.34.3+k3s2 -> v1.34.3):
  # dl.k8s.io channel files (stable-M.N.txt) are not served by the mirror
  # fallback below and live on the same flaky host, so we never fetch them.
  # Some networks (seen on RU residential ISPs) intermittently resolve
  # dl.k8s.io AAAA-only with no IPv6 route; busybox wget has no -4, so bound
  # each attempt with -T and fall back to the Yandex mirror (same binaries,
  # no /release/ prefix). Upstream stays primary for non-RU clusters.
  KV="$(echo "$VER_JSON" | sed -n 's/.*"gitVersion": *"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)"
  if [ -z "$KV" ]; then
    echo "ERROR: could not parse gitVersion from /version: $VER_JSON" >&2
    exit 1
  fi
  echo "Downloading kubectl v${KV} (matching server ${MAJ}.${MIN})..."
  DL_OK=0
  for u in \
    "https://dl.k8s.io/release/v${KV}/bin/linux/amd64/kubectl" \
    "https://mirror.yandex.ru/mirrors/dl.k8s.io/v${KV}/bin/linux/amd64/kubectl"
  do
    for attempt in 1 2; do
      # 50MB binary: -T 300 (the Yandex mirror measures ~1MB/s).
      if wget -q -T 300 -O /tmp/kubectl "$u"; then
        DL_OK=1
        break
      fi
      echo "kubectl download from $u failed (attempt $attempt); retrying..."
    done
    if [ "$DL_OK" = 1 ]; then break; fi
  done
  if [ "$DL_OK" != 1 ]; then
    echo "ERROR: could not download kubectl from any mirror" >&2
    exit 1
  fi
  chmod +x /tmp/kubectl
  export PATH=/tmp:$PATH
fi

echo "Waiting for headscale Deployment to be Available..."
# Poll with `kubectl get` (not `kubectl wait`, which needs list/watch — RBAC we
# deliberately don't grant; resourceName-scoped get is enough and tighter).
AVAIL=""
for i in $(seq 1 60); do
  AVAIL="$(kubectl get deploy/headscale -n "$NS" -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null)"
  [ "$AVAIL" = "True" ] && break
  sleep 5
done
if [ "$AVAIL" != "True" ]; then
  echo "ERROR: headscale Deployment never became Available" >&2
  exit 1
fi
echo "headscale is Available."

# Idempotency: a re-run (e.g. after this Job was deleted and recreated by Flux)
# must NOT mint a second key. If the Secret exists, assume the key is valid.
if kubectl get secret headscale-api-key -n "$NS" >/dev/null 2>&1; then
  echo "Secret/headscale-api-key already exists; nothing to do."
  exit 0
fi

echo "Minting a ${EXP} Headscale API key..."
API_KEY="$(kubectl exec deploy/headscale -n "$NS" -c headscale -- headscale apikeys create --expiration "$EXP")"
if [ -z "$API_KEY" ]; then
  echo "ERROR: headscale apikeys create returned an empty key" >&2
  exit 1
fi

echo "Creating Secret/headscale-api-key..."
# Idempotent create (dry-run | apply) in case of a race with a concurrent run.
kubectl create secret generic headscale-api-key -n "$NS" \
  --from-literal=api_key="$API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Done. headplane will mount this Secret and continue starting."
