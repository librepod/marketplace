#!/bin/bash

# Step CA PVC-based init container script
# Initializes the CA on the PVC before the main container starts: restores
# it from the openbao backup when possible, otherwise runs a fresh
# `step ca init`.

echo "Welcome to Step Certificates initialization (initContainer mode)."

STEPPATH=/home/step

# assert_variable exists if the given variable is not set.
function assert_variable () {
  if [ -z "$1" ];
  then
    echo "Error: variable $2 has not been set."
    exit 1
  fi
}

# check required variables
assert_variable "$CA_URL" "CA_URL"
assert_variable "$CA_NAME" "CA_NAME"
assert_variable "$CA_DNS_1" "CA_DNS_1"
assert_variable "$CA_ADDRESS" "CA_ADDRESS"
assert_variable "$CA_DEFAULT_PROVISIONER" "CA_DEFAULT_PROVISIONER"

# check required tools
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found in the container image."
  echo "This is unexpected — jq should be present in the step-ca image."
  echo "Please report this issue or update the init container image."
  exit 1
fi

echo -e "\e[1mChecking PVC mount point...\e[0m"

# Verify the PVC is mounted
if [ ! -d "$STEPPATH" ]; then
  echo "Error: $STEPPATH directory does not exist. PVC may not be mounted."
  exit 1
fi

# Check if already initialized (don't overwrite existing CA)
if [ -f "$STEPPATH/config/ca.json" ]; then
  echo -e "\e[1mCA already initialized at $STEPPATH/config/ca.json\e[0m"
  echo "Skipping initialization. Existing CA will be used."
  exit 0
fi

# ---------------------------------------------------------------------------
# Restore-from-backup: the PVC has no CA. If this cluster's openbao holds a
# CA backup (KV system/step-ca, written by the bootstrap Job), restore it
# instead of minting a new CA — a wiped PVC must not silently rotate the
# device's root CA: end-user devices (browsers, phones) would lose trust
# with no recovery path for a non-technical owner.
#
# Fresh-init fallbacks:
#   · openbao not deployed here (its Service DNS does not resolve) — virgin
#     boot, no backup can exist. Zero added latency.
#   · backup path empty (404) — no backup was ever written.
#   · incomplete backup — the Job writes the payload atomically per KV
#     version, so this means garbage; don't wait for it to heal.
#   · retry deadline (5 min) exceeded — openbao deployed but not yet
#     usable (mid-bootstrap race on a rebuild); rotating after a loud
#     warning beats a permanently wedged CA.
# Transport-level failures (openbao booting, sealed, network) retry until
# the deadline: on a REBUILD (PVC wiped, openbao restarting) the backup is
# there and only needs openbao to come up.
# ---------------------------------------------------------------------------
SA=/var/run/secrets/kubernetes.io/serviceaccount
OPENBAO_ADDR="${OPENBAO_ADDR:-http://openbao.openbao.svc.cluster.local:8200}"

# kv_get BACKUP KEY — one field of the KV v2 read response, or "" if absent.
kv_get () {
  printf '%s' "$1" | jq -r --arg k "$2" '.data.data[$k] // empty'
}

restore_ca_from_backup () {
  local deadline=$((SECONDS + 300))
  local rc=0 login_json token body code backup
  while [ "$SECONDS" -lt "$deadline" ]; do
    login_json="$(curl -sS --connect-timeout 5 --max-time 15 -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"role\":\"step-ca-restore\",\"jwt\":\"$(cat "$SA/token")\"}" \
      "$OPENBAO_ADDR/v1/auth/kubernetes/login" 2>/dev/null)" || rc=$?
    if [ "$rc" -eq 6 ]; then
      echo "openbao is not deployed in this cluster (${OPENBAO_ADDR} does not resolve); no backup possible."
      return 1
    elif [ "$rc" -ne 0 ]; then
      echo "openbao login not ready yet (curl rc=${rc}); retrying..."; rc=0; sleep 10; continue
    fi
    token="$(printf '%s' "$login_json" | jq -r '.auth.client_token // empty')"
    if [ -z "$token" ]; then
      echo "no client_token in the openbao login response; retrying..."; sleep 10; continue
    fi
    # -w appends the HTTP status on its own line so a 404 (no backup) can be
    # told apart from a 403/503 (policy or boot problem — retry those).
    body="$(curl -sS --connect-timeout 5 --max-time 15 -w '\n%{http_code}' \
      -H "X-Vault-Token: ${token}" \
      "$OPENBAO_ADDR/v1/system/data/step-ca" 2>/dev/null)" || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "openbao backup read failed (curl rc=${rc}); retrying..."; rc=0; sleep 10; continue
    fi
    code="${body##*$'\n'}"
    backup="${body%$'\n'*}"
    if [ "$code" = "404" ]; then
      echo "No CA backup at system/step-ca in this openbao; proceeding with fresh init."
      return 1
    elif [ "$code" != "200" ]; then
      echo "openbao returned ${code} for the backup read; retrying..."; sleep 10; continue
    fi

    # Stage everything, verify completeness, then move into place — a
    # half-restored tree must never look initialized (ca.json moves last).
    local stage f complete=true
    stage="$(mktemp -d /tmp/restore.XXXXXX)"
    for f in root_ca.crt intermediate_ca.crt root_ca_key intermediate_ca_key \
             ca.json defaults.json ca_password provisioner_password; do
      kv_get "$backup" "$f" > "${stage}/$f"
      [ -s "${stage}/$f" ] || { echo "backup incomplete: ${f} missing/empty"; complete=false; }
    done
    if [ "$complete" != "true" ]; then
      rm -rf "$stage"
      echo "WARNING: backup at system/step-ca is incomplete; proceeding with fresh init." >&2
      return 1
    fi
    mkdir -p "$STEPPATH/certs" "$STEPPATH/config" \
             "$STEPPATH/secrets/passwords" "$STEPPATH/secrets/certificate-issuer"
    mv "${stage}/root_ca.crt" "${stage}/intermediate_ca.crt" "$STEPPATH/certs/"
    mv "${stage}/root_ca_key" "${stage}/intermediate_ca_key" "$STEPPATH/secrets/"
    # Password files carry no trailing newline originally (echo -n at init);
    # jq -r appends one — strip it or the decrypt password would change.
    printf '%s' "$(cat "${stage}/ca_password")" > "$STEPPATH/secrets/passwords/password"
    printf '%s' "$(cat "${stage}/provisioner_password")" > "$STEPPATH/secrets/certificate-issuer/password"
    mv "${stage}/defaults.json" "$STEPPATH/config/"
    mv "${stage}/ca.json" "$STEPPATH/config/"
    # password stage copies were consumed via cat above, not moved
    rm -rf "$stage"
    echo -e "\e[1mStep CA RESTORED from the openbao backup (system/step-ca).\e[0m"
    FINGERPRINT=$(step certificate fingerprint "$STEPPATH/certs/root_ca.crt")
    echo "CA Fingerprint: ${FINGERPRINT}"
    return 0
  done
  echo "WARNING: restore deadline (5 min) exceeded; falling back to a FRESH CA — device trust anchors will change." >&2
  return 1
}

if restore_ca_from_backup; then
  echo "Using the restored CA; skipping fresh initialization."
  exit 0
fi
echo -e "\e[1mNo backup restored; initializing a new Step CA...\e[0m"

# set certificate duration defaults (90 days)
CA_DEFAULT_TLS_DURATION="${CA_DEFAULT_TLS_DURATION:-2160h}"
CA_MAX_TLS_DURATION="${CA_MAX_TLS_DURATION:-${CA_DEFAULT_TLS_DURATION}}"

# generate password if necessary
CA_PASSWORD=${CA_PASSWORD:-$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 32 ; echo '')}
CA_PROVISIONER_PASSWORD=${CA_PROVISIONER_PASSWORD:-$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 32 ; echo '')}

# Setting this here on purpose, after the above section which explicitly checks
# for and handles exit errors.
set -e

TMP_CA_PASSWORD=$(mktemp /tmp/stepca.XXXXXX)
TMP_CA_PROVISIONER_PASSWORD=$(mktemp /tmp/stepca.XXXXXX)

echo $CA_PASSWORD > $TMP_CA_PASSWORD
echo $CA_PROVISIONER_PASSWORD > $TMP_CA_PROVISIONER_PASSWORD

step ca init \
  --name "$CA_NAME" \
  --dns "$CA_DNS_1" \
  --dns "$CA_DNS_2" \
  --dns "$CA_DNS_3" \
  --dns "$CA_DNS_4" \
  --deployment-type standalone \
  --address "$CA_ADDRESS" \
  --password-file "$TMP_CA_PASSWORD" \
  --provisioner "$CA_DEFAULT_PROVISIONER" \
  --provisioner-password-file "$TMP_CA_PROVISIONER_PASSWORD" \
  --with-ca-url "$CA_URL" \
  --no-db

rm -f $TMP_CA_PASSWORD $TMP_CA_PROVISIONER_PASSWORD

# Patch ca.json with extended certificate durations
echo -e "\e[1mPatching ca.json certificate durations...\e[0m"
TMP_CA_JSON=$(mktemp /tmp/ca.json.XXXXXX)
jq --arg default "$CA_DEFAULT_TLS_DURATION" --arg max "$CA_MAX_TLS_DURATION" \
  '.authority.claims.defaultTLSCertDuration = $default |
   .authority.claims.maxTLSCertDuration = $max' \
  "$STEPPATH/config/ca.json" > "$TMP_CA_JSON"
mv "$TMP_CA_JSON" "$STEPPATH/config/ca.json"
echo "Certificate duration set: default=${CA_DEFAULT_TLS_DURATION}, max=${CA_MAX_TLS_DURATION}"

# Write passwords to files for the main container to use
mkdir -p "$STEPPATH/secrets/passwords"
mkdir -p "$STEPPATH/secrets/certificate-issuer"
echo -n "$CA_PASSWORD" > "$STEPPATH/secrets/passwords/password"
echo -n "$CA_PROVISIONER_PASSWORD" > "$STEPPATH/secrets/certificate-issuer/password"

echo
echo -e "\e[1mStep Certificates initialized on PVC!\e[0m"
echo
echo "CA URL: ${CA_URL}"
echo "Data written to: ${STEPPATH}"
echo "CA password file: ${STEPPATH}/secrets/passwords/password"
echo "Issuer password file: ${STEPPATH}/secrets/certificate-issuer/password"
echo

FINGERPRINT=$(step certificate fingerprint $STEPPATH/certs/root_ca.crt)
echo "CA Fingerprint: ${FINGERPRINT}"
