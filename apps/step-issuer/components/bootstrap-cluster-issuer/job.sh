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
# indefinitely. Every attempt is bounded (-4, --connect-timeout, --max-time)
# and falls back to the Yandex mirror, which serves the same binaries at
# /mirrors/dl.k8s.io/<ver>/... (no /release/ prefix). Upstream stays primary
# so non-RU clusters are unaffected.
if ! command -v kubectl &> /dev/null; then
  echo -e "\e[1mDownloading kubectl...\e[0m"
  SA=/var/run/secrets/kubernetes.io/serviceaccount
  VER_JSON="$(curl -fsS --connect-timeout 5 --max-time 15 --cacert "$SA/ca.crt" \
    -H "Authorization: Bearer $(cat "$SA/token")" \
    https://kubernetes.default.svc/version)"
  KUBECTL_VERSION="$(echo "$VER_JSON" | sed -n 's/.*"gitVersion": *"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n1)"
  if [ -z "$KUBECTL_VERSION" ]; then
    echo "Error: could not parse server version from /version: ${VER_JSON}"
    exit 1
  fi
  echo "Cluster is v${KUBECTL_VERSION}; downloading matching kubectl..."
  cd /tmp
  KUBECTL_URLS=(
    "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
    "https://mirror.yandex.ru/mirrors/dl.k8s.io/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
  )
  DL_OK=0
  for u in "${KUBECTL_URLS[@]}"; do
    # 50MB binary: --max-time 300 (the Yandex mirror measures ~1MB/s).
    if curl -4 --fail --connect-timeout 10 --max-time 300 --retry 2 -o kubectl "$u"; then
      DL_OK=1
      break
    fi
    echo "Download from ${u} failed; trying next mirror..."
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
