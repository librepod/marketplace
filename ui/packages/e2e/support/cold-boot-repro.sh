#!/usr/bin/env bash
# cold-boot-repro.sh — reproduce & verify the issue #180 first-install-500 race on a
# REAL cluster (not k3d). It forces a genuine cold boot of the user-apps REPO track —
# the state Tier 1/Tier 2's seeded harness never exercises — then, the instant
# marketplace-ui is Ready, drives one install and reports whether the FIRST attempt
# 500s (pre-fix) or succeeds (post-fix).
#
# WHY THIS EXISTS (committed/reusable): the two prior fixes (#176, #177) were token-
# focused and shipped on unverified hypotheses; both failed. The real cause is a
# repo-seeding race — a commitless flux/user-apps repo makes GET raw→404 (installer
# reads "not_installed") and the follow-up PUT contents→500. This script is the
# repeatable dev-cluster proof the issue demands, and a regression harness for any
# future Gogs-seeding race.
#
# THE FIX IT VERIFIES: marketplace-ui.Kustomization gains `dependsOn: user-apps` (a
# provider-neutral "repo is seeded & reconcilable" gate — Ready ⇔ Flux cloned+applied
# the seeded repo, identical for Gogs/GitHub/GitLab) and the Gogs-only
# `wait-for-gogs-user` initContainer is deleted. This script AUTO-DETECTS which state
# the cluster is in (reads the live dependsOn) and labels the run PRE-FIX / POST-FIX.
#
# ─────────────────────────────────────────────────────────────────────────────────
# CLUSTER SYNC CAVEAT (read before expecting a POST-FIX pass):
# The dev cluster syncs from an OCI artifact, NOT git — there is no
# GitRepository/librepod-apps to branch-override. So the fix only becomes live after
# either (a) the marketplace-ui OCI image + apps manifest are PUBLISHED at the tag the
# cluster tracks, or (b) the change is merged to master and the normal publish runs.
# Running this BEFORE the fix is published captures the PRE-FIX 500 baseline; running
# it AFTER captures the POST-FIX success. The script itself does not publish anything.
# ─────────────────────────────────────────────────────────────────────────────────
#
# Usage:
#   KUBECONFIG=~/.kube/librepod-dev.config bash cold-boot-repro.sh [--repeat N] [--app NAME]
#     --repeat N   POST-FIX only: repeat the cold-boot→install cycle N times to beat
#                  the ~3/4 failure rate the issue reported (default 1).
#     --app NAME   app to install for the probe (default: first user-facing app).
#     --yes        skip the interactive "this wipes Gogs data" confirmation.
#
# SAFETY: this DESTROYS Gogs data on the target cluster (wipes the NFS export contents
# and forces a re-seed). It refuses to run unless the current kube-context name
# contains "librepod-dev" (override with LIBREPOD_COLD_BOOT_ALLOW_CONTEXT=<substr>).
set -euo pipefail

# ── config ──────────────────────────────────────────────────────────────────────
GOGS_NS="gogs"
MUI_NS="marketplace-ui"
FLUX_NS="flux-system"
NFS_PATH_DEFAULT="/exports/k3s/gogs/gogs-data"     # PV.spec.nfs.path (Retain reclaim)
REPEAT=1
APP=""
ASSUME_YES=0
CTX_GUARD="${LIBREPOD_COLD_BOOT_ALLOW_CONTEXT:-librepod-dev}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    WARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repeat) REPEAT="$2"; shift 2 ;;
    --app)    APP="$2"; shift 2 ;;
    --yes)    ASSUME_YES=1; shift ;;
    *) die "unknown arg: $1" ;;
  esac
done

command -v kubectl >/dev/null || die "kubectl not on PATH"

# ── safety gate ─────────────────────────────────────────────────────────────────
CTX="$(kubectl config current-context 2>/dev/null || true)"
[ -n "$CTX" ] || die "no current kube-context (set KUBECONFIG)"
echo "$CTX" | grep -q "$CTX_GUARD" || die \
  "context '$CTX' does not contain '$CTX_GUARD' — refusing to wipe Gogs data on an unexpected cluster."
log "Target context: $CTX"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf '\033[1;33mThis WIPES all Gogs data on "%s" and forces a re-seed. Continue? [y/N] \033[0m' "$CTX"
  read -r ans
  case "$ans" in y|Y|yes) ;; *) die "aborted by user" ;; esac
fi

# ── detect PRE-FIX vs POST-FIX from the live dependsOn ──────────────────────────
DEPS="$(kubectl get kustomization marketplace-ui -n "$FLUX_NS" \
  -o jsonpath='{.spec.dependsOn[*].name}' 2>/dev/null || true)"
if echo "$DEPS" | grep -qw "user-apps"; then
  MODE="POST-FIX"
else
  MODE="PRE-FIX"
fi
log "Detected deployment state: $MODE   (marketplace-ui dependsOn: ${DEPS:-<none>})"
if [ "$MODE" = "PRE-FIX" ] && [ "$REPEAT" -gt 1 ]; then
  warn "--repeat >1 is intended for POST-FIX confirmation; PRE-FIX just needs one 500 baseline."
fi

# ── resolve NFS export path from the live PV (fall back to default) ─────────────
GOGS_PVC="$(kubectl get pvc -n "$GOGS_NS" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
GOGS_PV="$(kubectl get pvc -n "$GOGS_NS" -o jsonpath='{.items[0].spec.volumeName}' 2>/dev/null || true)"
NFS_PATH="$(kubectl get pv "$GOGS_PV" -o jsonpath='{.spec.nfs.path}' 2>/dev/null || true)"
NFS_PATH="${NFS_PATH:-$NFS_PATH_DEFAULT}"
info "Gogs PVC=$GOGS_PVC PV=$GOGS_PV  NFS export path=$NFS_PATH"

# ── snapshot (for the record; a full cold-boot wipe is the reliable restorer) ───
log "Snapshot of current state"
SNAP_ROOT="$(mktemp -d -t cold-boot-snap.XXXXXX)"
kubectl get kustomization -n "$FLUX_NS" -o wide > "$SNAP_ROOT/kustomizations.before.txt" 2>&1 || true
info "installed apps (root kustomization resources), before wipe:"
mui_pod() { kubectl get pods -n "$MUI_NS" -l app.kubernetes.io/name=marketplace-ui \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true; }
POD="$(mui_pod)"
if [ -n "$POD" ]; then
  kubectl exec -n "$MUI_NS" "$POD" -c marketplace-ui -- node -e '
    const G=(process.env.GOGS_URL||"http://gogs.gogs.svc.cluster.local:80").replace(/\/$/,"");
    const U=process.env.GOGS_USERNAME,P=process.env.GOGS_TOKEN;
    (async()=>{
      const t=await fetch(`${G}/api/v1/users/${U}/tokens`,{method:"POST",
        headers:{Authorization:"Basic "+Buffer.from(`${U}:${P}`).toString("base64"),"Content-Type":"application/json"},
        body:JSON.stringify({name:"snap-"+Math.random().toString(16).slice(2,8)})});
      const tok=t.ok?(await t.json()).sha1:"";
      const r=await fetch(`${G}/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`,{headers:{Authorization:`token ${tok}`}});
      console.log("      GET raw ->",r.status,"\n"+(await r.text()).split("\n").map(l=>"      | "+l).join("\n"));
    })().catch(e=>console.log("      snapshot probe error:",e.message));
  ' 2>&1 | sed 's/^/  /' || true
fi
info "snapshot dir: $SNAP_ROOT"

# ── the cold-boot forcing routine ───────────────────────────────────────────────
force_cold_boot() {
  log "Forcing a genuine cold boot of the repo track"

  info "1) scale down marketplace-ui and gogs"
  kubectl scale deploy/marketplace-ui -n "$MUI_NS" --replicas=0 >/dev/null 2>&1 || true
  kubectl scale deploy/gogs -n "$GOGS_NS" --replicas=0 >/dev/null 2>&1 || true
  kubectl rollout status deploy/marketplace-ui -n "$MUI_NS" --timeout=120s >/dev/null 2>&1 || true
  kubectl wait --for=delete pod -n "$GOGS_NS" -l app.kubernetes.io/name=gogs --timeout=120s >/dev/null 2>&1 || true

  info "2) wipe the Gogs NFS export contents (Retain reclaim ⇒ deleting the PVC alone won't clear it)"
  # A throwaway root pod mounts the SAME NFS export and rm -rf its contents. Uses the
  # in-cluster NFS server (the PV's own nfs.server/path) so it works regardless of node.
  local nfs_server
  nfs_server="$(kubectl get pv "$GOGS_PV" -o jsonpath='{.spec.nfs.server}' 2>/dev/null || echo '127.0.0.1')"
  kubectl delete pod gogs-nfs-wipe -n "$GOGS_NS" --ignore-not-found >/dev/null 2>&1 || true
  cat <<EOF | kubectl apply -f - >/dev/null 2>&1 || warn "wipe pod apply failed"
apiVersion: v1
kind: Pod
metadata:
  name: gogs-nfs-wipe
  namespace: $GOGS_NS
spec:
  restartPolicy: Never
  containers:
    - name: wipe
      image: alpine:3.19
      command: ["/bin/sh","-c","set -e; ls -A /data | head; rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null || true; echo WIPED; ls -A /data | wc -l"]
      volumeMounts: [{ name: nfs, mountPath: /data }]
  volumes:
    - name: nfs
      nfs: { server: "$nfs_server", path: "$NFS_PATH" }
EOF
  kubectl wait --for=condition=Ready pod/gogs-nfs-wipe -n "$GOGS_NS" --timeout=60s >/dev/null 2>&1 || true
  kubectl logs pod/gogs-nfs-wipe -n "$GOGS_NS" 2>&1 | sed 's/^/      wipe: /' || true
  kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/gogs-nfs-wipe -n "$GOGS_NS" --timeout=60s >/dev/null 2>&1 || true
  kubectl delete pod gogs-nfs-wipe -n "$GOGS_NS" --ignore-not-found >/dev/null 2>&1 || true

  info "3) delete the user-apps ssh-key secret (+ reflections) and the Completed seed Job so it re-runs"
  kubectl delete secret user-apps-ssh-key -n "$GOGS_NS" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete secret user-apps-ssh-key -n "$FLUX_NS" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete secret user-apps-ssh-key -n "$MUI_NS" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete job gogs-bootstrap-ssh-key -n "$GOGS_NS" --ignore-not-found >/dev/null 2>&1 || true

  info "4) scale gogs back up; postStart re-creates the flux user, the seed Job re-seeds flux/user-apps"
  kubectl scale deploy/gogs -n "$GOGS_NS" --replicas=1 >/dev/null 2>&1 || true
  kubectl rollout status deploy/gogs -n "$GOGS_NS" --timeout=300s >/dev/null 2>&1 || warn "gogs rollout slow"

  # Re-trigger Flux so the seed Job (owned by the user-apps-source Kustomization) is
  # recreated promptly rather than waiting for the next interval.
  if command -v flux >/dev/null 2>&1; then
    flux reconcile kustomization user-apps-source -n "$FLUX_NS" >/dev/null 2>&1 || true
  fi

  info "5) scale marketplace-ui back up (Flux will also self-heal it on the next reconcile)"
  kubectl scale deploy/marketplace-ui -n "$MUI_NS" --replicas=1 >/dev/null 2>&1 || true
}

# ── drive ONE install the instant marketplace-ui is Ready; capture status+log ────
# Mints an HMAC mp_session cookie identical to SessionService.sign / mint-session.ts
# from Secret/marketplace-ui-session, then POSTs /api/apps/<app>/install from inside
# the pod and prints the HTTP status. Returns the status via stdout's last line.
attempt_install() {
  local iter="$1"
  log "[$MODE iter $iter] Waiting for marketplace-ui to become Ready, then installing immediately"

  # Also record whether user-apps is Ready at the moment MUI becomes Ready — the whole
  # point of the fix is that MUI must NOT be Ready before user-apps is.
  # Wait for a running MUI pod.
  local waited=0
  POD=""
  while [ "$waited" -lt 300 ]; do
    POD="$(mui_pod)"
    if [ -n "$POD" ] && [ "$(kubectl get pod -n "$MUI_NS" "$POD" -o jsonpath='{.status.phase}' 2>/dev/null)" = "Running" ] \
       && kubectl exec -n "$MUI_NS" "$POD" -c marketplace-ui -- node -e 'fetch("http://localhost:3000/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
      break
    fi
    sleep 3; waited=$((waited+3))
  done
  [ -n "$POD" ] || { warn "marketplace-ui pod never became Ready"; echo "STATUS=NA"; return 0; }

  local ua_ready
  ua_ready="$(kubectl get kustomization user-apps -n "$FLUX_NS" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo '?')"
  info "at MUI-Ready: user-apps Kustomization Ready=$ua_ready  (POST-FIX expects True; PRE-FIX may be False)"

  local app="$APP"
  if [ -z "$app" ]; then
    app="$(kubectl exec -n "$MUI_NS" "$POD" -c marketplace-ui -- node -e '
      fetch("http://localhost:3000/api/apps").then(r=>r.json()).then(a=>console.log(a[0].name)).catch(()=>console.log(""))' 2>/dev/null || true)"
  fi
  [ -n "$app" ] || { warn "could not resolve an app to install"; echo "STATUS=NA"; return 0; }
  info "installing app: $app"

  # Mint cookie + POST install from inside the pod (has SESSION secret via env? No —
  # the secret is a separate Secret; read it out and pass it in).
  local sess
  sess="$(kubectl get secret marketplace-ui-session -n "$MUI_NS" -o jsonpath='{.data.session-secret}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  [ -n "$sess" ] || { warn "no session-secret; cannot mint cookie"; echo "STATUS=NA"; return 0; }

  # Capture a log marker so we can slice the server log around this attempt.
  local marker="COLD-BOOT-PROBE-${iter}-$(kubectl get pod -n "$MUI_NS" "$POD" -o jsonpath='{.metadata.uid}' 2>/dev/null | tr -d '-' | head -c8)"

  local status
  status="$(SESS="$sess" APP="$app" kubectl exec -i -n "$MUI_NS" "$POD" -c marketplace-ui -- \
    env SESS="$sess" APP="$app" MARKER="$marker" node -e '
      const crypto=require("crypto");
      const secret=process.env.SESS, app=process.env.APP;
      const now=Math.floor(Date.now()/1000);
      const body=Buffer.from(JSON.stringify({sub:"cold-boot",name:"cold-boot",email:"cb@local",iat:now,exp:now+3600})).toString("base64url");
      const sig=crypto.createHmac("sha256",secret).update(body).digest("base64url");
      const cookie="mp_session="+body+"."+sig;
      fetch(`http://localhost:3000/api/apps/${app}/install`,{method:"POST",headers:{Cookie:cookie}})
        .then(async r=>{console.error(process.env.MARKER+" install POST status "+r.status+" body "+(await r.text()).slice(0,120)); console.log(r.status);})
        .catch(e=>{console.error("probe error "+e.message); console.log("ERR");});
    ' 2>>/dev/null)" || true
  status="$(echo "$status" | tail -1)"
  info "FIRST-attempt install POST status: ${status:-<none>}"

  # Slice the server log around the attempt.
  info "server log lines around the attempt:"
  kubectl logs -n "$MUI_NS" "$POD" -c marketplace-ui --tail=40 2>&1 \
    | grep -iE "gogs|install|token|error|warn|$app" | tail -15 | sed 's/^/      /' || true

  echo "STATUS=${status:-NA}"
}

# ── run ─────────────────────────────────────────────────────────────────────────
PASS=0; FAIL=0; RESULTS=""
i=1
while [ "$i" -le "$REPEAT" ]; do
  force_cold_boot
  out="$(attempt_install "$i")"
  st="$(echo "$out" | sed -n 's/^STATUS=//p' | tail -1)"
  case "$MODE" in
    PRE-FIX)
      if [ "$st" = "500" ]; then
        log "PRE-FIX BASELINE CAPTURED: first install returned 500 (repo-seeding race reproduced)."
        PASS=$((PASS+1)); RESULTS="$RESULTS\n  iter $i: 500 (expected pre-fix)"
      else
        warn "PRE-FIX: expected a 500 but got '$st' — the seed may have landed before the probe (timing). Re-run to catch the window."
        FAIL=$((FAIL+1)); RESULTS="$RESULTS\n  iter $i: $st (pre-fix; no 500 observed)"
      fi
      ;;
    POST-FIX)
      if [ "$st" = "200" ] || [ "$st" = "201" ]; then
        log "POST-FIX: first install SUCCEEDED ($st) — gate held."
        PASS=$((PASS+1)); RESULTS="$RESULTS\n  iter $i: $st (success)"
      else
        warn "POST-FIX: first install did NOT succeed (got '$st'). The gate did not hold — investigate."
        FAIL=$((FAIL+1)); RESULTS="$RESULTS\n  iter $i: $st (FAILURE)"
      fi
      ;;
  esac
  i=$((i+1))
done

log "SUMMARY ($MODE): $PASS ok / $FAIL not-ok over $REPEAT run(s)"
printf '%b\n' "$RESULTS"
log "Cluster left re-seeded from the last cold boot. Snapshot kept at: $SNAP_ROOT"
[ "$FAIL" -eq 0 ] || exit 1
