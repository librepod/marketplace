#!/usr/bin/env bash
# Guard for the casdoor probe postRender patch (issue #366).
#
# The chart (casdoor-helm-charts) ships a liveness probe with no startup
# allowance; the overlay's postRenderers patch adds a startupProbe + /api/health
# probes. A postRender patch that stops matching the chart's rendered output is
# SILENTLY IGNORED — e.g. a Renovate chart bump that renames the deployment or
# container — and the first-install DB-corruption bug (#366) comes back with no
# failing signal, because already-initialized installs look fine.
#
# This script renders the pinned chart with the overlay's exact values, applies
# the postRender patch the way helm-controller does, and asserts the invariant:
# the casdoor Deployment must end up with a /api/health startup probe (>= 5 min
# budget). If the postRenderers block is ever deleted because the chart ships
# the fix natively (casdoor/casdoor@6121c737), the chart render itself must
# satisfy the same invariant — so the guard stays valid in both states.
#
# Run: bash scripts/test-casdoor-probe-patch.sh   (needs network: helm pull)
set -euo pipefail
cd "$(dirname "$0")/.."

APP_DIR=apps/casdoor
OVERLAY=$APP_DIR/overlays/librepod
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

command -v helm >/dev/null || fail "helm not on PATH"
command -v kustomize >/dev/null || fail "kustomize not on PATH"
command -v kubectl >/dev/null || fail "kubectl not on PATH"
command -v yq >/dev/null || fail "yq not on PATH"

CHART_URL=$(yq -r '.spec.url' "$APP_DIR/base/ocirepository.yaml")
CHART_VER=$(yq -r '.spec.ref.tag' "$APP_DIR/base/ocirepository.yaml")
[ "$CHART_URL" != "null" ] && [ "$CHART_VER" != "null" ] || fail "cannot read chart pin from $APP_DIR/base/ocirepository.yaml"

echo "== pulling chart $CHART_URL:$CHART_VER =="
helm pull "$CHART_URL" --version "$CHART_VER" -d "$TMP" >/dev/null
tar -xzf "$TMP"/*.tgz -C "$TMP"
CHART_DIR=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)

echo "== rendering overlay =="
kustomize build "$OVERLAY" > "$TMP/overlay.yaml"
yq 'select(.kind=="HelmRelease") | .spec.values' "$TMP/overlay.yaml" > "$TMP/values.yaml"

echo "== helm template with overlay values =="
helm template casdoor "$CHART_DIR" -f "$TMP/values.yaml" \
  --show-only templates/deployment.yaml > "$TMP/rendered.yaml"
[ -s "$TMP/rendered.yaml" ] || fail "chart did not render templates/deployment.yaml"

# Apply the postRender patch if the overlay still carries one.
if yq -e 'select(.kind=="HelmRelease") | .spec.postRenderers' "$TMP/overlay.yaml" >/dev/null 2>&1 \
   && [ "$(yq 'select(.kind=="HelmRelease") | .spec.postRenderers | length' "$TMP/overlay.yaml")" != "0" ]; then
  echo "== applying postRender patch (strategic merge, as helm-controller does) =="
  yq -r 'select(.kind=="HelmRelease") | .spec.postRenderers[0].kustomize.patches[0].patch' \
    "$TMP/overlay.yaml" > "$TMP/smp.yaml"
  TARGET_NAME=$(yq -r 'select(.kind=="HelmRelease") | .spec.postRenderers[0].kustomize.patches[0].target.name' "$TMP/overlay.yaml")
  RENDERED_NAME=$(yq -r '.metadata.name' "$TMP/rendered.yaml")
  [ "$TARGET_NAME" = "$RENDERED_NAME" ] \
    || fail "postRender target name '$TARGET_NAME' != rendered deployment '$RENDERED_NAME' — patch would dangle"
  kubectl patch --local -f "$TMP/rendered.yaml" --type strategic \
    --patch-file "$TMP/smp.yaml" -o yaml > "$TMP/merged.yaml"
else
  echo "== no postRenderers block — chart must ship native probes =="
  cp "$TMP/rendered.yaml" "$TMP/merged.yaml"
fi

echo "== asserting probe invariant =="
# A strategic-merge container entry that misses the real container name gets
# APPENDED as a new container instead of merged — assert there is still exactly one.
CONTAINERS=$(yq '.spec.template.spec.containers | length' "$TMP/merged.yaml")
[ "$CONTAINERS" = "1" ] || fail "expected 1 container after patch, got $CONTAINERS (patch container name no longer matches the chart's?)"

check_probe() { # $1=probe name, $2=min failureThreshold
  local path threshold
  path=$(yq -r ".spec.template.spec.containers[0].$1.httpGet.path" "$TMP/merged.yaml")
  threshold=$(yq ".spec.template.spec.containers[0].$1.failureThreshold" "$TMP/merged.yaml")
  [ "$path" = "/api/health" ] || fail "$1 path is '$path', expected /api/health"
  [ "$threshold" -ge "$2" ] || fail "$1 failureThreshold $threshold < $2"
  echo "  $1: /api/health, failureThreshold=$threshold"
}
check_probe startupProbe 30
check_probe livenessProbe 1
check_probe readinessProbe 1

# The probe port is a NAME; assert it still resolves to a declared container port.
PORT_NAME=$(yq -r '.spec.template.spec.containers[0].startupProbe.httpGet.port' "$TMP/merged.yaml")
yq -e ".spec.template.spec.containers[0].ports[] | select(.name == \"$PORT_NAME\")" "$TMP/merged.yaml" >/dev/null \
  || fail "probe port '$PORT_NAME' matches no declared container port"

echo "PASS: casdoor deployment renders with a /api/health startup probe (>= 5 min budget)"
