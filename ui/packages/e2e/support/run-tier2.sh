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
# Where the on-failure diagnostics dump lands. Written BEFORE teardown (the EXIT
# trap deletes the cluster AND removes $KUBECONFIG_FILE, so nothing outside this
# script can reach the cluster afterwards); the workflow uploads this dir.
DIAG_DIR="${LIBREPOD_E2E_DIAG_DIR:-$E2E/tier2-diagnostics}"

# Collect cluster + app state for post-mortem of a Tier 2 failure (issue #180: the
# first install 500s on a cold cluster). MUST run while the cluster and its isolated
# kubeconfig still exist — i.e. from the test-failure path below, never from the EXIT
# trap after `k3d cluster delete`. Every command is best-effort (never fail the run).
dump_diagnostics() {
  echo "==> Capturing Tier 2 diagnostics to $DIAG_DIR"
  mkdir -p "$DIAG_DIR" || return 0
  {
    # marketplace-ui server — the log that shows the 500 at install time.
    kubectl logs deploy/marketplace-ui -n "$NS" --all-containers --tail=-1 \
      > "$DIAG_DIR/marketplace-ui.log" 2>&1 || true
    # Previous instance too, in case it restarted (e.g. CrashLoop hid the first boot).
    kubectl logs deploy/marketplace-ui -n "$NS" --all-containers --tail=-1 --previous \
      > "$DIAG_DIR/marketplace-ui.previous.log" 2>&1 || true
    kubectl describe pod -n "$NS" -l app.kubernetes.io/name=marketplace-ui \
      > "$DIAG_DIR/marketplace-ui.describe.txt" 2>&1 || true

    # Gogs server + its bootstrap Jobs (postStart creates the flux user; the ssh-key
    # Job seeds flux/user-apps — the repo-seeding race is between these and the UI).
    kubectl logs deploy/gogs -n gogs --all-containers --tail=-1 \
      > "$DIAG_DIR/gogs.log" 2>&1 || true
    kubectl logs job/gogs-bootstrap-ssh-key -n gogs --tail=-1 \
      > "$DIAG_DIR/gogs-bootstrap-ssh-key.job.log" 2>&1 || true
    kubectl logs job/marketplace-ui-bootstrap-session -n "$NS" --tail=-1 \
      > "$DIAG_DIR/marketplace-ui-bootstrap-session.job.log" 2>&1 || true

    # Flux reconcile state across the board — did user-apps reach Ready before the UI?
    flux get kustomizations -A > "$DIAG_DIR/flux-kustomizations.txt" 2>&1 || true
    flux get sources git -A   > "$DIAG_DIR/flux-sources-git.txt" 2>&1 || true
    kubectl get gitrepository,kustomization,ocirepository -n flux-system -o wide \
      > "$DIAG_DIR/flux-objects.txt" 2>&1 || true

    # Broad pod snapshot — anything not Running is a suspect.
    kubectl get pods -A -o wide > "$DIAG_DIR/pods.txt" 2>&1 || true
  } || true

  # The flux/user-apps repo state — the crux (empty/commitless ⇒ install 500). Read
  # straight off the git working copy the server maintains (issue #182): that is the
  # most direct answer to "what does the repo actually contain?", needs no credential,
  # and it replaces the old REST probe, whose GOGS_* env and root kustomization.yaml
  # both no longer exist. An empty or missing working copy is itself the diagnosis —
  # it means the server never reached the repo — so a failing `git -C` here is useful
  # output rather than a problem.
  local pod
  pod="$(kubectl get pods -n "$NS" -l app.kubernetes.io/name=marketplace-ui \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "$pod" ]; then
    {
      echo "== HEAD =="
      kubectl exec -n "$NS" "$pod" -c marketplace-ui -- \
        git -C /var/lib/user-apps/repo log --oneline -5 2>&1 || true
      echo "== tree =="
      kubectl exec -n "$NS" "$pod" -c marketplace-ui -- \
        git -C /var/lib/user-apps/repo ls-tree -r --name-only HEAD 2>&1 || true
      echo "== discovered remote =="
      kubectl get gitrepository user-apps-source -n flux-system \
        -o jsonpath='{.spec.url}{"\n"}{.status.conditions[*].message}{"\n"}' 2>&1 || true
    } > "$DIAG_DIR/user-apps-repo-state.txt" 2>&1 || true
  fi
  echo "==> Diagnostics written: $(ls -1 "$DIAG_DIR" 2>/dev/null | wc -l) file(s)"
}

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

# On failure, dump cluster/app state NOW — the EXIT trap below deletes the cluster and
# removes $KUBECONFIG_FILE, so this is the last moment either is reachable (issue #180).
if [ "$TEST_RC" -ne 0 ]; then
  dump_diagnostics || true
fi

exit "$TEST_RC"
