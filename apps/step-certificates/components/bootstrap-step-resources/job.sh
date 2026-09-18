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

# assert_variable exists if the given variable is not set.
function assert_variable () {
  if [ -z "$1" ];
  then
    echo "Error: variable $2 has not been set."
    exit 1
  fi
}

# check required variables
assert_variable "$STEPISSUER_NAMESPACE" "STEPISSUER_NAMESPACE"
assert_variable "$STEPPATH" "STEPPATH"

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
# Data AND the Reflector annotation go in a SINGLE apply: consumer namespaces
# hold empty stub CMs annotated `reflects: step-ca/step-certificates-certs`
# that Reflector populates from this source. With the old create-then-annotate
# two-step, Reflector could observe the CM mid-transition (empty or
# unannotated) and never re-sync, leaving consumer pods FailedMount on a
# missing root_ca.crt key until the Reflector pod was restarted. One atomic
# annotated+filled creation means Reflector only ever sees the final state.
# See https://github.com/emberstack/kubernetes-reflector
kubectl create configmap step-certificates-certs \
  --from-file=root_ca.crt="${CA_CERTS_DIR}/root_ca.crt" \
  --from-file=intermediate_ca.crt="${CA_CERTS_DIR}/intermediate_ca.crt" \
  --namespace="$STEPISSUER_NAMESPACE" \
  --dry-run=client -o yaml \
| kubectl patch --local --type merge -f - \
    -p '{"metadata":{"annotations":{"reflector.v1.k8s.emberstack.com/reflection-allowed":"true"}}}' \
    -o yaml \
| kubectl apply -f -

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
