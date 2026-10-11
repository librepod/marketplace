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
#   3. delete the ConfigMaps/Secrets the pre-openbao bootstrap maintained
#      (stale on upgraded clusters; see the cleanup loop below).
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
  if [ "$1" = PATCH ]; then
    args+=(-H 'Content-Type: application/strategic-merge-patch+json' --data "$3")
  elif [ -n "${3:-}" ]; then
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
  # The rest of the full-backup file set — must stay in sync with the set
  # the initContainer's restore requires. A partial backup is never PUT:
  # the restore side would reject it and mint a fresh root CA, the exact
  # disaster the backup exists to prevent, so verify loudly here instead.
  local backup_files=(
    "${STEPPATH}/config/ca.json"
    "${STEPPATH}/config/defaults.json"
    "${STEPPATH}/secrets/passwords/password"
    "${STEPPATH}/secrets/certificate-issuer/password"
    "${STEPPATH}/secrets/root_ca_key"
    "${STEPPATH}/secrets/intermediate_ca_key"
  )
  if [ ! -s "$root_ca" ] || [ ! -s "$intermediate_ca" ]; then
    echo "WARNING: CA certs missing/empty on the PVC; skipping openbao publication." >&2
    return 0
  fi
  local f backup_ready=true
  for f in "${backup_files[@]}"; do
    if [ ! -s "$f" ]; then
      echo "WARNING: CA backup incomplete — ${f} missing/empty on the PVC; skipping the system/step-ca backup PUT. The next Job re-run retries." >&2
      backup_ready=false
    fi
  done
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
        --rawfile root "$root_ca" \
        --rawfile intermediate "$intermediate_ca" \
        '{data: {"root_ca.crt": $root, "intermediate_ca.crt": $intermediate}}')" \
      "$OPENBAO_ADDR/v1/apps/data/step-ca" >/dev/null; then
    echo "Public CA published to openbao KV at apps/step-ca."
  else
    echo "WARNING: openbao KV put apps/step-ca failed; the next Job re-run retries." >&2
    published=false
  fi
  # Full CA backup for restore-on-empty-PVC. The file set was verified
  # complete above, so this always PUTs all eight keys — KV writes are
  # atomic per version, and the restore side never sees a partial backup.
  # ponytail: plaintext HTTP — openbao deliberately serves in-cluster HTTP
  # only (apps/openbao has no TLS listener; every consumer — ESO, this Job —
  # rides that pattern). Closing this hop means re-architecting openbao TLS
  # cluster-wide, not just this PUT.
  if [ "$backup_ready" = true ] && curl -fsS --connect-timeout 5 --max-time 30 -X PUT \
      -H "X-Vault-Token: ${token}" -H 'Content-Type: application/json' \
      --data "$(jq -n \
        --rawfile root "$root_ca" \
        --rawfile intermediate "$intermediate_ca" \
        --rawfile ca_json "${STEPPATH}/config/ca.json" \
        --rawfile defaults_json "${STEPPATH}/config/defaults.json" \
        --rawfile ca_password "${STEPPATH}/secrets/passwords/password" \
        --rawfile provisioner_password "${STEPPATH}/secrets/certificate-issuer/password" \
        --rawfile root_key "${STEPPATH}/secrets/root_ca_key" \
        --rawfile intermediate_key "${STEPPATH}/secrets/intermediate_ca_key" \
        '{data: {
            "root_ca.crt": $root,
            "intermediate_ca.crt": $intermediate,
            "ca.json": $ca_json,
            "defaults.json": $defaults_json,
            "ca_password": $ca_password,
            "provisioner_password": $provisioner_password,
            "root_ca_key": $root_key,
            "intermediate_ca_key": $intermediate_key
          }}')" \
      "$OPENBAO_ADDR/v1/system/data/step-ca" >/dev/null; then
    echo "CA backup written to openbao KV at system/step-ca."
  else
    echo "WARNING: openbao KV put system/step-ca failed; the next Job re-run retries." >&2
    published=false
  fi
  [ "$published" = true ] || echo "WARNING: openbao publication incomplete this run — see above; next re-run retries." >&2
}
publish_ca

# Delete the objects the pre-openbao bootstrap Job maintained. They carry no
# ownerRef, so on an upgraded cluster they would linger in etcd forever —
# including Secret step-certificates-secrets, whose CA private keys this
# change moved to openbao system/ precisely to keep out of etcd. DELETEs
# are idempotent (404 = already gone). step-certificates-provisioner-
# password is NOT here: the steps below still maintain it.
for obj in step-certificates-config step-certificates-certs; do
  k8s_api DELETE "/api/v1/namespaces/${STEPISSUER_NAMESPACE}/configmaps/${obj}" >/dev/null 2>&1 \
    && echo "Deleted stale ConfigMap ${obj} (pre-openbao bootstrap artifact)." || true
done
for obj in step-certificates-ca-password step-certificates-secrets step-certificates-certificate-issuer-password; do
  k8s_api DELETE "/api/v1/namespaces/${STEPISSUER_NAMESPACE}/secrets/${obj}" >/dev/null 2>&1 \
    && echo "Deleted stale Secret ${obj} (pre-openbao bootstrap artifact)." || true
done

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
# "JWK" (uppercase) or "jwk". `// empty` matters: bare jq -r prints the
# literal string "null" for an absent kid, which would pass the -z guard
# below and poison the Secret with kid="null".
PROVISIONER_KID="$(jq -r --arg name "$PROVISIONER_NAME" \
  '.authority.provisioners[] | select(.type=="JWK" or .type=="jwk") | select(.name==$name) | .key.kid // empty' \
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
  k8s_api PATCH "$SECRET_API" "$secret_json" >/dev/null
  echo "Secret ${SECRET_NAME} patched."
else
  echo "Creating Secret ${SECRET_NAME}..."
  k8s_api POST "/api/v1/namespaces/${STEPISSUER_NAMESPACE}/secrets" "$secret_json" >/dev/null
  echo "Secret ${SECRET_NAME} created."
fi
echo
echo "Step CA resource bootstrap complete!"
echo "Consumers:"
echo "  - openbao KV apps/step-ca  (public certs for ESO consumer namespaces)"
echo "  - openbao KV system/step-ca  (full CA backup: certs, keys, config, passwords)"
echo "  - Secret ${SECRET_NAME} in ${STEPISSUER_NAMESPACE} (step-issuer StepClusterIssuer input)"
