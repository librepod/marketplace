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
  KV="$(wget -qO- "https://dl.k8s.io/release/stable-${MAJ}.${MIN}.txt")"
  echo "Downloading kubectl ${KV} (matching server ${MAJ}.${MIN})..."
  wget -qO /tmp/kubectl "https://dl.k8s.io/release/${KV}/bin/linux/amd64/kubectl"
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
