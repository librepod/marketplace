#!/bin/bash

# Creates the StepClusterIssuer for cert-manager integration.
#
# Runs as an initContainer on every step-issuer pod (re)start. All runtime
# inputs come from the step-certificates-provisioner-password Secret
# (password + kid + caBundle), created by the step-certificates bootstrap
# Job — this app deliberately has no other coupling to step-certificates:
# no PVC mount, no ConfigMaps, and no openbao dependency (step-issuer
# readiness gates cert-manager -> the wildcard cert -> openbao's ingress,
# so sourcing anything here from openbao could deadlock a cold boot).
#
# This init is also the StepClusterIssuer's reconciler: on CA rotation the
# step-certificates Job patches the Secret and restarts this Deployment,
# and the run below patches the issuer spec (kid/caBundle) to match — no
# manual re-provisioning exists or is needed.
#
# All Kubernetes calls are plain curl with the ServiceAccount token: the
# step-ca image ships curl+jq but no kubectl, and downloading one at
# runtime is ~60MB through the flaky egress this script avoids.

set -e

echo "Welcome to StepClusterIssuer bootstrapper."

SA=/var/run/secrets/kubernetes.io/serviceaccount
K8S_API=https://kubernetes.default.svc
# StepClusterIssuer is a CLUSTER-SCOPED resource: the API path has no
# /namespaces/{ns} segment (the earlier namespaced path 404s on GET and
# POST alike — caught on the dev drill).
CRS=/apis/certmanager.step.sm/v1beta1/stepclusterissuers

# assert_variable exits if the given variable is not set.
function assert_variable () {
  if [ -z "$1" ];
  then
    echo "Error: variable $2 has not been set."
    exit 1
  fi
}

assert_variable "$STEPISSUER_NAMESPACE" "STEPISSUER_NAMESPACE"
assert_variable "$STEP_ISSUER_URL" "STEP_ISSUER_URL"
assert_variable "$PROVISIONER_NAME" "PROVISIONER_NAME"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found in the container image."
  exit 1
fi

# k8s_api METHOD PATH [JSON] — Kubernetes API call with the ServiceAccount
# token; non-2xx fails the curl (--fail, caught by set -e or the caller's if).
# PATCH uses merge-patch: StepClusterIssuer is a CRD (no strategic-merge
# support), and the Deployment/Secret shapes we patch tolerate merge-patch.
k8s_api () {
  local args=(
    -fsS --cacert "$SA/ca.crt"
    -H "Authorization: Bearer $(cat "$SA/token")"
    -X "$1"
  )
  if [ "$1" = PATCH ]; then
    args+=(-H 'Content-Type: application/merge-patch+json' --data "$3")
  elif [ -n "${3:-}" ]; then
    args+=(-H 'Content-Type: application/json' --data "$3")
  fi
  curl "${args[@]}" "$K8S_API$2"
}

# Fetch the issuer up front; the decision create-vs-patch-vs-nothing is
# made AFTER the Secret is read (the spec must track the Secret's kid and
# caBundle — they change when the CA is re-initialized, and the controller
# never re-reads a changed kid on its own; this init is the reconciler).
existing_issuer="$(k8s_api GET "${CRS}/step-cluster-issuer" 2>/dev/null || true)"

echo "Waiting for step-certificates-provisioner-password Secret..."
SECRET_JSON=""
for i in $(seq 1 30); do
  if SECRET_JSON="$(k8s_api GET "/api/v1/namespaces/${STEPISSUER_NAMESPACE}/secrets/step-certificates-provisioner-password" 2>/dev/null)"; then
    break
  fi
  SECRET_JSON=""
  echo "Waiting... ($i/30)"
  sleep 2
done
if [ -z "$SECRET_JSON" ]; then
  echo "Error: Timeout waiting for step-certificates-provisioner-password Secret"
  exit 1
fi

# Secret data values are base64-encoded in .data.
PROVISIONER_KID="$(printf '%s' "$SECRET_JSON" | jq -r '.data.kid // "" | @base64d')"
CA_BUNDLE="$(printf '%s' "$SECRET_JSON" | jq -r '.data.ca_bundle // "" | @base64d')"
if [ -z "$PROVISIONER_KID" ]; then
  echo "Error: no kid in step-certificates-provisioner-password (stale Secret from an older bootstrap?)"
  exit 1
fi
if [ -z "$CA_BUNDLE" ]; then
  echo "Error: no ca_bundle in step-certificates-provisioner-password (stale Secret from an older bootstrap?)"
  exit 1
fi

echo "Provisioner kid: ${PROVISIONER_KID}"

manifest="$(jq -n \
  --arg ns "$STEPISSUER_NAMESPACE" \
  --arg url "$STEP_ISSUER_URL" \
  --arg name "$PROVISIONER_NAME" \
  --arg kid "$PROVISIONER_KID" \
  --arg ca_bundle "$CA_BUNDLE" \
  '{apiVersion: "certmanager.step.sm/v1beta1", kind: "StepClusterIssuer",
    metadata: {name: "step-cluster-issuer"},
    spec: {url: $url, caBundle: $ca_bundle,
           provisioner: {name: $name, kid: $kid,
                         passwordRef: {name: "step-certificates-provisioner-password",
                                       namespace: $ns, key: "password"}}}}')"

if [ -n "$existing_issuer" ]; then
  cur_kid="$(printf '%s' "$existing_issuer" | jq -r '.spec.provisioner.kid // ""')"
  cur_bundle="$(printf '%s' "$existing_issuer" | jq -r '.spec.caBundle // ""')"
  if [ "$cur_kid" = "$PROVISIONER_KID" ] && [ "$cur_bundle" = "$CA_BUNDLE" ]; then
    echo "StepClusterIssuer step-cluster-issuer is up to date with the Secret; nothing to do."
    exit 0
  fi
  echo "StepClusterIssuer does not match the provisioner Secret (CA rotation?); patching..."
  k8s_api PATCH "${CRS}/step-cluster-issuer" \
    "$(jq -n --arg url "$STEP_ISSUER_URL" --arg kid "$PROVISIONER_KID" --arg ca_bundle "$CA_BUNDLE" \
      '{spec: {url: $url, caBundle: $ca_bundle, provisioner: {kid: $kid}}}')" >/dev/null
  echo "StepClusterIssuer patched — the controller re-verifies against the new CA."
  exit 0
fi

echo "Creating StepClusterIssuer..."
k8s_api POST "$CRS" "$manifest" >/dev/null

echo "StepClusterIssuer created."
echo "You can now use this issuer to issue certificates with cert-manager."
