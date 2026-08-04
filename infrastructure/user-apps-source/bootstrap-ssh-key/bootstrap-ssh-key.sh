#!/bin/sh
# Bootstraps Secret/user-apps-ssh-key (ed25519 keypair + Gogs host known_hosts)
# so Flux's GitRepository/user-apps-source can clone flux/user-apps.git over SSH
# instead of HTTP basic auth. Provider-agnostic: this provisions the Gogs default;
# an operator can pre-create the Secret to point Flux at an external git provider
# (GitHub/GitLab), in which case this Job is a no-op.
#
# Flow: apk add openssh-client curl jq -> download kubectl -> wait until the Gogs
# API accepts flux basic auth -> skip if Secret exists (idempotent + override hook)
# -> bootstrap (or reuse) a Gogs API token -> generate keypair -> register pubkey
# to the flux user (replacing any stale key under the same title) -> ssh-keyscan
# Gogs -> create the Secret with Reflector annotations.
#
# AUTH NOTE: Gogs's self endpoints (/api/v1/user/*) reject HTTP Basic auth in this
# version (401) — they require a token. The /api/v1/users/<name>/* endpoints DO
# accept Basic auth, so we bootstrap a token via /api/v1/users/flux/tokens (same
# trick the Marketplace UI uses) and then use that token for /api/v1/user/keys.
#
# Runs as root (runAsUser: 0) ONLY because alpine's apk needs root to install
# openssh-client/curl/jq. One-shot bootstrap pod, not a long-running service.
# allowPrivilegeEscalation=false + ALL caps dropped.
set -eu

NS="${GOGS_NAMESPACE:-gogs}"
GOGS_API="http://gogs.${NS}.svc.cluster.local:80"
SECRET_NAME="user-apps-ssh-key"
KEY_TITLE="librepod-flux"
TOKEN_NAME="librepod-ssh-bootstrap"

# openssh-client: ssh-keygen + ssh-keyscan. curl: Gogs API incl. DELETE (busybox
# wget can't DELETE). jq: robust JSON parsing (Gogs pretty-prints with spaces).
# git: seed the initial commit over SSH.
echo "Installing openssh-client curl jq git..."
apk add --no-cache openssh-client curl jq git >/dev/null

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

# Basic-auth header for the /api/v1/users/<flux>/* endpoints (token bootstrap).
B64="$(printf '%s:%s' "$FLUX_USER" "$FLUX_PASS" | base64 | tr -d '\n')"

# Wait until Gogs accepts flux basic auth on /api/v1/users/<flux>/tokens — proves
# gogs is up AND the flux user (created by the gogs bootstrap-admin initContainer)
# exists with the expected password. (We cannot use /api/v1/user/keys here: it
# 401s on basic auth.)
echo "Waiting for Gogs API to accept flux credentials..."
READY=0
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null -H "Authorization: Basic $B64" "${GOGS_API}/api/v1/users/${FLUX_USER}/tokens"; then
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

# Bootstrap or reuse a Gogs API token (reused by name so re-runs don't accumulate
# tokens). /api/v1/users/<flux>/tokens accepts basic auth; the token then
# authenticates the /api/v1/user/* self endpoints.
echo "Ensuring Gogs API token '${TOKEN_NAME}'..."
TOK="$(curl -fsS -H "Authorization: Basic $B64" "${GOGS_API}/api/v1/users/${FLUX_USER}/tokens" | jq -r ".[] | select(.name==\"${TOKEN_NAME}\") | .sha1" | head -n1 || true)"
if [ -z "$TOK" ] || [ "$TOK" = "null" ]; then
  echo "Token not found; creating..."
  TOK="$(curl -fsS -H "Authorization: Basic $B64" -H "Content-Type: application/json" -X POST --data "{\"name\":\"${TOKEN_NAME}\"}" "${GOGS_API}/api/v1/users/${FLUX_USER}/tokens" | jq -r .sha1)"
fi
if [ -z "$TOK" ] || [ "$TOK" = "null" ]; then
  echo "ERROR: could not obtain a Gogs API token" >&2
  exit 1
fi
echo "Gogs API token obtained."

# Ensure the user-apps repo exists. auto_init:false so WE control the first
# commit and its branch name (master, to match the GitRepository ref). Idempotent:
# if the repo already exists (old zip-restored cluster or a prior run) we skip
# creation and remember that so the seed step below leaves existing history alone.
echo "Ensuring repo ${FLUX_USER}/user-apps..."
REPO_EXISTED=0
if curl -fsS -o /dev/null -H "Authorization: token ${TOK}" "${GOGS_API}/api/v1/repos/${FLUX_USER}/user-apps"; then
  REPO_EXISTED=1
  echo "Repo ${FLUX_USER}/user-apps already exists."
else
  echo "Repo not found; creating..."
  curl -fsS -o /dev/null -H "Authorization: token ${TOK}" -H "Content-Type: application/json" \
    -X POST --data '{"name":"user-apps","private":true,"auto_init":false}' \
    "${GOGS_API}/api/v1/user/repos"
  echo "Repo created."
fi

# Generate the keypair.
echo "Generating ed25519 keypair..."
ssh-keygen -t ed25519 -N "" -C "$KEY_TITLE" -f /tmp/id >/dev/null
PUB="$(cat /tmp/id.pub)"

# Register the pubkey to the flux user. If a key with this title already exists
# with a DIFFERENT pubkey (e.g. rotation after the Secret was deleted), delete it
# first so the new private key in the Secret matches what Gogs has. Key DELETE is
# supported (DELETE /api/v1/user/keys/<id>); token DELETE is not, which is why we
# reuse the token by name above instead of recreating it.
echo "Checking for existing key titled '${KEY_TITLE}'..."
KEYS="$(curl -fsS -H "Authorization: token ${TOK}" "${GOGS_API}/api/v1/user/keys" || true)"
EXIST_ID="$(printf '%s' "$KEYS" | jq -r ".[] | select(.title==\"${KEY_TITLE}\") | .id" | head -n1)"
EXIST_PUB="$(printf '%s' "$KEYS" | jq -r ".[] | select(.title==\"${KEY_TITLE}\") | .key" | head -n1)"
if [ -n "$EXIST_ID" ] && [ "$EXIST_PUB" = "$PUB" ]; then
  echo "Key '${KEY_TITLE}' already registered with this pubkey; nothing to register."
else
  if [ -n "$EXIST_ID" ]; then
    echo "Replacing stale key '${KEY_TITLE}' (id=${EXIST_ID})..."
    curl -fsS -o /dev/null -X DELETE -H "Authorization: token ${TOK}" "${GOGS_API}/api/v1/user/keys/${EXIST_ID}"
  fi
  echo "Registering pubkey with Gogs as '${KEY_TITLE}'..."
  curl -fsS -o /dev/null -X POST -H "Authorization: token ${TOK}" -H "Content-Type: application/json" \
    --data "{\"title\":\"${KEY_TITLE}\",\"key\":\"${PUB}\"}" "${GOGS_API}/api/v1/user/keys"
  echo "Registered."
fi

# Discover Gogs's SSH host key.
echo "ssh-keyscan-ing Gogs SSH host key..."
ssh-keyscan -p 22 -T 10 "gogs.${NS}.svc.cluster.local" > /tmp/known_hosts 2>/dev/null || true
if [ ! -s /tmp/known_hosts ]; then
  echo "ERROR: ssh-keyscan returned no host keys" >&2
  exit 1
fi

# Seed the initial commit so Flux's user-apps Kustomization (path ./, branch
# master, prune+wait) has a valid empty target from day one. Only when the repo
# is truly empty (no branches) — never rewrite existing history on an adopted
# cluster. Authenticates with the key registered above, so a short retry absorbs
# Gogs' key-propagation lag.
NEEDS_SEED=0
if [ "$REPO_EXISTED" = "0" ]; then
  NEEDS_SEED=1
else
  BRANCHES="$(curl -fsS -H "Authorization: token ${TOK}" "${GOGS_API}/api/v1/repos/${FLUX_USER}/user-apps/branches" || echo '[]')"
  if [ "$(printf '%s' "$BRANCHES" | jq 'length')" = "0" ]; then
    NEEDS_SEED=1
  fi
fi

if [ "$NEEDS_SEED" = "1" ]; then
  echo "Seeding initial commit on master..."
  export GIT_SSH_COMMAND="ssh -i /tmp/id -o UserKnownHostsFile=/tmp/known_hosts -o IdentitiesOnly=yes"
  SEED_DIR=/tmp/user-apps-seed
  rm -rf "$SEED_DIR"
  mkdir -p "$SEED_DIR"
  cd "$SEED_DIR"
  cat > kustomization.yaml <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: []
YAML
  cat > README.md <<'MD'
# LibrePod user apps

This repository holds user-installed apps for this LibrePod cluster. It is
managed by the LibrePod marketplace UI — app installs append entries to
`kustomization.yaml`. FluxCD reconciles this repo into the cluster.
MD
  git init -q
  git config user.email "flux@libre.pod"
  git config user.name "flux"
  git checkout -q -b master
  git add kustomization.yaml README.md
  git commit -q -m "Initial commit"
  REMOTE="ssh://git@gogs.${NS}.svc.cluster.local:22/${FLUX_USER}/user-apps.git"
  PUSHED=0
  for i in 1 2 3 4 5; do
    if git push -q "$REMOTE" master; then
      PUSHED=1
      break
    fi
    echo "push attempt $i failed (key may not have propagated yet); retrying..."
    sleep 5
  done
  if [ "$PUSHED" != "1" ]; then
    echo "ERROR: could not push seed commit to ${REMOTE}" >&2
    exit 1
  fi
  echo "Seed commit pushed."
  cd /tmp
else
  echo "Repo already has history; skipping seed."
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
