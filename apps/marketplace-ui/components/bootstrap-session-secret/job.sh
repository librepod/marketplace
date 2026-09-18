#!/bin/sh
# Bootstraps Secret/marketplace-ui-session with a random HMAC signing key on
# first install so the NestJS server (SessionService) can boot. SessionService
# (ui/packages/server/src/auth/session.service.ts) REFUSES TO BOOT when
# SESSION_SECRET is empty OR equals the committed public default — so the
# marketplace-ui Deployment pod stays Pending/CrashLoop until this Secret
# exists with a real value, then auto-starts (no CrashLoop on a bad value).
#
# This Secret is owned by this Job, NOT by Flux: it is never committed, so Flux
# never re-renders it (which would clobber the key back to the placeholder). Same
# model as apps/headscale/components/bootstrap-api-key (Secret/headscale-api-key).
# The Completed Job persists (no ttlSecondsAfterFinished) so Flux does not
# recreate/re-run it each reconcile; the script is idempotent regardless.
set -eu

NS="${MARKETPLACE_UI_NAMESPACE:-marketplace-ui}"
SECRET_NAME="marketplace-ui-session"
KEY_NAME="session-secret"
# Must match KNOWN_DEFAULT_SECRET in session.service.ts. If the Secret still
# holds this value (e.g. migration from the old Flux-managed placeholder), treat
# it as "needs generating".
KNOWN_DEFAULT="NZcbV2j7TK5DZTTEwD/tqssrP8CdDqHrjz/HpHjMJDg="

# The alpine image has no kubectl. Download one matching the cluster's ACTUAL
# version — discovered from the API at runtime, never hard-pinned. A fixed
# channel like stable-1.34 would silently fall outside kubectl's ±1 skew window
# once the cluster upgrades past 1.35, breaking this Job a year+ from now.
#
# KEEP THE DOWNLOAD LADDER BYTE-IDENTICAL across the three wget-flavour
# bootstrap scripts (headscale bootstrap-api-key, this one, user-apps-source
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
# kubectl through the flaky egress the ladder below works around. Force key
# rotation: delete the Job AND the Secret, then reconcile.
if wget -q -O /dev/null --header="$AUTH" \
  "https://kubernetes.default.svc/api/v1/namespaces/${NS}/secrets/${SECRET_NAME}"; then
  echo "Secret/${SECRET_NAME} already exists; nothing to do."
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

gen_secret() {
  # 32 bytes of entropy, base64 ≈ 44 chars. busybox head/base64 — no openssl
  # dependency on alpine. Practically never equals KNOWN_DEFAULT.
  head -c 32 /dev/urandom | base64
}

# Idempotency: if the Secret already holds a real (non-empty, non-default) key,
# preserve it. Only (re)generate when absent, empty, or still the public default
# (the migration case — beelink currently holds the placeholder).
if kubectl get secret "$SECRET_NAME" -n "$NS" >/dev/null 2>&1; then
  CURRENT="$(kubectl get secret "$SECRET_NAME" -n "$NS" -o "jsonpath={.data.$KEY_NAME}" 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [ -n "$CURRENT" ] && [ "$CURRENT" != "$KNOWN_DEFAULT" ]; then
    echo "Secret/$SECRET_NAME already holds a real key; nothing to do."
    exit 0
  fi
  echo "Secret/$SECRET_NAME exists but its key is empty / the public default — (re)generating."
else
  echo "Secret/$SECRET_NAME absent — generating a key."
fi

SECRET="$(gen_secret)"
# dry-run | apply is idempotent across both create and update, and avoids
# hand-base64-encoding / JSON-patch quoting for the value.
kubectl create secret generic "$SECRET_NAME" -n "$NS" \
  --from-literal="$KEY_NAME=$SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Done. marketplace-ui reads $KEY_NAME from Secret/$SECRET_NAME and will boot."
