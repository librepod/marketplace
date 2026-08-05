#!/usr/bin/env bash
# Tier 2 orchestrator: k3d create → wait Flux + marketplace-ui → port-forward → Playwright → delete.
# Extra args ("$@") are forwarded to `playwright test` (e.g. a spec path filter).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E="$(cd "$SCRIPT_DIR/.." && pwd)" # support/.. = the e2e package
CLUSTER="${LIBREPOD_E2E_CLUSTER:-librepod-k3d-e2e}"
NS="marketplace-ui"
PF_PORT="${LIBREPOD_E2E_PORT:-3101}" # not 3000 — a stray dev server can sit there
PF_PID=""
KUBECONFIG_FILE="$(mktemp -t e2e-kubeconfig.XXXXXX)"

cleanup() {
  echo "==> Tearing down"
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
  rm -f "$KUBECONFIG_FILE"
}
trap cleanup EXIT

# CRITICAL — isolate the e2e cluster's kubeconfig. Without this, if `k3d cluster create`
# ever failed, subsequent kubectl calls would hit whatever context was current — possibly
# a REAL cluster — and the tests would install/uninstall apps there. With KUBECONFIG
# pointed at a temp file, every kubectl/flux call below can ONLY reach the e2e cluster.
export KUBECONFIG="$KUBECONFIG_FILE"

# Start clean — a leaked cluster from a prior aborted run would make `create` fail.
k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true

echo "==> Creating k3d cluster $CLUSTER (Flux bootstraps in ~5-10 min)"
k3d cluster create --config "$SCRIPT_DIR/k3d-e2e.config.yaml"

# Safety gate: confirm we really are on the fresh e2e cluster before touching anything.
ctx="$(kubectl config current-context)"
echo "==> kubectl context: $ctx"
echo "$ctx" | grep -q "$CLUSTER" || { echo "ERROR: context ($ctx) is not the e2e cluster '$CLUSTER' — aborting to protect the current context." >&2; exit 1; }

echo "==> Waiting for marketplace-ui Deployment (deployed by the Flux system-apps chain)"
for _ in $(seq 1 180); do # up to ~15 min
  if kubectl get deployment marketplace-ui -n "$NS" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
if ! kubectl get deployment marketplace-ui -n "$NS" >/dev/null 2>&1; then
  echo "ERROR: marketplace-ui Deployment never appeared. Flux may be stuck on a system-app dependency." >&2
  echo "  Inspect: kubectl --kubeconfig "$KUBECONFIG_FILE" get pods -A | grep -v Running" >&2
  echo "           flux --kubeconfig "$KUBECONFIG_FILE" get kustomizations -n flux-system" >&2
  exit 1
fi
kubectl rollout status deployment/marketplace-ui -n "$NS" --timeout=600s

echo "==> Port-forwarding svc/marketplace-ui → localhost:$PF_PORT"
kubectl port-forward svc/marketplace-ui -n "$NS" "${PF_PORT}:80" >/dev/null 2>&1 &
PF_PID=$!
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:${PF_PORT}/api/health" >/dev/null && break || sleep 2
done
curl -sf "http://127.0.0.1:${PF_PORT}/api/health" >/dev/null || {
  echo "ERROR: marketplace-ui health check failed on localhost:$PF_PORT" >&2
  exit 1
}

# Since #51 the API requires a session cookie (global AuthGuard gates /api/*). The
# in-cluster marketplace-ui verifies against a RANDOM SESSION_SECRET in
# Secret/marketplace-ui-session (key 'session-secret', minted by the bootstrap-session
# Job) — read it here and export it; tier2.config.ts mints an offline HMAC cookie
# identical to SessionService.sign and injects it via storageState.
echo "==> Minting Tier 2 session cookie from Secret/$NS/marketplace-ui-session"
SESSION_SECRET="$(kubectl get secret marketplace-ui-session -n "$NS" -o 'jsonpath={.data.session-secret}' 2>/dev/null | base64 -d 2>/dev/null || true)"
if [ -z "$SESSION_SECRET" ]; then
  echo "ERROR: could not read SESSION_SECRET from Secret/$NS/marketplace-ui-session (key 'session-secret')." >&2
  echo "       The bootstrap-session Job should have created it before the Deployment rolled out." >&2
  exit 1
fi
export E2E_SESSION_SECRET="$SESSION_SECRET"

echo "==> Running Playwright (Tier 2)"
cd "$E2E"
set +e
E2E_BASE_URL="http://localhost:${PF_PORT}" npx playwright test --config projects/tier2.config.ts "$@"
TEST_RC=$?
set -e
exit "$TEST_RC"
