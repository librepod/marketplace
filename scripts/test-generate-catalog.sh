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

echo "== test 3: flow-style settings on the key line pass through =="
# test 2 left the fixture without settings; add them back inline.
sed -i 's/^  dependencies: \[\]/  settings: { allowCustom: true, items: [{ name: DEMO_X, default: "a" }] }  # inline\n\n  dependencies: []/' \
  "$TMP/apps/demo/metadata.yaml"
bash "$TMP/scripts/generate-catalog.sh" >/dev/null || fail "generator exited non-zero"
node -e '
  const yaml = require(process.argv[1]);
  const cat = yaml.load(require("fs").readFileSync(process.argv[2], "utf8"));
  const want = { allowCustom: true, items: [{ name: "DEMO_X", default: "a" }] };
  if (JSON.stringify(cat.apps[0].settings) !== JSON.stringify(want)) {
    console.error("got:  " + JSON.stringify(cat.apps[0].settings));
    process.exit(1);
  }
' "$JS_YAML" "$TMP/catalog.yaml" || fail "flow-style settings were dropped"
echo "PASS test 3"

echo "== test 4: blank lines inside a block-scalar description survive =="
sed -i '/^  settings:/d' "$TMP/apps/demo/metadata.yaml"
awk '/^  dependencies:/ {
  print "  settings:"
  print "    items:"
  print "      - name: DEMO_NOTE"
  print "        description: |"
  print "          First paragraph."
  print ""
  print "          Second paragraph."
  print ""
} { print }' "$TMP/apps/demo/metadata.yaml" > "$TMP/metadata.new" && mv "$TMP/metadata.new" "$TMP/apps/demo/metadata.yaml"
bash "$TMP/scripts/generate-catalog.sh" >/dev/null || fail "generator exited non-zero"
node -e '
  const yaml = require(process.argv[1]);
  const cat = yaml.load(require("fs").readFileSync(process.argv[2], "utf8"));
  const got = cat.apps[0].settings.items[0].description;
  if (got !== "First paragraph.\n\nSecond paragraph.\n") {
    console.error("got: " + JSON.stringify(got));
    process.exit(1);
  }
' "$JS_YAML" "$TMP/catalog.yaml" || fail "paragraph break in a settings description was lost"
echo "PASS test 4"

echo "== test 5: a params block in metadata.yaml is ignored (params are gone from the catalog) =="
sed -i 's/^  dependencies: \[\]/  params:\n    required:\n      - name: BASE_DOMAIN\n        description: Base domain\n        type: string\n        example: example.com\n\n  dependencies: []/' \
  "$TMP/apps/demo/metadata.yaml"
bash "$TMP/scripts/generate-catalog.sh" >/dev/null || fail "generator exited non-zero"
node -e '
  const fs = require("fs");
  const yaml = require(process.argv[1]);
  const file = process.argv[2];
  const cat = yaml.load(fs.readFileSync(file, "utf8"));
  if ("params" in cat.apps[0]) process.exit(1);
  if (fs.readFileSync(file, "utf8").includes("params")) process.exit(2);
' "$JS_YAML" "$TMP/catalog.yaml" || fail "params leaked into catalog.yaml"
echo "PASS test 5"

echo "== test 6: components map and per-app opt-ins =="
mkdir -p "$TMP/components/demo-net"
cat > "$TMP/components/demo-net/component.yaml" <<'EOF'
apiVersion: marketplace/v1
kind: ComponentDefinition
metadata:
  name: demo-net
spec:
  displayName: "Demo net"
  description: "Demo component"
  # renovate: datasource=docker depName=demo/net
  version: "v1.0.0"
  group: network
  kind: patch
  settings:
    - name: DEMO_KEY
      type: text
      sensitive: true
  values:
    - name: DEMO_HOST
      from: app
    - name: DEMO_NAME
      from: install
      default: "{app}"
      pattern: "^[a-z]+$"
EOF
sed -i 's/^  dependencies: \[\]/  components:\n    - name: demo-net\n      values:\n        DEMO_HOST: demo.svc\n\n  dependencies: []/' \
  "$TMP/apps/demo/metadata.yaml"
bash "$TMP/scripts/generate-catalog.sh" >/dev/null || fail "generator exited non-zero"
node -e '
  const yaml = require(process.argv[1]);
  const cat = yaml.load(require("fs").readFileSync(process.argv[2], "utf8"));
  const c = cat.components["demo-net"];
  if (c.version !== "v1.0.0") { console.error("version " + c.version); process.exit(1); }
  if (c.values[1].default !== "{app}") process.exit(2);
  if (c.settings[0].name !== "DEMO_KEY") process.exit(3);
  const app = cat.apps[0];
  if (JSON.stringify(app.components) !== JSON.stringify([{ name: "demo-net", values: { DEMO_HOST: "demo.svc" } }])) {
    console.error("app.components " + JSON.stringify(app.components)); process.exit(4);
  }
  if (JSON.stringify(app.settings) !== JSON.stringify({ allowCustom: true, items: [{ name: "DEMO_X", default: "a" }] }) && !app.settings) process.exit(5);
' "$JS_YAML" "$TMP/catalog.yaml" || fail "components not emitted as expected"
echo "PASS test 6"

echo "== test 7: an app listing an unknown component fails generation =="
sed -i 's/- name: demo-net/- name: ghost/' "$TMP/apps/demo/metadata.yaml"
if bash "$TMP/scripts/generate-catalog.sh" >/dev/null 2>"$TMP/err"; then
  fail "generator accepted an unknown component"
fi
grep -q 'unknown component "ghost"' "$TMP/err" || fail "stderr lacks the unknown-component error: $(cat "$TMP/err")"
echo "PASS test 7"
