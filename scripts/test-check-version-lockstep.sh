#!/usr/bin/env bash
# Test harness for scripts/check-version-lockstep.sh. Run from the repo root:
#   nix-shell shell.nix --run 'bash scripts/test-check-version-lockstep.sh'
# Needs yq v4 on PATH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# Fresh fixture tree: two deployed apps in lockstep, one lockstep-marked chart.
new_tree() {
  T="$TMP/tree"; rm -rf "$T"
  mkdir -p "$T/scripts" "$T/infrastructure/system-apps" "$T/apps/foo" "$T/apps/nfs" "$T/apps/charted/base"
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
}

run() { ( cd "$T" && bash scripts/check-version-lockstep.sh ) 2>"$TMP/err" >"$TMP/out" && RC=0 || RC=$?; }
expect_fail() { # <label> <stderr pattern>
  local label="$1" pat="$2"
  run
  [ "$RC" -eq 1 ] || fail "$label: expected exit 1, got $RC ($(cat "$TMP/err"))"
  grep -q -- "$pat" "$TMP/err" || fail "$label: stderr lacks '$pat': $(cat "$TMP/err")"
}
edit() { yq -i "$1" "$T/$2"; }

all_pins_match_passes() {
  new_tree; run
  [ "$RC" -eq 0 ] && grep -q '^OK$' "$TMP/out" || fail "all_pins_match: exit $RC: $(cat "$TMP/err")"
}
deploy_pin_drift_fails() {
  new_tree; edit '.spec.ref.tag = "1.2.2"' infrastructure/system-apps/foo.yaml
  expect_fail deploy_pin_drift "deploys tag 1.2.2.*pins 1.2.3"
}
url_resolves_app_not_filename() {  # storage.yaml drift must name nfs, not storage
  new_tree; edit '.spec.ref.tag = "4.0.17"' infrastructure/system-apps/storage.yaml
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
  sed -i '/# lockstep:/d' "$T/apps/charted/base/ocirepository.yaml"
  edit '.spec.ref.tag = "3.0.0"' apps/charted/base/ocirepository.yaml
  run
  [ "$RC" -eq 0 ] || fail "unmarked_chart_drift: expected exit 0, got $RC: $(cat "$TMP/err")"
}

for t in all_pins_match_passes deploy_pin_drift_fails url_resolves_app_not_filename \
         missing_app_dir_fails missing_deploy_tag_fails unparseable_sysapp_fails \
         lockstep_chart_drift_fails unmarked_chart_drift_passes; do
  "$t"; echo "ok $t"
done
echo PASS
