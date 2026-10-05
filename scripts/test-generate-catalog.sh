#!/usr/bin/env bash
# Test harness for scripts/generate-catalog.sh. Run from the repo root:
#   bash scripts/test-generate-catalog.sh
# Needs `npm install` in ui/ (parses the output with ui/node_modules/js-yaml).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JS_YAML="$REPO_ROOT/ui/node_modules/js-yaml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# The generator derives REPO_ROOT from its own location, so run a copy inside a
# throwaway tree that holds only the fixture app.
mkdir -p "$TMP/scripts" "$TMP/apps/demo/overlays/librepod"
cp "$REPO_ROOT/scripts/generate-catalog.sh" "$TMP/scripts/"
cat > "$TMP/apps/demo/metadata.yaml" <<'EOF'
apiVersion: marketplace/v1
kind: AppDefinition
metadata:
  name: demo
spec:
  displayName: "Demo"
  description: "Demo app"
  icon: "https://example.com/demo.png"
  category: "Testing"
  version: "1.2.3"

  source:
    type: oci-kustomize
    url: "oci://ghcr.io/librepod/marketplace/apps/demo"
    path: ./overlays/librepod

  settings:
    allowCustom: true
    items:
      - name: DEMO_TOKEN
        label: "Access token"
        description: "Token: with a colon"
        sensitive: true
        required: true
      - name: DEMO_ENABLED
        type: boolean
        default: false
      - name: DEMO_LEVEL
        options: [low, high]
        default: low

  dependencies: []

  templates:
    source: |
      apiVersion: source.toolkit.fluxcd.io/v1
      kind: OCIRepository
      metadata:
        name: marketplace-demo
      spec:
        ref:
          tag: "__VERSION__"
    release: |
      apiVersion: kustomize.toolkit.fluxcd.io/v1
      kind: Kustomization
      metadata:
        name: marketplace-demo
    kustomization: |
      apiVersion: kustomize.config.k8s.io/v1beta1
      kind: Kustomization
      resources:
        - source.yaml
        - release.yaml
EOF

echo "== test 1: settings pass through to catalog.yaml unchanged =="
bash "$TMP/scripts/generate-catalog.sh" >/dev/null || fail "generator exited non-zero"
node -e '
  const yaml = require(process.argv[1]);
  const cat = yaml.load(require("fs").readFileSync(process.argv[2], "utf8"));
  const app = cat.apps.find((a) => a.name === "demo");
  const want = {
    allowCustom: true,
    items: [
      { name: "DEMO_TOKEN", label: "Access token", description: "Token: with a colon", sensitive: true, required: true },
      { name: "DEMO_ENABLED", type: "boolean", default: false },
      { name: "DEMO_LEVEL", options: ["low", "high"], default: "low" },
    ],
  };
  if (JSON.stringify(app.settings) !== JSON.stringify(want)) {
    console.error("got:  " + JSON.stringify(app.settings));
    console.error("want: " + JSON.stringify(want));
    process.exit(1);
  }
  if (!app.templates.source.includes("1.2.3")) process.exit(2);
' "$JS_YAML" "$TMP/catalog.yaml" || fail "settings block not passed through verbatim"
echo "PASS test 1"

echo "== test 2: an app without settings gets no settings key =="
sed -i '/^  settings:/,/^  dependencies:/{/^  dependencies:/!d}' "$TMP/apps/demo/metadata.yaml"
bash "$TMP/scripts/generate-catalog.sh" >/dev/null || fail "generator exited non-zero"
node -e '
  const yaml = require(process.argv[1]);
  const cat = yaml.load(require("fs").readFileSync(process.argv[2], "utf8"));
  if ("settings" in cat.apps[0]) process.exit(1);
' "$JS_YAML" "$TMP/catalog.yaml" || fail "settings key appeared for an app without settings"
echo "PASS test 2"
