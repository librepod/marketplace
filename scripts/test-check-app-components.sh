#!/usr/bin/env bash
# Test harness for scripts/check-app-components.sh. Run from the repo root:
#   nix-shell shell.nix --run 'bash scripts/test-check-app-components.sh'
# Needs yq v4 and kustomize on PATH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

ANN='librepod.org/component-target'

# Fresh fixture tree: one patch component, one resource component, two apps.
new_tree() {
  T="$TMP/tree"; rm -rf "$T"
  mkdir -p "$T/scripts" "$T/components/side" "$T/components/res"
  cp "$REPO_ROOT/scripts/check-app-components.sh" "$T/scripts/"

  cat > "$T/components/side/component.yaml" <<'EOF'
apiVersion: marketplace/v1
kind: ComponentDefinition
metadata:
  name: side
spec:
  displayName: "Side"
  description: "Side"
  version: "v1.0.0"
  kind: patch
EOF
  cat > "$T/components/side/kustomization.yaml" <<'EOF'
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
images:
  - name: busybox
    newTag: v1.0.0
patches:
  - target:
      kind: Deployment
      annotationSelector: librepod.org/component-target=true
    patch: |-
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: placeholder
      spec:
        template:
          spec:
            containers:
              - name: side
                image: busybox
EOF

  cat > "$T/components/res/component.yaml" <<'EOF'
apiVersion: marketplace/v1
kind: ComponentDefinition
metadata:
  name: res
spec:
  displayName: "Res"
  description: "Res"
  version: "1.0.0"
  kind: resource
  values:
    - name: RES_HOST
      from: app
    - name: RES_NAME
      from: install
      default: "{app}"
      pattern: "^[a-z]+$"
EOF
  cat > "$T/components/res/kustomization.yaml" <<'EOF'
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
resources:
  - cm.yaml
EOF
  cat > "$T/components/res/cm.yaml" <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: res
data:
  host: ${RES_HOST:=x}
  name: ${RES_NAME:=y}
EOF

  mkapp demo "$ANN" "  components:
    - name: side
    - name: res
      values:
        RES_HOST: h"
  # sibling: second Deployment, never annotated
  cat >> "$T/apps/demo/base/deployment.yaml" <<'EOF'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sibling
spec:
  selector: {matchLabels: {a: s}}
  template:
    metadata: {labels: {a: s}}
    spec:
      containers:
        - name: main
          image: busybox
EOF
  mkapp bare "" "  components:
    - name: side"
}

# mkapp <name> <annotation-key or ""> <components block>
mkapp() {
  local d="$T/apps/$1"
  mkdir -p "$d/base" "$d/overlays/librepod"
  {
    echo "apiVersion: apps/v1"; echo "kind: Deployment"; echo "metadata:"; echo "  name: $1"
    [ -n "$2" ] && { echo "  annotations:"; echo "    $2: \"true\""; }
    cat <<'EOF'
spec:
  selector: {matchLabels: {a: m}}
  template:
    metadata: {labels: {a: m}}
    spec:
      containers:
        - name: main
          image: busybox
EOF
  } > "$d/base/deployment.yaml"
  printf 'resources:\n  - deployment.yaml\n' > "$d/base/kustomization.yaml"
  printf 'resources:\n  - ../../base\n' > "$d/overlays/librepod/kustomization.yaml"
  cat > "$d/metadata.yaml" <<EOF
apiVersion: marketplace/v1
kind: AppDefinition
metadata:
  name: $1
spec:
  version: "1"
$3
EOF
}

run() { ( cd "$T" && bash scripts/check-app-components.sh "$@" ) 2>"$TMP/err" >"$TMP/out" && RC=0 || RC=$?; }
expect_fail() { # <label> <stderr pattern> args...
  local label="$1" pat="$2"; shift 2
  run "$@"
  [ "$RC" -eq 1 ] || fail "$label: expected exit 1, got $RC ($(cat "$TMP/err"))"
  grep -q -- "$pat" "$TMP/err" || fail "$label: stderr lacks '$pat': $(cat "$TMP/err")"
}

demo_passes() {
  new_tree; run demo
  [ "$RC" -eq 0 ] || fail "demo_passes: exit $RC: $(cat "$TMP/err")"
}

sibling_untouched() {
  new_tree
  local b="$TMP/build"; rm -rf "$b"; cp -r "$T/apps/demo" "$b"; mkdir -p "$b/shared-components"
  cp -r "$T/components/side" "$b/shared-components/side"
  yq -i '.components += ["../../shared-components/side"]' "$b/overlays/librepod/kustomization.yaml"
  local out; out=$(kustomize build "$b/overlays/librepod" | yq 'select(.metadata.name=="sibling") | .spec.template.spec.containers[].name')
  grep -q side <<<"$out" && fail "sibling_untouched: sibling gained side"
  kustomize build "$b/overlays/librepod" | yq 'select(.metadata.name=="demo") | .spec.template.spec.containers[].name' | grep -q side \
    || fail "sibling_untouched: demo did not gain side"
  return 0
}

missing_target_fails() { new_tree; expect_fail missing_target "FAIL bare/side" bare; }
missing_app_value_fails() {
  new_tree; yq -i 'del(.spec.components[1].values.RES_HOST)' "$T/apps/demo/metadata.yaml"
  expect_fail missing_app_value RES_HOST demo
}
undeclared_value_fails() {
  new_tree; yq -i '.spec.components[0].values.NOPE = "x"' "$T/apps/demo/metadata.yaml"
  expect_fail undeclared_value NOPE demo
}
unanchored_pattern_fails() {
  new_tree; yq -i '.spec.values[1].pattern = "[a-z]+"' "$T/components/res/component.yaml"
  expect_fail unanchored_pattern pattern demo
}
reserved_name_fails() {
  new_tree; yq -i '.spec.values[1].name = "INSTANCE_NAME"' "$T/components/res/component.yaml"
  expect_fail reserved_name "reserved" demo
}
var_without_default_fails() {
  new_tree; sed -i 's/\${RES_HOST:=x}/${RES_HOST}/' "$T/components/res/cm.yaml"
  expect_fail var_without_default default demo
}
substitute_disabled_fails() {
  new_tree; yq -i '.metadata.annotations["kustomize.toolkit.fluxcd.io/substitute"] = "disabled"' \
    "$T/apps/demo/base/deployment.yaml"
  run demo
  # yq on a multi-doc file: only the first doc (demo) should be edited
  [ "$RC" -eq 1 ] || fail "substitute_disabled: expected exit 1, got $RC"
}
two_targets_fail() {
  new_tree
  yq -i 'select(.metadata.name=="sibling").metadata.annotations["librepod.org/component-target"] = "true"' \
    "$T/apps/demo/base/deployment.yaml"
  run demo
  [ "$RC" -eq 1 ] || fail "two_targets: expected exit 1, got $RC"
}

for t in demo_passes sibling_untouched missing_target_fails missing_app_value_fails \
         undeclared_value_fails unanchored_pattern_fails reserved_name_fails \
         var_without_default_fails substitute_disabled_fails two_targets_fail; do
  "$t"; echo "ok $t"
done
echo PASS
