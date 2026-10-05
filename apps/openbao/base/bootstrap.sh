#!/bin/sh
# One-time (idempotent) OpenBao bootstrap: init, KV v2 engine, Kubernetes
# auth, policies, roles, audit device. Runs in the bootstrap Job alongside
# the store-credentials container; they exchange state through /shared.
set -e

SA_DIR=/var/run/secrets/kubernetes.io/serviceaccount

echo "waiting for the openbao API..."
until bao status 2>&1 | grep -q "^Initialized "; do
  sleep 3
done

# Acquire a root token: reuse the one stored by a previous run if present,
# otherwise perform the one-time initialization.
for i in $(seq 1 60); do
  [ -f /shared/root-token ] && break
  [ -f /shared/no-secret ] && break
  sleep 1
done

if [ -f /shared/root-token ]; then
  BAO_TOKEN="$(cat /shared/root-token)"
elif [ -f /shared/no-secret ]; then
  echo "initializing openbao..."
  # A seal is configured, so no secret_shares/threshold (Shamir params) —
  # init returns recovery keys + root token.
  INIT_JSON="$(bao operator init -format=json)"
  printf '%s' "$INIT_JSON" > /shared/credentials.json
  touch /shared/done
  BAO_TOKEN="$(printf '%s' "$INIT_JSON" | sed -n 's/.*"root_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
else
  echo "ERROR: timed out waiting for credentials handshake" >&2
  exit 1
fi
export BAO_TOKEN

# KV v2 secrets engine at apps/
if ! bao secrets list -format=json | grep -q '"apps/"'; then
  bao secrets enable -path=apps kv-v2
fi

# Kubernetes auth method. No token_reviewer_jwt: the chart binds the server
# ServiceAccount to system:auth-delegator, so OpenBao reviews client tokens
# with its own auto-rotating SA token.
if ! bao auth list -format=json | grep -q '"kubernetes/"'; then
  bao auth enable kubernetes
fi
bao write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@"$SA_DIR/ca.crt"

# Policies
bao policy write eso-read-apps /bootstrap/eso-read-apps.hcl
bao policy write marketplace-ui-write-apps /bootstrap/marketplace-ui-write-apps.hcl

# Roles
bao write auth/kubernetes/role/external-secrets \
  bound_service_account_names=openbao-eso \
  bound_service_account_namespaces=openbao \
  policies=eso-read-apps ttl=20m

bao write auth/kubernetes/role/marketplace-ui \
  bound_service_account_names=marketplace-ui \
  bound_service_account_namespaces=marketplace-ui \
  policies=marketplace-ui-write-apps ttl=20m

# The audit device is declared in the server configuration (see
# helmrelease.yaml), not enabled via the API.

echo "openbao bootstrap complete"
