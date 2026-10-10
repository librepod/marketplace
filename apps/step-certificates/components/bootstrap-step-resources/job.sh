#!/bin/bash

# Bootstraps the Step CA consumers once the CA server is healthy:
#
#   1. publish_ca — push the CA into the openbao KV store, two paths:
#      apps/step-ca  — public root + intermediate certs (what consumer
#                      namespaces sync via ExternalSecret,
#                      docs/sso-app-author-guide.md §4)
#      system/step-ca — full CA backup (certs, private keys, ca.json/
#                      defaults.json, both passwords). The initContainer
#                      restores from this copy when the PVC turns up empty,
#                      so a wiped PVC does not silently rotate the device's
#                      root CA. Separate engine from apps/: eso-read-apps
#                      reads apps/* only, so regular apps cannot reach the
#                      private keys.
#
#   2. ensure the step-certificates-provisioner-password Secret in this
#      namespace, carrying the provisioner password plus the kid and
#      caBundle that step-issuer's bootstrap needs. This must stay a plain
#      local Secret (NOT an ExternalSecret): step-issuer readiness gates
#      cert-manager -> the wildcard cert -> openbao's ingress, so sourcing
#      it from openbao could deadlock a cold boot. Producer-push only.
#
# All Kubernetes/openbao calls are plain curl with this Job's ServiceAccount
# token: the step-ca image ships curl+jq but no kubectl, and downloading one
# at runtime is ~60MB through the flaky egress this script avoids.

set -e

echo "Welcome to Step CA resource bootstrapper."

SA=/var/run/secrets/kubernetes.io/serviceaccount
K8S_API=https://kubernetes.default.svc

# assert_variable exits if the given variable is not set.
function assert_variable () {
  if [ -z "$1" ];
  then
    echo "Error: variable $2 has not been set."
    exit 1
  fi
}

# Check required variables up front: an unset one degrades to silent skips
# in the steps below, not a loud exit.
assert_variable "$STEPISSUER_NAMESPACE" "STEPISSUER_NAMESPACE"
assert_variable "$STEPPATH" "STEPPATH"
assert_variable "$OPENBAO_ADDR" "OPENBAO_ADDR"
assert_variable "$PROVISIONER_NAME" "PROVISIONER_NAME"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found in the container image."
  exit 1
fi

# k8s_api METHOD PATH [JSON] — Kubernetes API call with the ServiceAccount
# token; non-2xx fails the curl (--fail, caught by set -e or the caller's if).
k8s_api () {
  local args=(
    -fsS --cacert "$SA/ca.crt"
    -H "Authorization: Bearer $(cat "$SA/token")"
    -X "$1"
  )
  if [ -n "${3:-}" ]; then
    args+=(-H 'Content-Type: application/json' --data "$3")
  fi
  curl "${args[@]}" "$K8S_API$2"
}

# Publish the CA material into the openbao KV store at apps/step-ca.
#
# Deliberately non-fatal on every failure path: this Job gates
# step-issuer -> casdoor -> openbao, so blocking on (or failing because of)
# openbao would deadlock a cold boot. If publication cannot proceed, warn
# and let the next re-run retry. Nothing alarms on a PERSISTENT failure —
# the signal is consumer-side: CA ExternalSecrets that never sync, TLS
# trust errors in consumer pods. When that shows up, grep this Job's log
# for "skipping openbao publication".
#
# The Job is TTL-GC'd (ttlSecondsAfterFinished) and Flux recreates it on
# every ~10m reconcile; that re-run loop is also the CA-rotation refresh
# path — everything is read fresh from the PVC each time.
publish_ca () {
  local root_ca="${STEPPATH}/certs/root_ca.crt"
  local intermediate_ca="${STEPPATH}/certs/intermediate_ca.crt"
  if [ ! -s "$root_ca" ] || [ ! -s "$intermediate_ca" ]; then
    echo "WARNING: CA certs missing/empty on the PVC; skipping openbao publication." >&2
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
  token="$(printf '%s' "$login_json" | jq -r '.auth.client_token // empty')"
  if [ -z "$token" ]; then
    echo "WARNING: no client_token in the openbao login response; skipping CA publication." >&2
    return 0
  fi
  local published=true
  # Public certs for consumer namespaces.
  if curl -fsS --connect-timeout 5 --max-time 30 -X PUT \
      -H "X-Vault-Token: ${token}" -H 'Content-Type: application/json' \
      --data "$(jq -n \
        --rawfile root "$( [ -s "$root_ca" ] && echo "$root_ca" || echo /dev/null )" \
        --rawfile intermediate "$( [ -s "$intermediate_ca" ] && echo "$intermediate_ca" || echo /dev/null )" \
        '{data: {"root_ca.crt": $root, "intermediate_ca.crt": $intermediate}
         } | .data |= with_entries(select(.value != ""))')" \
      "$OPENBAO_ADDR/v1/apps/data/step-ca" >/dev/null; then
    echo "Public CA published to openbao KV at apps/step-ca."
  else
    echo "WARNING: openbao KV put apps/step-ca failed; the next Job re-run retries." >&2
    published=false
  fi
  # Full CA backup for restore-on-empty-PVC. Files absent from the PVC are
  # passed as /dev/null (empty string) and dropped by the with_entries
  # filter; the restore side requires the complete set, so an incomplete
  # backup is simply never written half-way — the PUT is atomic per version.
  if curl -fsS --connect-timeout 5 --max-time 30 -X PUT \
      -H "X-Vault-Token: ${token}" -H 'Content-Type: application/json' \
      --data "$(jq -n \
        --rawfile root "$( [ -s "$root_ca" ] && echo "$root_ca" || echo /dev/null )" \
        --rawfile intermediate "$( [ -s "$intermediate_ca" ] && echo "$intermediate_ca" || echo /dev/null )" \
        --rawfile ca_json "$( [ -s "${STEPPATH}/config/ca.json" ] && echo "${STEPPATH}/config/ca.json" || echo /dev/null )" \
        --rawfile defaults_json "$( [ -s "${STEPPATH}/config/defaults.json" ] && echo "${STEPPATH}/config/defaults.json" || echo /dev/null )" \
        --rawfile ca_password "$( [ -s "${STEPPATH}/secrets/passwords/password" ] && echo "${STEPPATH}/secrets/passwords/password" || echo /dev/null )" \
        --rawfile provisioner_password "$( [ -s "${STEPPATH}/secrets/certificate-issuer/password" ] && echo "${STEPPATH}/secrets/certificate-issuer/password" || echo /dev/null )" \
        --rawfile root_key "$( [ -s "${STEPPATH}/secrets/root_ca_key" ] && echo "${STEPPATH}/secrets/root_ca_key" || echo /dev/null )" \
        --rawfile intermediate_key "$( [ -s "${STEPPATH}/secrets/intermediate_ca_key" ] && echo "${STEPPATH}/secrets/intermediate_ca_key" || echo /dev/null )" \
        '{data: {
            "root_ca.crt": $root,
            "intermediate_ca.crt": $intermediate,
            "ca.json": $ca_json,
            "defaults.json": $defaults_json,
            "ca_password": $ca_password,
            "provisioner_password": $provisioner_password,
            "root_ca_key": $root_key,
            "intermediate_ca_key": $intermediate_key
          }}
         | .data |= with_entries(select(.value != ""))')" \
      "$OPENBAO_ADDR/v1/system/data/step-ca" >/dev/null; then
    echo "CA backup written to openbao KV at system/step-ca."
  else
    echo "WARNING: openbao KV put system/step-ca failed; the next Job re-run retries." >&2
    published=false
  fi
  [ "$published" = true ] || echo "WARNING: openbao publication incomplete this run — see above; next re-run retries." >&2
}
publish_ca

# Ensure the provisioner-password Secret (password + kid + caBundle for
# step-issuer). If it exists WITH the kid/ca_bundle keys there is nothing to
# do — all three values are fixed at CA init. A Secret from an older
# bootstrap (password only, no kid/ca_bundle) is healed in place with a
# strategic-merge PATCH. To re-provision after a CA re-init: delete this
# Secret AND the StepClusterIssuer, then reconcile.
SECRET_NAME=step-certificates-provisioner-password
SECRET_API="/api/v1/namespaces/${STEPISSUER_NAMESPACE}/secrets/${SECRET_NAME}"
existing="$(k8s_api GET "$SECRET_API" 2>/dev/null || true)"
if [ -n "$existing" ] && printf '%s' "$existing" | jq -e '(.data.kid // "") != "" and (.data.ca_bundle // "") != ""' >/dev/null; then
  echo "Secret ${SECRET_NAME} already exists; nothing to do."
  exit 0
fi

CA_CONFIG="${STEPPATH}/config/ca.json"
ROOT_CA="${STEPPATH}/certs/root_ca.crt"
PROVISIONER_PASSWORD_FILE="${STEPPATH}/secrets/certificate-issuer/password"
for file in "$CA_CONFIG" "$ROOT_CA" "$PROVISIONER_PASSWORD_FILE"; do
  if [ ! -f "$file" ]; then
    echo "Error: Required file not found at $file"
    echo "The Step CA must be initialized before bootstrapping resources."
    exit 1
  fi
done

# The JWK provisioner's kid is nested inside key.kid in ca.json; type may be
# "JWK" (uppercase) or "jwk".
PROVISIONER_KID="$(jq -r --arg name "$PROVISIONER_NAME" \
  '.authority.provisioners[] | select(.type=="JWK" or .type=="jwk") | select(.name==$name) | .key.kid' \
  "$CA_CONFIG")"
if [ -z "$PROVISIONER_KID" ]; then
  echo "Error: Could not extract kid for provisioner '$PROVISIONER_NAME' from $CA_CONFIG"
  exit 1
fi

secret_json="$(jq -n \
  --arg ns "$STEPISSUER_NAMESPACE" \
  --arg password "$(cat "$PROVISIONER_PASSWORD_FILE")" \
  --arg kid "$PROVISIONER_KID" \
  --arg ca_bundle "$(base64 -w0 "$ROOT_CA")" \
  '{apiVersion: "v1", kind: "Secret",
    metadata: {name: "step-certificates-provisioner-password", namespace: $ns},
    stringData: {password: $password, kid: $kid, ca_bundle: $ca_bundle}}')"
if [ -n "$existing" ]; then
  echo "Secret ${SECRET_NAME} lacks kid/ca_bundle (old bootstrap format); patching..."
  curl -fsS --cacert "$SA/ca.crt" -H "Authorization: Bearer $(cat "$SA/token")" \
    -H 'Content-Type: application/strategic-merge-patch+json' -X PATCH \
    --data "$secret_json" "${K8S_API}${SECRET_API}" >/dev/null
  echo "Secret ${SECRET_NAME} patched."
else
  echo "Creating Secret ${SECRET_NAME}..."
  k8s_api POST "/api/v1/namespaces/${STEPISSUER_NAMESPACE}/secrets" "$secret_json" >/dev/null
  echo "Secret ${SECRET_NAME} created."
fi
echo
echo "Step CA resource bootstrap complete!"
echo "Consumers:"
echo "  - openbao KV apps/step-ca  (certs for ESO consumers + DR copy of keys/config/passwords)"
echo "  - Secret ${SECRET_NAME} in ${STEPISSUER_NAMESPACE} (step-issuer StepClusterIssuer input)"
