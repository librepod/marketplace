#!/bin/sh
# Bootstraps Secret/user-apps-ssh-key (ed25519 keypair + Gogs host known_hosts)
# so Flux's GitRepository/user-apps-source can clone flux/user-apps.git over SSH
# instead of HTTP basic auth. Provider-agnostic: this provisions the Gogs default;
# an operator can pre-create the Secret to point Flux at an external git provider
# (GitHub/GitLab), in which case this Job is a no-op.
#
# Flow: apk add openssh-client curl jq git -> download kubectl -> wait until the
# Gogs API accepts flux basic auth -> skip if Secret exists (idempotent + override
# hook) -> ensure the user-apps repo -> generate keypair -> register pubkey to the
# flux user -> ssh-keyscan Gogs -> seed the initial commit over SSH -> create the
# Secret with Reflector annotations.
#
# AUTH NOTE: this Job authenticates every Gogs API call with HTTP Basic auth
# (flux:password) against the /api/v1/admin/* and /api/v1/repos/* endpoints it
# uses. Auth on gogs 0.14.3 (the pinned CVE-2026-25119 fix release) is
# ENDPOINT-SPECIFIC — do not read this as "token auth is broken." Live-verified
# on the pinned build (issue #180):
#   - token bootstrap: POST /api/v1/users/<u>/tokens        → Basic auth: 201 OK
#   - raw / contents : GET/PUT/DELETE /api/v1/repos/.../{raw,contents}/...
#                                                           → token <sha1>: 200/201/204 OK
#   - the /api/v1/user/* SELF endpoints reject Basic auth (401)
# So `token <sha1>` DOES work for repo file ops (the marketplace-ui server relies
# on exactly that and is correct). This Job simply stays on Basic auth for the
# admin-scoped provisioning endpoints it needs (repo/key create, repo metadata),
# which is sufficient and avoids a token-mint round-trip here:
#   - repo create : POST /api/v1/admin/users/<flux>/repos
#   - key register: POST /api/v1/admin/users/<flux>/keys
#   - repo exists : GET  /api/v1/repos/<flux>/user-apps (also yields "empty")
# Idempotency comes from the Secret early-exit (below) plus the repo GET-guard —
# not from key-list-by-title, since key listing returns nothing usable on this build.
#
# Runs as root (runAsUser: 0) ONLY because alpine's apk needs root to install
# openssh-client/curl/jq/git. One-shot bootstrap pod, not a long-running service.
# allowPrivilegeEscalation=false + ALL caps dropped.
set -eu

NS="${GOGS_NAMESPACE:-gogs}"
GOGS_API="http://gogs.${NS}.svc.cluster.local:80"
SECRET_NAME="user-apps-ssh-key"
KEY_TITLE="librepod-flux"

# openssh-client: ssh-keygen + ssh-keyscan. curl: Gogs API (captures HTTP status
# on key registration). jq: branch-count JSON parsing. git: seed the initial
# commit over SSH.
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

# Wait until Gogs accepts flux basic auth on /api/v1/users/<flux> — proves gogs is
# up AND the flux user (created by the gogs bootstrap-admin initContainer) exists
# with the expected password. This public endpoint accepts Basic auth; we use it
# (not a /api/v1/user/* self endpoint, which 401s on Basic) as the readiness probe.
echo "Waiting for Gogs API to accept flux credentials..."
READY=0
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null -H "Authorization: Basic $B64" "${GOGS_API}/api/v1/users/${FLUX_USER}"; then
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

# Ensure the user-apps repo exists. auto_init:false so WE control the first commit
# and its branch name (master, to match the GitRepository ref). Idempotent: GET
# first (200 = exists, 404 = missing) and only create on 404 — POSTing to an
# existing repo 500s. Create via the admin endpoint with Basic auth (the
# /api/v1/user/repos self endpoint needs a token; we use the admin-scoped
# equivalent with the Basic creds already in hand — see the AUTH NOTE).
#
# REPO_EMPTY drives the seed step below. We read it from the repo object's
# "empty" field (GET /repos/<flux>/user-apps returns "empty":true/false) rather
# than /branches, because the branches endpoint 401s on Basic auth for a private
# repo. A freshly created repo is empty by definition.
echo "Ensuring repo ${FLUX_USER}/user-apps..."
REPO_EMPTY=1
REPO_JSON="$(curl -fsS -H "Authorization: Basic $B64" "${GOGS_API}/api/v1/repos/${FLUX_USER}/user-apps" 2>/dev/null || true)"
if [ -n "$REPO_JSON" ]; then
  echo "Repo ${FLUX_USER}/user-apps already exists."
  # "empty":true when the repo has no commits; anything else means it has history.
  if [ "$(printf '%s' "$REPO_JSON" | jq -r '.empty')" = "false" ]; then
    REPO_EMPTY=0
  fi
else
  echo "Repo not found; creating..."
  curl -fsS -o /dev/null -H "Authorization: Basic $B64" -H "Content-Type: application/json" \
    -X POST --data '{"name":"user-apps","private":true,"auto_init":false}' \
    "${GOGS_API}/api/v1/admin/users/${FLUX_USER}/repos"
  echo "Repo created."
fi

# Generate the keypair.
echo "Generating ed25519 keypair..."
ssh-keygen -t ed25519 -N "" -C "$KEY_TITLE" -f /tmp/id >/dev/null
PUB="$(cat /tmp/id.pub)"

# Register the freshly generated pubkey to the flux user via the admin endpoint
# (Basic auth). We reach this block only when Secret/user-apps-ssh-key does NOT
# exist (early-exit above), i.e. a fresh install or a deliberate rotation
# (operator deleted the Secret) — so a brand-new keypair is always registered.
#
# Rotation/idempotency on this gogs build: we cannot list or delete keys by title
# via Basic auth (both the self and admin key-list endpoints 401/404), so we can't
# pre-delete a stale key. Gogs enforces UNIQUE key titles, so a leftover
# '${KEY_TITLE}' from a previously-failed run makes the add 422 ("Key title has
# been used"). To stay self-healing without manual cleanup, fall back to a
# unique-suffixed title on a title collision. The suffix is cosmetic (the title is
# just a label); the private key still lands in the Secret and authenticates the
# push. Orphaned keys from failed runs are harmless unused pubkeys; the Secret
# early-exit stops any accumulation once a run succeeds.
register_key() {
  # $1 = title. Echoes the HTTP code; body (on error) goes to stderr.
  _out="$(curl -sS -w '\n%{http_code}' -X POST -H "Authorization: Basic $B64" \
    -H "Content-Type: application/json" \
    --data "{\"title\":\"$1\",\"key\":\"${PUB}\"}" \
    "${GOGS_API}/api/v1/admin/users/${FLUX_USER}/keys")"
  _code="$(printf '%s' "$_out" | tail -n1)"
  if [ "$_code" != "201" ]; then
    printf '%s\n' "$_out" | sed '$d' >&2
  fi
  printf '%s' "$_code"
}

echo "Registering pubkey with Gogs as '${KEY_TITLE}'..."
REG_CODE="$(register_key "${KEY_TITLE}")"
if [ "$REG_CODE" = "422" ]; then
  ALT_TITLE="${KEY_TITLE}-$(date +%s)"
  echo "Title '${KEY_TITLE}' already in use (stale key from a prior run); retrying as '${ALT_TITLE}'..."
  REG_CODE="$(register_key "${ALT_TITLE}")"
fi
if [ "$REG_CODE" = "201" ]; then
  echo "Registered."
else
  echo "ERROR: key registration failed (HTTP ${REG_CODE})." >&2
  exit 1
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
# is truly empty (REPO_EMPTY from the "empty" field above) — never rewrite
# existing history on an adopted cluster. Authenticates with the key registered
# above, so a short retry absorbs Gogs' key-propagation lag.
if [ "$REPO_EMPTY" = "1" ]; then
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
