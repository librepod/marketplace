#!/usr/bin/env bash
# cold-boot-repro.sh — reproduce & verify the issue #180 first-install-500 race on a
# REAL cluster (not k3d), by exercising the actual Flux ORDERING gate the fix relies on.
#
# It forces a cold boot that HOLDS flux/user-apps un-seeded, deletes the marketplace-ui
# Deployment, then makes Flux RE-APPLY marketplace-ui and asserts what happens while
# user-apps is NotReady:
#   • POST-FIX (dependsOn: user-apps)  → GATE=HELD: marketplace-ui Kustomization sits at
#       DependencyNotReady and NO pod is created; then we release the seed, user-apps
#       goes Ready, marketplace-ui applies, and the first install succeeds (2xx).
#   • PRE-FIX (no dependsOn)           → GATE=OPEN: marketplace-ui applies and a pod comes
#       up against the un-seeded repo; the first install 500s (race reproduced).
#
# WHY THE GATE, NOT `kubectl scale`: the fix withholds the *apply* of the marketplace-ui
# Kustomization until user-apps is Ready. Scaling an already-applied Deployment back up
# starts a pod regardless of that gate — a false negative (the first version of this
# script did exactly that and mis-reported a POST-FIX 500). So we delete the Deployment
# and let Flux decide whether to re-create it. See memory: tier2-nightly-is-the-postfix-
# coldboot-proof. (The Tier 2 k3d nightly is the automated genuine-cold-boot proof; this
# script is the on-demand dev-cluster equivalent that also asserts PRE-FIX.)
#
# WHY THIS EXISTS (committed/reusable): the two prior fixes (#176, #177) were token-
# focused and shipped on unverified hypotheses; both failed. The real cause is a
# repo-seeding race — a commitless flux/user-apps repo makes GET raw→404 (installer
# reads "not_installed") and the follow-up PUT contents→500. This script is the
# repeatable dev-cluster proof the issue demands, and a regression harness for any
# future Gogs-seeding race.
#
# THE FIX IT VERIFIES: marketplace-ui.Kustomization gains `dependsOn: user-apps` (a
# provider-neutral "repo is seeded & reconcilable" gate — user-apps Ready ⇔ the
# GitRepository resolved a commit on master ⇔ repo seeded, identical for Gogs/GitHub/
# GitLab) and the Gogs-only `wait-for-gogs-user` initContainer is deleted. This script
# AUTO-DETECTS which state the cluster is in (reads the live dependsOn) and labels the
# run PRE-FIX / POST-FIX.
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

# Request a Flux reconcile WITHOUT waiting (annotate). Used where a blocking
# `flux reconcile` would otherwise sit for the object's full timeout — e.g. a
# Kustomization we EXPECT to hold at DependencyNotReady, or a source we expect to fail.
flux_request_reconcile() {  # <kind> <name>
  kubectl annotate "$1" "$2" -n "$FLUX_NS" \
    "reconcile.fluxcd.io/requestedAt=$(date +%s%N)" --overwrite >/dev/null 2>&1 || true
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repeat) REPEAT="$2"; shift 2 ;;
    --app)    APP="$2"; shift 2 ;;
    --yes)    ASSUME_YES=1; shift ;;
    *) die "unknown arg: $1" ;;
  esac
done

command -v kubectl >/dev/null || die "kubectl not on PATH"
command -v flux    >/dev/null || die "flux CLI required — the gate test uses flux suspend/resume/reconcile"

# ── safety gate ─────────────────────────────────────────────────────────────────
CTX="$(kubectl config current-context 2>/dev/null || true)"
[ -n "$CTX" ] || die "no current kube-context (set KUBECONFIG)"
echo "$CTX" | grep -q "$CTX_GUARD" || die \
  "context '$CTX' does not contain '$CTX_GUARD' — refusing to wipe Gogs data on an unexpected cluster."
log "Target context: $CTX"

# Safety net: a mid-run failure must never leave marketplace-ui suspended.
trap 'flux resume kustomization marketplace-ui -n flux-system >/dev/null 2>&1 || true' EXIT

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

# ── NFS wipe helper (shared) ─────────────────────────────────────────────────────
# A throwaway root pod mounts the SAME Gogs NFS export and rm -rf its contents, using
# the in-cluster NFS server (the PV's own nfs.server/path) so it works on any node.
# NFS is Retain-reclaim, so deleting the PVC alone would NOT clear it.
wipe_gogs_nfs() {
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
}

# ── cold boot that HOLDS flux/user-apps un-seeded (so the Flux gate is observable) ─
# The fix (marketplace-ui.dependsOn: user-apps) works at the Flux ORDERING layer: it
# withholds the *apply* of the marketplace-ui Kustomization until user-apps is Ready.
# The only faithful way to exercise that is to make Flux RE-APPLY marketplace-ui from
# a state where its Deployment does NOT exist AND user-apps is NotReady — never to
# `kubectl scale` an already-applied Deployment (that starts a pod regardless of the
# gate: a false negative, which is why the first version of this script mis-reported).
# We hold user-apps NotReady deterministically: the seed Job has no ttl and only
# re-runs on an explicit `flux reconcile ks user-apps-source`, so after wiping the repo
# and deleting the ssh-key Secret + Job we simply do NOT reconcile user-apps-source —
# user-apps stays NotReady until release_seed_and_wait_ready() releases it.
force_cold_boot() {
  log "Forcing a cold boot that HOLDS flux/user-apps un-seeded (to exercise the dependsOn gate)"

  info "1) suspend marketplace-ui Kustomization + delete its Deployment (no pod; Flux won't re-apply while suspended)"
  flux suspend kustomization marketplace-ui -n "$FLUX_NS" >/dev/null 2>&1 || true
  kubectl delete deploy marketplace-ui -n "$MUI_NS" --ignore-not-found >/dev/null 2>&1 || true
  kubectl wait --for=delete pod -n "$MUI_NS" -l app.kubernetes.io/name=marketplace-ui --timeout=120s >/dev/null 2>&1 || true

  info "2) scale gogs down and wipe its NFS export (flux/user-apps becomes commitless)"
  kubectl scale deploy/gogs -n "$GOGS_NS" --replicas=0 >/dev/null 2>&1 || true
  kubectl wait --for=delete pod -n "$GOGS_NS" -l app.kubernetes.io/name=gogs --timeout=120s >/dev/null 2>&1 || true
  wipe_gogs_nfs

  info "3) delete the user-apps ssh-key Secret (all namespaces) + the seed Job — held un-seeded"
  kubectl delete secret user-apps-ssh-key -n "$GOGS_NS" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete secret user-apps-ssh-key -n "$FLUX_NS" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete secret user-apps-ssh-key -n "$MUI_NS" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete job gogs-bootstrap-ssh-key -n "$GOGS_NS" --ignore-not-found >/dev/null 2>&1 || true

  info "4) scale gogs back up (postStart re-creates the flux user); repo stays commitless — we do NOT reconcile user-apps-source yet"
  kubectl scale deploy/gogs -n "$GOGS_NS" --replicas=1 >/dev/null 2>&1 || true
  kubectl rollout status deploy/gogs -n "$GOGS_NS" --timeout=300s >/dev/null 2>&1 || warn "gogs rollout slow"

  info "5) force user-apps to observe the un-seeded state NOW (source clone fails ⇒ user-apps NotReady)"
  flux_request_reconcile gitrepository user-apps-source
  flux_request_reconcile kustomization user-apps
  local w=0
  while [ "$w" -lt 120 ]; do
    if [ "$(kubectl get kustomization user-apps -n "$FLUX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "False" ]; then break; fi
    sleep 3; w=$((w+3))
  done
  info "user-apps Ready=$(kubectl get kustomization user-apps -n "$FLUX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)  (want False = un-seeded)"
}

# ── the CORE assertion: while user-apps is NotReady, does marketplace-ui apply? ───
# Prints GATE=HELD (post-fix: DependencyNotReady, Deployment absent), GATE=OPEN
# (pre-fix: marketplace-ui applied and a pod is coming up despite the un-seeded repo),
# or GATE=UNKNOWN. All diagnostics go to stderr so stdout is exactly the GATE= line.
assert_gate() {
  log "Asserting the dependsOn gate while user-apps is NotReady" >&2

  # Disambiguation: the OTHER deps must be Ready, else a DependencyNotReady could be
  # about them rather than user-apps.
  local d rr others=""
  for d in gogs cert-manager casdoor-sso-controller; do
    rr="$(kubectl get kustomization "$d" -n "$FLUX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo '?')"
    [ "$rr" = "True" ] || others="$others $d($rr)"
  done
  [ -n "$others" ] && warn "other marketplace-ui deps not Ready:$others — gate attribution may be ambiguous"

  # Resume + request a (non-blocking) reconcile. A blocking `flux reconcile` would sit
  # for the whole 5m timeout in the POST-FIX case (it never reaches Ready).
  flux resume kustomization marketplace-ui -n "$FLUX_NS" >/dev/null 2>&1 || true
  flux_request_reconcile kustomization marketplace-ui

  # Poll up to ~45s so we don't misread a slow controller as UNKNOWN: classify as soon
  # as the Deployment appears (OPEN) or the Kustomization reports a dependency block
  # with no Deployment (HELD). Keep the last-seen values for the diagnostic line.
  local mui_ready mui_reason mui_msg deploy_exists ua_ready verdict="UNKNOWN" w=0
  while [ "$w" -lt 45 ]; do
    mui_ready="$(kubectl get kustomization marketplace-ui -n "$FLUX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo '?')"
    mui_reason="$(kubectl get kustomization marketplace-ui -n "$FLUX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].reason}' 2>/dev/null || echo '?')"
    mui_msg="$(kubectl get kustomization marketplace-ui -n "$FLUX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}' 2>/dev/null || echo '')"
    deploy_exists="no"; kubectl get deploy marketplace-ui -n "$MUI_NS" >/dev/null 2>&1 && deploy_exists="yes"
    if [ "$deploy_exists" = "yes" ]; then verdict="OPEN"; break; fi
    if [ "$mui_ready" = "False" ] && echo "$mui_reason $mui_msg" | grep -qiE "dependenc"; then verdict="HELD"; break; fi
    sleep 3; w=$((w+3))
  done
  ua_ready="$(kubectl get kustomization user-apps -n "$FLUX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo '?')"

  info "user-apps Ready=$ua_ready | marketplace-ui Ready=$mui_ready reason=$mui_reason deploy=$deploy_exists → $verdict" >&2
  info "  marketplace-ui msg: ${mui_msg:0:170}" >&2
  echo "GATE=$verdict"
}

# ── release the held seed: reseed the repo, wait user-apps Ready, let Flux apply MUI ─
release_seed_and_wait_ready() {
  log "Releasing the seed: reconcile user-apps-source (re-runs the bootstrap Job → reseeds repo + ssh key)"
  flux reconcile kustomization user-apps-source -n "$FLUX_NS" --with-source >/dev/null 2>&1 || true
  local w=0
  while [ "$w" -lt 180 ]; do
    if [ "$(kubectl get job gogs-bootstrap-ssh-key -n "$GOGS_NS" -o jsonpath='{.status.succeeded}' 2>/dev/null)" = "1" ]; then break; fi
    sleep 5; w=$((w+5))
  done
  info "seed Job succeeded=$(kubectl get job gogs-bootstrap-ssh-key -n "$GOGS_NS" -o jsonpath='{.status.succeeded}' 2>/dev/null)"

  flux reconcile source git user-apps-source -n "$FLUX_NS" >/dev/null 2>&1 || true
  flux reconcile kustomization user-apps -n "$FLUX_NS" >/dev/null 2>&1 || true
  w=0
  while [ "$w" -lt 180 ]; do
    if [ "$(kubectl get kustomization user-apps -n "$FLUX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ]; then break; fi
    sleep 5; w=$((w+5))
  done
  info "user-apps Ready=$(kubectl get kustomization user-apps -n "$FLUX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)  (want True = seeded)"

  log "Reconcile marketplace-ui — dependency satisfied, Flux should now apply it"
  flux resume kustomization marketplace-ui -n "$FLUX_NS" >/dev/null 2>&1 || true
  flux reconcile kustomization marketplace-ui -n "$FLUX_NS" >/dev/null 2>&1 || true
  w=0
  while [ "$w" -lt 120 ]; do
    if kubectl get deploy marketplace-ui -n "$MUI_NS" >/dev/null 2>&1; then break; fi
    sleep 3; w=$((w+3))
  done
  kubectl rollout status deploy/marketplace-ui -n "$MUI_NS" --timeout=300s >/dev/null 2>&1 || warn "marketplace-ui rollout slow"
}

# ── drive ONE install the instant marketplace-ui is Ready; capture status+log ────
# Mints an HMAC mp_session cookie identical to SessionService.sign / mint-session.ts
# from Secret/marketplace-ui-session, then POSTs /api/apps/<app>/install from inside
# the pod and prints the HTTP status. Returns the status via stdout's last line.
attempt_install() {
  local iter="$1"
  log "[$MODE iter $iter] Waiting for marketplace-ui to become Ready, then installing immediately"

  # Every API route except /api/health and /api/auth/* is guarded by a global
  # APP_GUARD (AuthGuard) that requires a valid mp_session HMAC cookie — the Casdoor
  # login gate from #51. So BOTH the readiness/resolve probe (GET /api/apps) and the
  # install POST must carry a minted cookie; an unauthenticated GET /api/apps 401s
  # (not an empty catalog), which earlier read as a false "app never resolved". Mint
  # the cookie ONCE up front from Secret/marketplace-ui-session (its session-secret is
  # the pod's SESSION_SECRET, verified live) and reuse it for both calls.
  local sess
  sess="$(kubectl get secret marketplace-ui-session -n "$MUI_NS" -o jsonpath='{.data.session-secret}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  [ -n "$sess" ] || { warn "no Secret/marketplace-ui-session session-secret; cannot mint cookie"; echo "STATUS=NA"; return 0; }

  # Also record whether user-apps is Ready at the moment MUI becomes Ready — the whole
  # point of the fix is that MUI must NOT be Ready before user-apps is.
  #
  # Readiness must be STRONG here, or we race the rollout and misread a not-yet-serving
  # pod as a fix failure. After a cold boot there is churn: the old pod Terminates while
  # a new one is still 0/1, and `/api/health` (a bare Terminus liveness check) goes green
  # BEFORE CatalogService has loaded — so an authenticated `/api/apps` briefly returns a
  # non-array/empty. Gate on all three: (1) a pod whose container reports Ready (1/1), not
  # merely Running; (2) an AUTHENTICATED `/api/apps` returns a NON-EMPTY array (catalog
  # loaded, app truly installable); then (3) resolve the app to install from that same
  # response. `local app` first so a failure inside the substitution can't mask a
  # non-zero (set -e) exit.
  local waited=0 app="$APP"
  POD=""
  while [ "$waited" -lt 300 ]; do
    # Pick a Ready pod explicitly (field-select Running, then check containerStatuses[].ready),
    # never a Terminating leftover or a 0/1 newcomer.
    local cand
    for cand in $(kubectl get pods -n "$MUI_NS" -l app.kubernetes.io/name=marketplace-ui \
        --field-selector=status.phase=Running \
        -o jsonpath='{range .items[*]}{.metadata.name} {.status.containerStatuses[0].ready}{"\n"}{end}' 2>/dev/null \
        | awk '$2=="true"{print $1}'); do
      # From THIS Ready pod, with a minted cookie, require a non-empty /api/apps array;
      # capture the first app name. 401/empty/non-array all fail this pod (keep waiting).
      local first
      first="$(SESS="$sess" kubectl exec -n "$MUI_NS" "$cand" -c marketplace-ui -- env SESS="$sess" node -e '
        const crypto=require("crypto"); const secret=process.env.SESS;
        const now=Math.floor(Date.now()/1000);
        const b=Buffer.from(JSON.stringify({sub:"cold-boot",name:"cold-boot",email:"cb@local",iat:now,exp:now+3600})).toString("base64url");
        const cookie="mp_session="+b+"."+crypto.createHmac("sha256",secret).update(b).digest("base64url");
        fetch("http://localhost:3000/api/apps",{headers:{Cookie:cookie}})
          .then(r=>r.json())
          .then(a=>{ if(Array.isArray(a)&&a.length){process.stdout.write(a[0].name)} else {process.exit(2)} })
          .catch(()=>process.exit(1))' 2>/dev/null || true)"
      if [ -n "$first" ]; then
        POD="$cand"
        [ -n "$app" ] || app="$first"
        break 2
      fi
    done
    sleep 3; waited=$((waited+3))
  done
  [ -n "$POD" ] || { warn "marketplace-ui never became Ready+serving a non-empty (authenticated) /api/apps within 300s"; echo "STATUS=NA"; return 0; }

  local ua_ready
  ua_ready="$(kubectl get kustomization user-apps -n "$FLUX_NS" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo '?')"
  info "at MUI-Ready (pod $POD): user-apps Kustomization Ready=$ua_ready  (POST-FIX expects True; PRE-FIX may be False)"

  [ -n "$app" ] || { warn "could not resolve an app to install"; echo "STATUS=NA"; return 0; }
  info "installing app: $app"

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
# Each iteration: force the held-un-seeded cold boot, assert the Flux gate, then act
# on the result per MODE. The GATE assertion (deterministic) is the PRIMARY signal;
# the install status is the confirming end-to-end outcome.
PASS=0; FAIL=0; RESULTS=""
i=1
while [ "$i" -le "$REPEAT" ]; do
  force_cold_boot
  gate="$(assert_gate | sed -n 's/^GATE=//p' | tail -1)"

  case "$MODE" in
    POST-FIX)
      if [ "$gate" = "HELD" ]; then
        log "[iter $i] GATE HELD ✓ — marketplace-ui blocked on user-apps (DependencyNotReady); no pod while un-seeded"
        release_seed_and_wait_ready
        out="$(attempt_install "$i")"; st="$(echo "$out" | sed -n 's/^STATUS=//p' | tail -1)"
        if [ "$st" = "200" ] || [ "$st" = "201" ]; then
          log "POST-FIX iter $i: gate HELD + first install $st ✓"
          PASS=$((PASS+1)); RESULTS="$RESULTS\n  iter $i: GATE=HELD install=$st (PASS)"
        else
          warn "POST-FIX iter $i: gate HELD but first install=$st (expected 2xx)"
          FAIL=$((FAIL+1)); RESULTS="$RESULTS\n  iter $i: GATE=HELD install=$st (FAIL: install)"
        fi
      else
        warn "POST-FIX iter $i: gate NOT held (GATE=$gate) — marketplace-ui came up despite an un-seeded user-apps. The fix did not gate; investigate."
        FAIL=$((FAIL+1)); RESULTS="$RESULTS\n  iter $i: GATE=$gate (FAIL: gate)"
        release_seed_and_wait_ready
      fi
      ;;
    PRE-FIX)
      if [ "$gate" = "OPEN" ]; then
        log "[iter $i] GATE OPEN (expected pre-fix) — marketplace-ui came up while the repo is un-seeded; installing to capture the 500"
        out="$(attempt_install "$i")"; st="$(echo "$out" | sed -n 's/^STATUS=//p' | tail -1)"
        if [ "$st" = "500" ]; then
          log "PRE-FIX iter $i: gate OPEN + first install 500 ✓ (repo-seeding race reproduced)"
          PASS=$((PASS+1)); RESULTS="$RESULTS\n  iter $i: GATE=OPEN install=500 (PASS: baseline)"
        else
          warn "PRE-FIX iter $i: gate OPEN but install=$st (expected 500; the seed may have landed before the probe)"
          FAIL=$((FAIL+1)); RESULTS="$RESULTS\n  iter $i: GATE=OPEN install=$st (no 500 observed)"
        fi
        release_seed_and_wait_ready
      else
        warn "PRE-FIX iter $i: expected GATE=OPEN but got GATE=$gate"
        FAIL=$((FAIL+1)); RESULTS="$RESULTS\n  iter $i: GATE=$gate (unexpected)"
        release_seed_and_wait_ready
      fi
      ;;
  esac
  i=$((i+1))
done

log "SUMMARY ($MODE): $PASS ok / $FAIL not-ok over $REPEAT run(s)"
printf '%b\n' "$RESULTS"
log "Cluster left re-seeded + marketplace-ui resumed. Snapshot kept at: $SNAP_ROOT"
[ "$FAIL" -eq 0 ] || exit 1
