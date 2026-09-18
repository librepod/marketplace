#!/bin/bash

# This script bootstraps the StepClusterIssuer for cert-manager integration.
# It extracts the CA certificate and provisioner details from the Step CA PVC data.

set -e

echo "Welcome to StepClusterIssuer bootstrapper."

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

# Cheap idempotency BEFORE any download, via the raw API: this script runs as
# an initContainer, i.e. on EVERY step-issuer pod (re)start — skipping the
# ~60MB fetch when the issuer already exists keeps restarts fast through the
# same flaky egress the ladder below works around. To re-provision: delete the
# StepClusterIssuer, then restart the step-issuer Deployment.
if curl -fsS --cacert "$SA/ca.crt" -H "Authorization: Bearer $(cat "$SA/token")" \
  "https://kubernetes.default.svc/apis/certmanager.step.sm/v1beta1/stepclusterissuers/step-cluster-issuer" >/dev/null 2>&1; then
  echo "StepClusterIssuer step-cluster-issuer already exists; nothing to do."
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
  # until the pod-level deadline bound.
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
assert_variable "$STEP_ISSUER_URL" "STEP_ISSUER_URL"
assert_variable "$PROVISIONER_NAME" "PROVISIONER_NAME"

# Define paths
CA_CONFIG_DIR="${STEPPATH}/config"
CA_CERTS_DIR="${STEPPATH}/certs"

echo -e "\e[1mChecking CA initialization...\e[0m"

# Verify the CA is initialized by checking for required files
REQUIRED_FILES=(
  "${CA_CONFIG_DIR}/ca.json"
  "${CA_CERTS_DIR}/root_ca.crt"
)

for file in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "Error: Required file not found at $file"
    echo "The Step CA must be initialized before bootstrapping the StepClusterIssuer."
    exit 1
  fi
done

echo -e "\e[1mWaiting for provisioner password Secret...\e[0m"

# Wait for the provisioner password Secret to exist (created by bootstrap-step-resources)
# kubectl wait doesn't work well with secrets, so we poll instead
SECRET_FOUND=false
for i in {1..30}; do
  if kubectl get secret "step-certificates-provisioner-password" --namespace="$STEPISSUER_NAMESPACE" &>/dev/null; then
    echo "Secret step-certificates-provisioner-password found."
    SECRET_FOUND=true
    break
  fi
  echo "Waiting for Secret... ($i/30)"
  sleep 2
done

if [ "$SECRET_FOUND" = false ]; then
  echo "Error: Timeout waiting for step-certificates-provisioner-password Secret"
  exit 1
fi

echo -e "\e[1mExtracting CA certificate...\e[0m"

# Read and base64-encode the root CA certificate
CA_BUNDLE=$(base64 -w 0 "${CA_CERTS_DIR}/root_ca.crt")

echo "CA certificate extracted and encoded."

echo -e "\e[1mExtracting provisioner kid from ca.json...\e[0m"

# Extract the JWK provisioner's kid from ca.json
# Note: The kid is nested inside key.kid, and type may be "JWK" (uppercase)
PROVISIONER_KID=$(jq -r '.authority.provisioners[] | select(.type=="JWK" or .type=="jwk") | select(.name=="'"$PROVISIONER_NAME"'") | .key.kid' "${CA_CONFIG_DIR}/ca.json")

if [ -z "$PROVISIONER_KID" ]; then
  echo "Error: Could not extract kid for provisioner '$PROVISIONER_NAME' from ca.json"
  exit 1
fi

echo "Provisioner kid extracted: $PROVISIONER_KID"

echo -e "\e[1mCreating StepClusterIssuer manifest...\e[0m"

# Generate the StepClusterIssuer manifest
STEP_CLUSTER_ISSUERManifest=$(cat <<EOF
---
apiVersion: certmanager.step.sm/v1beta1
kind: StepClusterIssuer
metadata:
  name: step-cluster-issuer
  namespace: ${STEPISSUER_NAMESPACE}
spec:
  url: ${STEP_ISSUER_URL}
  caBundle: ${CA_BUNDLE}
  provisioner:
    name: ${PROVISIONER_NAME}
    kid: ${PROVISIONER_KID}
    passwordRef:
      name: step-certificates-provisioner-password
      namespace: ${STEPISSUER_NAMESPACE}
      key: password
EOF
)

echo "StepClusterIssuer manifest generated."

echo -e "\e[1mApplying StepClusterIssuer...\e[0m"

# Apply the StepClusterIssuer manifest
echo "$STEP_CLUSTER_ISSUERManifest" | kubectl apply -f -

echo "StepClusterIssuer applied successfully."

echo
echo -e "\e[1mStepClusterIssuer bootstrap complete!\e[0m"
echo
echo "Created resource:"
echo "  - StepClusterIssuer: step-cluster-issuer (in namespace: $STEPISSUER_NAMESPACE)"
echo
echo "You can now use this issuer to issue certificates with cert-manager."
echo
