#!/bin/sh
# Persists the root token + recovery keys to the openbao-credentials Secret
# on first init and mirrors them to the seal PVC, so a reinstall that
# preserves the volumes restores the Secret (and thus admin access)
# automatically; hands the root token to the bootstrap container on re-runs.
# Runs in the bootstrap Job alongside the bootstrap container; they exchange
# state through /shared.
set -e
SEAL_CREDS=/seal/credentials.json
root_token() {
  sed -n 's/.*"root_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1"
}

if kubectl get secret openbao-credentials >/dev/null 2>&1; then
  kubectl get secret openbao-credentials -o jsonpath='{.data.root-token}' | base64 -d > /shared/root-token
  # keep the seal-volume copy current (back-fill after upgrades)
  if [ ! -s "$SEAL_CREDS" ]; then
    kubectl get secret openbao-credentials -o jsonpath='{.data.recovery-keys}' | base64 -d > "$SEAL_CREDS"
    chmod 600 "$SEAL_CREDS"
  fi
  exit 0
fi

if [ -s "$SEAL_CREDS" ]; then
  # reinstall with preserved data: restore the Secret from the seal-volume
  # copy — credentials survive namespace deletion
  ROOT_TOKEN=$(root_token "$SEAL_CREDS")
  kubectl create secret generic openbao-credentials \
    --from-literal=root-token="$ROOT_TOKEN" \
    --from-file=recovery-keys="$SEAL_CREDS"
  printf '%s' "$ROOT_TOKEN" > /shared/root-token
  exit 0
fi

touch /shared/no-secret
until [ -f /shared/done ]; do
  sleep 2
done
if [ -f /shared/credentials.json ]; then
  ROOT_TOKEN=$(root_token /shared/credentials.json)
  kubectl create secret generic openbao-credentials \
    --from-literal=root-token="$ROOT_TOKEN" \
    --from-file=recovery-keys=/shared/credentials.json
  cp /shared/credentials.json "$SEAL_CREDS"
  chmod 600 "$SEAL_CREDS"
fi
