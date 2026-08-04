#!/bin/sh
# Bootstraps Secret/user-apps-ssh-key (ed25519 keypair + Gogs host known_hosts)
# so Flux's GitRepository/user-apps-source can clone flux/user-apps.git over SSH
# instead of HTTP basic auth. Provider-agnostic: this provisions the Gogs default;
# an operator can pre-create the Secret to point Flux at an external git provider
# (GitHub/GitLab), in which case this Job is a no-op.
#
# Flow: apk add openssh-client -> download kubectl -> wait until the Gogs API
# accepts flux basic auth -> skip if Secret exists (idempotent + override hook) ->
# generate keypair -> register pubkey to the flux Gogs user -> ssh-keyscan Gogs ->
# create the Secret with Reflector annotations.
#
# Runs as root (runAsUser: 0) ONLY because alpine's apk needs root to install
# openssh-client (ssh-keygen + ssh-keyscan). One-shot bootstrap pod, not a
# long-running service. allowPrivilegeEscalation=false + ALL caps dropped.
set -eu

NS="${GOGS_NAMESPACE:-gogs}"
GOGS_API="http://gogs.${NS}.svc.cluster.local:80"
SECRET_NAME="user-apps-ssh-key"
KEY_TITLE="librepod-flux"

# openssh-client provides ssh-keygen + ssh-keyscan (not in base alpine).
echo "Installing openssh-client..."
apk add --no-cache openssh-client >/dev/null

# Download kubectl matching the cluster's actual minor version (repo bootstrap
# convention; see apps/headscale/components/bootstrap-api-key/job.sh).
if ! command -v kubectl >/dev/null 2>&1; then
  SA=/var/run/secrets/kubernetes.io/serviceaccount
  cat /etc/ssl/certs/ca-certificates.crt "$SA/ca.crt" > /tmp/ca-bundle.crt 2>/dev/null || cat "$SA/ca.crt" > /tmp/ca-bundle.crt
  export SSL_CERT_FILE=/tmp/ca-bundle.crt
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

# Wait until Gogs accepts flux basic auth — proves gogs is up AND the flux user
# (restored from gogs-init.zip) exists with the expected password.
B64="$(printf '%s:%s' "$FLUX_USER" "$FLUX_PASS" | base64 | tr -d '\n')"
echo "Waiting for Gogs API to accept flux credentials..."
READY=0
for i in $(seq 1 60); do
  if wget -q -O /dev/null --header="Authorization: Basic $B64" "${GOGS_API}/api/v1/user/keys"; then
    READY=1
    break
  fi
  sleep 5
done
if [ "$READY" != "1" ]; then
  echo "ERROR: Gogs API never accepted flux credentials at ${GOGS_API}" >&2
  exit 1
fi
echo "Gogs API reachable, flux credentials accepted."

# Idempotency + provider-override hook: if the Secret already exists, do nothing.
if kubectl get secret "$SECRET_NAME" -n "$NS" >/dev/null 2>&1; then
  echo "Secret/${SECRET_NAME} already exists; nothing to do (operator override or prior run)."
  exit 0
fi

# Generate the keypair.
echo "Generating ed25519 keypair..."
ssh-keygen -t ed25519 -N "" -C "$KEY_TITLE" -f /tmp/id >/dev/null
PUB="$(cat /tmp/id.pub)"

# Register the pubkey to the flux user (idempotent: skip if a key with this title
# already exists, e.g. after this Job was deleted and recreated by Flux).
echo "Checking for existing key titled ${KEY_TITLE}..."
EXISTING="$(wget -q -O - --header="Authorization: Basic $B64" "${GOGS_API}/api/v1/user/keys" 2>/dev/null || true)"
if echo "$EXISTING" | grep -Eq "\"title\"[[:space:]]*:[[:space:]]*\"${KEY_TITLE}\""; then
  echo "Key ${KEY_TITLE} already registered with Gogs; skipping registration."
else
  echo "Registering pubkey with Gogs as ${KEY_TITLE}..."
  if ! wget --header="Authorization: Basic $B64" \
            --header="Content-Type: application/json" \
            --post-data="{\"title\":\"${KEY_TITLE}\",\"key\":\"${PUB}\"}" \
            -O - "${GOGS_API}/api/v1/user/keys"; then
    echo "ERROR: pubkey registration request to Gogs failed (response above)" >&2
    exit 1
  fi
fi

# Discover Gogs's SSH host key.
echo "ssh-keyscan-ing Gogs SSH host key..."
ssh-keyscan -p 22 -T 10 "gogs.${NS}.svc.cluster.local" > /tmp/known_hosts 2>/dev/null || true
if [ ! -s /tmp/known_hosts ]; then
  echo "ERROR: ssh-keyscan returned no host keys" >&2
  exit 1
fi

# Create the Secret with Reflector annotations (mirror to flux-system +
# marketplace-ui). Phase 1 only consumes the flux-system reflection.
echo "Creating Secret/${SECRET_NAME}..."
kubectl create secret generic "$SECRET_NAME" -n "$NS" \
  --from-file=identity=/tmp/id \
  --from-file=known_hosts=/tmp/known_hosts \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate secret "$SECRET_NAME" -n "$NS" \
  reflector.v1.k8s.emberstack.com/reflection-allowed=true \
  reflector.v1.k8s.emberstack.com/reflection-auto-enabled=true \
  reflector.v1.k8s.emberstack.com/reflection-auto-namespaces=flux-system,marketplace-ui \
  --overwrite

echo "Done. Flux GitRepository/user-apps-source can now clone over SSH."
