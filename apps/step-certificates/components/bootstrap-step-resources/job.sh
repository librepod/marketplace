#!/bin/bash

# This script bootstraps the Step CA resources for cert-manager integration.
# It creates ConfigMaps and Secrets from the Step CA PVC data.

set -e

echo "Welcome to Step CA resource bootstrapper."

# Download kubectl if not already available.
#
# Version comes from the cluster itself (/version gitVersion, e.g.
# v1.34.3+k3s2 -> v1.34.3): dl.k8s.io channel files (stable.txt) are not
# served by the mirror fallback below and live on the same flaky host.
#
# On some networks (seen on RU residential ISPs) DNS intermittently returns
# AAAA-only for dl.k8s.io while the host has no IPv6 route, making curl hang
# indefinitely. Every attempt is bounded (-4, --connect-timeout, --speed-limit
# stall detection) and falls back to the Yandex mirror, which serves the same
# binaries at /mirrors/dl.k8s.io/<ver>/... (no /release/ prefix). Upstream
# stays primary so non-RU clusters are unaffected. NOTE: -4 hard-pins IPv4 —
# deliberate (IPv4-baseline targets): --connect-timeout bounds connect-phase
# hangs but not a blackholed post-connect handshake; the tradeoff is that
# IPv6-only egress loses both hosts.
SA=/var/run/secrets/kubernetes.io/serviceaccount

# assert_variable exits if the given variable is not set.
function assert_variable () {
  if [ -z "$1" ];
  then
    echo "Error: variable $2 has not been set."
    exit 1
  fi
}

# Check required variables up front, BEFORE any first use: publish_ca (below)
# reads STEPPATH and OPENBAO_ADDR, and the idempotency check reads
# STEPISSUER_NAMESPACE — an unset variable there degrades to silent skips,
# not this loud exit.
assert_variable "$STEPISSUER_NAMESPACE" "STEPISSUER_NAMESPACE"
assert_variable "$STEPPATH" "STEPPATH"
assert_variable "$OPENBAO_ADDR" "OPENBAO_ADDR"

# Publish the public CA (root + intermediate) into the openbao KV store at
# apps/step-ca — the single path every consumer namespace syncs from via
# ExternalSecret (docs/sso-app-author-guide.md §4). Producer-push: openbao
# never reads from this namespace; it only admits this Job's ServiceAccount
# through the "step-certificates" kubernetes-auth role (provisioned by the
# openbao bootstrap Job, policy step-certificates-write-apps — write-only on
# that one KV path).
#
# Runs before the idempotency early-exit below so EVERY Job re-run publishes
# (ttlSecondsAfterFinished GC + the 10m Kustomization interval re-run this
# Job every ~10-20m); that loop is also the CA-rotation refresh path — the
# certs are read fresh from the PVC each time.
#
# Deliberately non-fatal on every failure path: this Job gates
# step-issuer -> casdoor -> openbao, so blocking on (or failing because of)
# openbao would deadlock a cold boot. If publication cannot proceed, warn and
# let the next re-run retry. Nothing alarms on a PERSISTENT failure (openbao
# itself consumes no part of the CA) — the signal is consumer-side: CA
# ExternalSecrets that never sync, TLS trust errors in consumer pods. When
# that shows up, grep this Job's log for "skipping openbao publication".
publish_ca() {
  local root_ca="${STEPPATH}/certs/root_ca.crt"
  local intermediate_ca="${STEPPATH}/certs/intermediate_ca.crt"
  local missing=()
  [ -s "$root_ca" ] || missing+=("$root_ca")
  [ -s "$intermediate_ca" ] || missing+=("$intermediate_ca")
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "WARNING: CA cert(s) missing/empty on the PVC: ${missing[*]}; skipping openbao publication." >&2
    return 0
  fi
  # sys/health answers with an HTTP status on ANY running openbao (sealed
  # included); a transport failure (code 000) means it is not deployed yet —
  # the normal state during a cold boot, when this Job runs long before
  # openbao exists.
  local health_code
  health_code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
    "$OPENBAO_ADDR/v1/sys/health" 2>/dev/null)" || health_code=000
  if [ "$health_code" = "000" ]; then
    echo "openbao not reachable at ${OPENBAO_ADDR} (not deployed yet); skipping CA publication — the next Job re-run retries."
    return 0
  fi
  local login_json token
  if ! login_json="$(curl -fsS --connect-timeout 5 --max-time 15 -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"role\":\"step-certificates\",\"jwt\":\"$(cat "$SA/token")\"}" \
      "$OPENBAO_ADDR/v1/auth/kubernetes/login")"; then
    echo "WARNING: openbao kubernetes-auth login failed (sealed, or the step-certificates role is not provisioned yet); skipping CA publication — the next Job re-run retries." >&2
    return 0
  fi
  token="$(printf '%s' "$login_json" | sed -n 's/.*"client_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "$token" ]; then
    echo "WARNING: no client_token in the openbao login response; skipping CA publication." >&2
    return 0
  fi
  # PEM holds no quotes or backslashes — only the newlines need JSON escaping.
  if ! curl -fsS --connect-timeout 5 --max-time 30 -X PUT \
      -H "X-Vault-Token: ${token}" -H 'Content-Type: application/json' \
      -d "{\"data\":{\"root_ca.crt\":\"$(awk '{printf "%s\\n", $0}' "$root_ca")\",\"intermediate_ca.crt\":\"$(awk '{printf "%s\\n", $0}' "$intermediate_ca")\"}}" \
      "$OPENBAO_ADDR/v1/apps/data/step-ca" >/dev/null; then
    echo "WARNING: openbao KV put apps/step-ca failed; skipping CA publication — the next Job re-run retries." >&2
    return 0
  fi
  echo "LibrePod CA published to openbao KV at apps/step-ca."
}
publish_ca

# Cheap idempotency BEFORE any download, via the raw API: with
# ttlSecondsAfterFinished (job.yaml), Flux recreates this Job after every TTL
# GC — this check makes those re-runs ~free instead of re-fetching the ~60MB
# kubectl through the same flaky egress (previously EVERY ~10m cycle!). To
# re-provision (e.g. after a CA re-init): delete the Job AND these
# ConfigMaps/Secrets, then reconcile.
if curl -fsS --cacert "$SA/ca.crt" -H "Authorization: Bearer $(cat "$SA/token")" \
  "https://kubernetes.default.svc/api/v1/namespaces/${STEPISSUER_NAMESPACE}/configmaps/step-certificates-certs" >/dev/null 2>&1; then
  echo "ConfigMap step-certificates-certs already exists; nothing to do."
  exit 0
fi

if ! command -v kubectl &> /dev/null; then
  echo -e "\e[1mDownloading kubectl...\e[0m"
  VER_JSON="$(curl -fsS --connect-timeout 5 --max-time 15 --cacert "$SA/ca.crt" \
    -H "Authorization: Bearer $(cat "$SA/token")" \
    https://kubernetes.default.svc/version)"
  # Keep any prerelease suffix (v1.37.1-rc.0+k3s1 -> 1.37.1-rc.0): dl.k8s.io
  # publishes rc binaries; the mirror does not (the ladder falls through to
  # dl.k8s.io for those). Stripping to GA 404'd on prerelease channels whose
  # X.Y.Z had no GA yet.
  KUBECTL_VERSION="$(echo "$VER_JSON" | sed -n 's/.*"gitVersion": *"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\(-[A-Za-z0-9.]*\)\?\).*/\1/p' | head -n1)"
  if [ -z "$KUBECTL_VERSION" ]; then
    echo "Error: could not parse server version from /version: ${VER_JSON}"
    exit 1
  fi
  echo "Cluster is v${KUBECTL_VERSION}; downloading matching kubectl..."
  cd /tmp
  UP="https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
  MI="https://mirror.yandex.ru/mirrors/dl.k8s.io/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
  # Interleaved upstream/mirror ladder (the working mirror is reached on
  # attempt 2 under the RU upstream failure). Stall detection instead of a
  # total cap: the old --max-time 300 hard-failed the ~60MB binary on any
  # link slower than ~200 KiB/s; --speed-limit/--speed-time aborts only
  # transfers that stay under 10 KiB/s for 30s, so slow-but-alive links run
  # until the Job's activeDeadlineSeconds bound.
  n=0
  DL_OK=0
  for u in "$UP" "$MI" "$UP" "$MI"; do
    n=$((n + 1))
    if [ "$n" -gt 1 ]; then sleep $((n - 1)); fi
    if ! curl -4 --fail --connect-timeout 10 --speed-limit 10240 --speed-time 30 -o kubectl "$u"; then
      echo "Download from ${u} failed (attempt ${n}/4)"
      continue
    fi
    if ! command -v sha256sum &> /dev/null; then
      echo "WARNING: sha256sum not available in this image; accepting unverified kubectl from ${u}" >&2
      DL_OK=1
      break
    fi
    # Verify against the .sha256 published by the OTHER host — a checksum from
    # the serving host cannot detect that host serving a corrupt binary.
    # Same-host fallback covers rc tags (the mirror 404s those); if no
    # checksum is reachable at all, warn and accept rather than hard-fail the
    # bootstrap on a flaky checksum fetch.
    case "$u" in
      https://dl.k8s.io/*) S="${MI}" ;;
      *) S="${UP}" ;;
    esac
    if curl -fsS --connect-timeout 10 --max-time 60 -o kubectl.sha256 "${S}.sha256" \
      || curl -fsS --connect-timeout 10 --max-time 60 -o kubectl.sha256 "${u}.sha256"; then
      SUM="$(set -- $(cat kubectl.sha256); echo "${1:-}")"
      if [ -n "$SUM" ] && echo "${SUM}  kubectl" | sha256sum -c - >/dev/null 2>&1; then
        DL_OK=1
        break
      fi
      echo "checksum mismatch for ${u} (attempt ${n}/4)"
    else
      echo "WARNING: no .sha256 reachable for ${u}; accepting unverified kubectl" >&2
      DL_OK=1
      break
    fi
  done
  if [ "$DL_OK" != 1 ]; then
    echo "Error: failed to download kubectl from any mirror."
    exit 1
  fi
  chmod +x kubectl
  export PATH=/tmp:$PATH
  cd -
  echo "kubectl downloaded successfully."
fi

# Define paths
CA_CONFIG_DIR="${STEPPATH}/config"
CA_CERTS_DIR="${STEPPATH}/certs"
CA_SECRETS_DIR="${STEPPATH}/secrets"
CA_PASSWORD_FILE="${CA_SECRETS_DIR}/passwords/password"
CA_PROVISIONER_PASSWORD_FILE="${CA_SECRETS_DIR}/certificate-issuer/password"

echo -e "\e[1mChecking CA initialization...\e[0m"

# Verify the CA is initialized by checking for required files
REQUIRED_FILES=(
  "${CA_CONFIG_DIR}/ca.json"
  "${CA_CONFIG_DIR}/defaults.json"
  "${CA_CERTS_DIR}/root_ca.crt"
  "${CA_CERTS_DIR}/intermediate_ca.crt"
  "${CA_PASSWORD_FILE}"
)

for file in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "Error: Required file not found at $file"
    echo "The Step CA must be initialized before bootstrapping resources."
    exit 1
  fi
done

# Check for private keys
if [ ! -f "${CA_SECRETS_DIR}/root_ca_key" ] && [ ! -f "${CA_SECRETS_DIR}/intermediate_ca_key" ]; then
  echo "Warning: No CA private keys found in ${CA_SECRETS_DIR}"
fi

echo -e "\e[1mCreating ConfigMap: step-certificates-config...\e[0m"

# Create ConfigMap for config files (ca.json and defaults.json)
kubectl create configmap step-certificates-config \
  --from-file=ca.json="${CA_CONFIG_DIR}/ca.json" \
  --from-file=defaults.json="${CA_CONFIG_DIR}/defaults.json" \
  --namespace="$STEPISSUER_NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "ConfigMap step-certificates-config created/updated."

echo -e "\e[1mCreating ConfigMap: step-certificates-certs...\e[0m"

# Create ConfigMap for certificates (root_ca.crt and intermediate_ca.crt).
# This CM is the local source of truth for step-issuer and the root-ca-server
# sidecar (both consume it in this namespace). Cross-namespace distribution
# is also this Job's doing: publish_ca (top of this script) pushes the same
# certs into the openbao KV store at apps/step-ca, which consumer namespaces
# sync via ExternalSecret.
kubectl create configmap step-certificates-certs \
  --from-file=root_ca.crt="${CA_CERTS_DIR}/root_ca.crt" \
  --from-file=intermediate_ca.crt="${CA_CERTS_DIR}/intermediate_ca.crt" \
  --namespace="$STEPISSUER_NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "ConfigMap step-certificates-certs created/updated."

echo -e "\e[1mReading CA password...\e[0m"

# Read the CA password
CA_PASSWORD=$(cat "$CA_PASSWORD_FILE")

echo -e "\e[1mCreating Secret: step-certificates-ca-password...\e[0m"

# Create Secret for CA password
kubectl create secret generic step-certificates-ca-password \
  --from-literal=password="$CA_PASSWORD" \
  --namespace="$STEPISSUER_NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret step-certificates-ca-password created/updated."

echo -e "\e[1mCreating Secret: step-certificates-secrets...\e[0m"

# Create Secret for private keys (if they exist)
SECRET_ARGS=()
if [ -f "${CA_SECRETS_DIR}/root_ca_key" ]; then
  SECRET_ARGS+=("--from-file=root_ca_key=${CA_SECRETS_DIR}/root_ca_key")
fi
if [ -f "${CA_SECRETS_DIR}/intermediate_ca_key" ]; then
  SECRET_ARGS+=("--from-file=intermediate_ca_key=${CA_SECRETS_DIR}/intermediate_ca_key")
fi

if [ ${#SECRET_ARGS[@]} -gt 0 ]; then
  kubectl create secret generic step-certificates-secrets \
    "${SECRET_ARGS[@]}" \
    --namespace="$STEPISSUER_NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "Secret step-certificates-secrets created/updated."
else
  echo "Warning: No private keys found, skipping step-certificates-secrets creation."
fi

echo -e "\e[1mCreating Secret: step-certificates-certificate-issuer-password...\e[0m"

# Create Secret for certificate-issuer password (same as CA password)
kubectl create secret generic step-certificates-certificate-issuer-password \
  --from-literal=password="$CA_PASSWORD" \
  --namespace="$STEPISSUER_NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret step-certificates-certificate-issuer-password created/updated."

echo -e "\e[1mReading provisioner password...\e[0m"

# Read the provisioner password (JWK provisioner key is encrypted with this)
CA_PROVISIONER_PASSWORD=$(cat "$CA_PROVISIONER_PASSWORD_FILE")

echo -e "\e[1mCreating Secret: step-certificates-provisioner-password...\e[0m"

# Create Secret for provisioner password
kubectl create secret generic step-certificates-provisioner-password \
  --from-literal=password="$CA_PROVISIONER_PASSWORD" \
  --namespace="$STEPISSUER_NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret step-certificates-provisioner-password created/updated."

echo
echo -e "\e[1mStep CA resource bootstrap complete!\e[0m"
echo
echo "Created resources in namespace: $STEPISSUER_NAMESPACE"
echo "  - ConfigMap: step-certificates-config"
echo "  - ConfigMap: step-certificates-certs"
echo "  - Secret: step-certificates-ca-password"
echo "  - Secret: step-certificates-secrets"
echo "  - Secret: step-certificates-certificate-issuer-password"
echo "  - Secret: step-certificates-provisioner-password"
echo
