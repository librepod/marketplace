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
# version — discovered from the API at runtime, never hard-pinned. A fixed
# channel like stable-1.34 would silently fall outside kubectl's ±1 skew window
# once the cluster upgrades past 1.35, breaking this Job a year+ from now.
#
# KEEP THE DOWNLOAD LADDER BYTE-IDENTICAL across the three wget-flavour
# bootstrap scripts (this one, marketplace-ui bootstrap-session, user-apps-source
# bootstrap-ssh-key): the apps ship as separate OCI artifacts, so a shared script
# file is impossible — identical copies keep fixes mechanical. The curl-flavour
# step-* scripts mirror the same ladder.
SA=/var/run/secrets/kubernetes.io/serviceaccount
# busybox wget has no --ca-certificate flag and verifies TLS strictly, so build
# a bundle that trusts the cluster CA (for in-cluster API calls) on top of the
# system CAs, and point wget at it via SSL_CERT_FILE.
cat /etc/ssl/certs/ca-certificates.crt "$SA/ca.crt" > /tmp/ca-bundle.crt 2>/dev/null || cat "$SA/ca.crt" > /tmp/ca-bundle.crt
export SSL_CERT_FILE=/tmp/ca-bundle.crt
# system:authenticated can read /version (discovery), so the SA token is enough.
AUTH="Authorization: Bearer $(cat "$SA/token")"

# Cheap idempotency BEFORE any download, via the raw API: with
# ttlSecondsAfterFinished (job.yaml), Flux recreates this Job after every TTL
# GC — this check makes those re-runs ~free instead of re-fetching the ~60MB
# kubectl through the flaky egress the ladder below works around. Re-provision
# (rotate the key): delete the Job AND the Secret, then reconcile.
if wget -q -O /dev/null --header="$AUTH" \
  "https://kubernetes.default.svc/api/v1/namespaces/${NS}/secrets/headscale-api-key"; then
  echo "Secret/headscale-api-key already exists; nothing to do."
  exit 0
fi

if ! command -v kubectl >/dev/null 2>&1; then
  VER_JSON="$(wget -q -O - --header="$AUTH" https://kubernetes.default.svc/version)"
  # Full version from /version's gitVersion, keeping any prerelease suffix
  # (v1.37.1-rc.0+k3s1 -> 1.37.1-rc.0): dl.k8s.io publishes rc binaries, while
  # the old strip-to-GA 404'd on clusters riding a prerelease channel whose
  # X.Y.Z had no GA yet. The mirror does not carry rc — the ladder below falls
  # through to dl.k8s.io for those. dl.k8s.io channel files (stable-M.N.txt)
  # are not served by the mirror and live on the same flaky host, so we never
  # fetch them.
  KV="$(echo "$VER_JSON" | sed -n 's/.*"gitVersion": *"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\(-[A-Za-z0-9.]*\)\?\).*/\1/p' | head -n 1)"
  if [ -z "$KV" ]; then
    echo "ERROR: could not parse gitVersion from /version: $VER_JSON" >&2
    exit 1
  fi
  echo "Downloading kubectl v${KV}..."
  UP="https://dl.k8s.io/release/v${KV}/bin/linux/amd64/kubectl"
  MI="https://mirror.yandex.ru/mirrors/dl.k8s.io/v${KV}/bin/linux/amd64/kubectl"
  # Interleaved upstream/mirror ladder: under the motivating RU failure
  # (upstream AAAA-only resolve, healthy mirror) the working mirror is reached
  # on attempt 2, not 3. -T 300 is a per-read inactivity bound, NOT a total
  # cap: slow-but-alive links are never killed, a stalled transfer dies within
  # 300s, and the whole Job is bounded by activeDeadlineSeconds (job.yaml).
  n=0
  DL_OK=0
  for u in "$UP" "$MI" "$UP" "$MI"; do
    n=$((n + 1))
    if [ "$n" -gt 1 ]; then sleep $((n - 1)); fi
    if ! wget -q -T 300 -O /tmp/kubectl "$u"; then
      echo "kubectl download from $u failed (attempt $n/4)"
      continue
    fi
    # Verify against the .sha256 published by the OTHER host — a checksum from
    # the serving host cannot detect that host serving a corrupt binary.
    # Same-host fallback covers rc tags (the mirror 404s those); if no
    # checksum is reachable at all, warn and accept rather than hard-fail the
    # bootstrap on a flaky checksum fetch.
    case "$u" in
      https://dl.k8s.io/*) S="$MI" ;;
      *) S="$UP" ;;
    esac
    if wget -q -T 60 -O /tmp/kubectl.sha256 "${S}.sha256" \
      || wget -q -T 60 -O /tmp/kubectl.sha256 "${u}.sha256"; then
      SUM="$(set -- $(cat /tmp/kubectl.sha256); echo "${1:-}")"
      if [ -n "$SUM" ] && echo "$SUM  /tmp/kubectl" | sha256sum -c - >/dev/null 2>&1; then
        DL_OK=1
        break
      fi
      echo "checksum mismatch for $u (attempt $n/4)"
    else
      echo "WARNING: no .sha256 reachable for $u; accepting unverified kubectl" >&2
      DL_OK=1
      break
    fi
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
