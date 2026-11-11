#!/usr/bin/env bash
# Behavioral test for the openbao bootstrap scripts' bounded-wait logic
# (marketplace-c9s): every wait loop must die at its own wall-clock budget —
# before the Job's terminal activeDeadlineSeconds — so backoffLimit retries
# the pod; the store container must exit promptly once the bootstrap
# container dies (bootstrap-exited handshake); and the seal-volume copy must
# land BEFORE the Secret create so a failed create self-heals on retry
# instead of bricking the bootstrap (PVC-wipe territory).
#
# Runs the REAL scripts under docker (alpine + stub bao/kubectl) because they
# hardcode container paths (/shared, /seal). The budget is shrunk to 3s via
# OPENBAO_BOOTSTRAP_BUDGET_SECONDS, so the whole suite finishes in seconds.
#
# Usage: bash scripts/test-openbao-bootstrap-budget.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=alpine:3.19
COMP=apps/openbao/components/bootstrap
FIX=$(mktemp -d /tmp/openbao-bootstrap-test.XXXXXX)
trap 'rm -rf "$FIX"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null

# Stubs: bao never answers a parseable status (unreachable API); kubectl
# reports no openbao-credentials Secret and can be made to fail creates via
# KUBECTL_CREATE_RC.
mkdir -p "$FIX/bin"
cat > "$FIX/bin/bao" <<'EOF'
#!/bin/sh
echo "Error getting status: connection refused" >&2
exit 2
EOF
cat > "$FIX/bin/kubectl" <<'EOF'
#!/bin/sh
if [ "$1 $2" = "get secret" ]; then
  exit 1 # no openbao-credentials Secret (fresh install)
fi
echo "kubectl-stub: $*" >> /shared/kubectl-calls.log
[ "${1}_$2" = "create_secret" ] && exit "${KUBECTL_CREATE_RC:-0}"
exit 0
EOF
chmod +x "$FIX/bin/bao" "$FIX/bin/kubectl"

# run <scenario-dir> <script> [extra env VAR=VAL ...] — executes the real
# script in alpine with the scenario dir bind-mounted at /shared, a scratch
# seal dir at /seal and the stubs first on PATH.
run() {
  local shared="$1" script="$2"; shift 2
  mkdir -p "$shared/seal"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$PWD/$COMP:/scripts:ro" \
    -v "$shared:/shared" \
    -v "$shared/seal:/seal" \
    -v "$FIX/bin:/stubs:ro" \
    -e OPENBAO_BOOTSTRAP_BUDGET_SECONDS=3 \
    -e BAO_ADDR=http://localhost:8200 \
    "$@" \
    "$IMAGE" sh -c "PATH=/stubs:\$PATH; sh /scripts/$script"
}

echo "==> A: bootstrap.sh exits non-zero at its budget when the API never answers"
shared="$FIX/a"; mkdir -p "$shared"
start=$(date +%s)
if run "$shared" bootstrap.sh; then fail "bootstrap.sh exited 0; expected budget exit 1"; fi
[ $(( $(date +%s) - start )) -lt 20 ] || fail "bootstrap.sh took >20s with a 3s budget — loop not wall-clock bounded"
[ -f "$shared/bootstrap-exited" ] || fail "EXIT trap did not drop /shared/bootstrap-exited"
echo "    ok: exited non-zero in $(( $(date +%s) - start ))s, trap fired"

echo "==> B: store.sh exits non-zero at its budget when done never appears"
shared="$FIX/b"; mkdir -p "$shared"
if run "$shared" store.sh; then fail "store.sh exited 0; expected budget exit 1"; fi
[ -f "$shared/no-secret" ] || fail "store.sh did not touch /shared/no-secret"
echo "    ok: exited non-zero, handshake file present"

echo "==> C: store.sh exits within one poll when bootstrap already died"
shared="$FIX/c"; mkdir -p "$shared"; touch "$shared/bootstrap-exited"
start=$(date +%s)
if run "$shared" store.sh -e OPENBAO_BOOTSTRAP_BUDGET_SECONDS=60; then
  fail "store.sh exited 0 on bootstrap-exited; expected 1"
fi
[ $(( $(date +%s) - start )) -lt 20 ] || fail "store.sh waited the full budget despite bootstrap-exited"
echo "    ok: exited via the handshake, not the budget"

echo "==> D: seal copy lands before the Secret create (self-heal on retry)"
shared="$FIX/d"; mkdir -p "$shared"
printf '{"root_token":"tok-123","recovery_keys":["k"]}' > "$shared/credentials.json"
touch "$shared/done"
if run "$shared" store.sh -e KUBECTL_CREATE_RC=1; then
  fail "store.sh exited 0 despite failed create; expected 1"
fi
[ -s "$shared/seal/credentials.json" ] || fail "seal copy missing after failed create — retry would brick the bootstrap"
echo "    ok: seal copy survived the failed create"
# retry with a fresh /shared (emptyDir dies with the pod) and a working kubectl
shared2="$FIX/d2"; mkdir -p "$shared2"; cp -r "$shared/seal" "$shared2/seal"
run "$shared2" store.sh || fail "store.sh did not self-heal from the seal copy"
[ "$(cat "$shared2/root-token")" = "tok-123" ] || fail "root-token not restored from seal copy"
grep -q "create secret" "$shared2/kubectl-calls.log" || fail "Secret not recreated on retry"
echo "    ok: retry restored the Secret from the seal volume"

echo "==> syntax: sh -n on both scripts (busybox, as in production)"
docker run --rm -v "$PWD/$COMP:/scripts:ro" "$IMAGE" \
  sh -c "sh -n /scripts/bootstrap.sh && sh -n /scripts/store.sh" \
  || fail "sh -n reported a syntax error"

echo "PASS: all budget/handshake/ordering checks green"
