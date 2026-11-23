#!/usr/bin/env bash
# Test harness for scripts/check-version-lockstep.sh. Run from the repo root:
#   nix-shell shell.nix --run 'bash scripts/test-check-version-lockstep.sh'
# Needs yq v4 on PATH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# Fresh fixture tree: two deployed apps in lockstep, one lockstep-marked chart,
# one unmarked independently-versioned chart (the fixture's EXPECTED list is
# "charted", injected by run()).
new_tree() {
  T="$TMP/tree"; rm -rf "$T"
  mkdir -p "$T/scripts" "$T/infrastructure/system-apps" "$T/apps/foo" "$T/apps/nfs" "$T/apps/charted/base" "$T/apps/loose/base"
  cp "$REPO_ROOT/scripts/check-version-lockstep.sh" "$T/scripts/"

  mkmeta() { # <app> <version>
    cat > "$T/apps/$1/metadata.yaml" <<EOF
apiVersion: marketplace/v1
kind: AppDefinition
metadata:
  name: $1
spec:
  version: "$2"
EOF
  }
  mkmeta foo 1.2.3
  mkmeta nfs 4.0.18
  mkmeta charted 2.0.0
  mkmeta loose 4.9.0

  mksysapp() { # <file> <name> <url-suffix> <tag>
    cat > "$T/infrastructure/system-apps/$1.yaml" <<EOF
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: $2
  namespace: flux-system
spec:
  interval: 10m
  url: oci://ghcr.io/librepod/marketplace/apps/$3
  ref:
    tag: "$4"
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: $2
  namespace: flux-system
spec:
  sourceRef:
    kind: OCIRepository
    name: $2
EOF
  }
  mksysapp foo foo foo 1.2.3
  mksysapp storage storage nfs 4.0.18   # filename != app: resolved from the URL

  # Non-app OCIRepository (the catalog) and the kustomization must be ignored.
  cat > "$T/infrastructure/system-apps/marketplace-catalog.yaml" <<'EOF'
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: marketplace-catalog
spec:
  url: oci://ghcr.io/librepod/marketplace/catalog
  ref:
    tag: latest
EOF
  printf 'resources:\n  - foo.yaml\n' > "$T/infrastructure/system-apps/kustomization.yaml"

  cat > "$T/apps/charted/base/ocirepository.yaml" <<'EOF'
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: charted-helm-charts
spec:
  interval: 24h
  url: oci://registry-1.docker.io/example/charted-helm-charts
  ref:
    # lockstep: chart is tagged from the app release; must equal spec.version
    tag: "2.0.0"
EOF

  # Unmarked, independently versioned chart: drift here must stay legal.
  cat > "$T/apps/loose/base/ocirepository.yaml" <<'EOF'
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: loose-helm-charts
spec:
  interval: 24h
  url: oci://registry-1.docker.io/example/loose-helm-charts
  ref:
    tag: "5.0.0"
EOF
}

run() { ( cd "$T" && EXPECTED_LOCKSTEP_APPS=charted bash scripts/check-version-lockstep.sh ) 2>"$TMP/err" >"$TMP/out" && RC=0 || RC=$?; }
expect_fail() { # <label> <stderr pattern>
  local label="$1" pat="$2"
  run
  [ "$RC" -eq 1 ] || fail "$label: expected exit 1, got $RC ($(cat "$TMP/err"))"
  grep -q -- "$pat" "$TMP/err" || fail "$label: stderr lacks '$pat': $(cat "$TMP/err")"
}
edit() { yq -i "$1" "$T/$2"; }
gitify() { # <iso-date> — fixture becomes a git repo; drift age reads from this commit
  ( cd "$T" && git init -q && git -c user.name=t -c user.email=t@t add -A &&
    GIT_COMMITTER_DATE="$1" GIT_AUTHOR_DATE="$1" git -c user.name=t -c user.email=t@t commit -qm fixture )
}

all_pins_match_passes() {
  new_tree; run
  [ "$RC" -eq 0 ] && grep -q '^OK$' "$TMP/out" || fail "all_pins_match: exit $RC: $(cat "$TMP/err")"
}
deploy_pin_drift_without_git_warns() {  # no history: age unknowable → warn, not fail
  new_tree; edit '.spec.ref.tag = "1.2.2"' infrastructure/system-apps/foo.yaml
  run
  [ "$RC" -eq 0 ] || fail "drift_without_git: expected exit 0, got $RC ($(cat "$TMP/err"))"
  grep -q '::warn.*deploys tag 1.2.2.*pins 1.2.3' "$TMP/err" || fail "drift_without_git: no warn: $(cat "$TMP/err")"
}
deploy_pin_drift_fresh_warns() {  # 13d-old bump: inside the 14d grace → warn only
  new_tree; edit '.spec.ref.tag = "1.2.2"' infrastructure/system-apps/foo.yaml
  gitify "$(date -d '-13 days' --iso-8601=seconds)"
  run
  [ "$RC" -eq 0 ] || fail "drift_fresh: expected exit 0, got $RC ($(cat "$TMP/err"))"
  grep -q '::warn' "$TMP/err" || fail "drift_fresh: no warn: $(cat "$TMP/err")"
}
deploy_pin_drift_stale_fails() {  # 15d-old bump: past the 14d grace → fail
  new_tree; edit '.spec.ref.tag = "1.2.2"' infrastructure/system-apps/foo.yaml
  gitify "$(date -d '-15 days' --iso-8601=seconds)"
  expect_fail deploy_pin_drift_stale "deploys tag 1.2.2.*drift is [0-9]*d old"
}
url_resolves_app_not_filename() {  # storage.yaml drift must name nfs, not storage
  new_tree; edit '.spec.ref.tag = "4.0.17"' infrastructure/system-apps/storage.yaml
  gitify "$(date -d '-300 days' --iso-8601=seconds)"
  expect_fail url_resolves_app "nfs: deploys tag 4.0.17"
}
missing_app_dir_fails() {
  new_tree; edit '.spec.url = "oci://ghcr.io/librepod/marketplace/apps/ghost"' infrastructure/system-apps/foo.yaml
  expect_fail missing_app_dir "apps/ghost/metadata.yaml does not exist"
}
missing_deploy_tag_fails() {
  new_tree; edit 'del(.spec.ref.tag)' infrastructure/system-apps/foo.yaml
  expect_fail missing_deploy_tag "no ref.tag"
}
unparseable_sysapp_fails() {
  new_tree; printf 'spec: [broken\n' > "$T/infrastructure/system-apps/broken.yaml"
  expect_fail unparseable_sysapp "cannot parse YAML"
}
lockstep_chart_drift_fails() {
  new_tree; edit '.spec.ref.tag = "2.0.1"' apps/charted/base/ocirepository.yaml
  expect_fail lockstep_chart_drift "chart tag 2.0.1 != .*spec.version 2.0.0"
}
unmarked_chart_drift_passes() {
  new_tree
  edit '.spec.ref.tag = "6.0.0"' apps/loose/base/ocirepository.yaml
  run
  [ "$RC" -eq 0 ] || fail "unmarked_chart_drift: expected exit 0, got $RC: $(cat "$TMP/err")"
}
marker_lost_from_listed_app_fails() {  # fail-open mode: the marker vanished
  new_tree
  sed -i '/# lockstep:/d' "$T/apps/charted/base/ocirepository.yaml"
  expect_fail marker_lost "a marker was lost"
}
marker_added_outside_list_fails() {  # new lockstep app must join the list
  new_tree
  mkdir -p "$T/apps/other/base"
  sed 's/charted/other/g' "$T/apps/charted/base/ocirepository.yaml" > "$T/apps/other/base/ocirepository.yaml"
  expect_fail marker_added "or added"
}

for t in all_pins_match_passes deploy_pin_drift_without_git_warns \
         deploy_pin_drift_fresh_warns deploy_pin_drift_stale_fails \
         url_resolves_app_not_filename \
         missing_app_dir_fails missing_deploy_tag_fails unparseable_sysapp_fails \
         lockstep_chart_drift_fails unmarked_chart_drift_passes \
         marker_lost_from_listed_app_fails marker_added_outside_list_fails; do
  "$t"; echo "ok $t"
done
echo PASS
