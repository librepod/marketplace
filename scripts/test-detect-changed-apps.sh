#!/usr/bin/env bash
# Test harness for scripts/detect-changed-apps.sh. Run from the repo root:
#   nix-shell shell.nix --run 'bash scripts/test-detect-changed-apps.sh'
# Needs jq on PATH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

T="$TMP/tree"
mkdir -p "$T/scripts" "$T/apps/foo/overlays/librepod" "$T/apps/bar/overlays/librepod" \
         "$T/apps/nfs/overlays/librepod" "$T/infrastructure/system-apps"
cp "$REPO_ROOT/scripts/detect-changed-apps.sh" "$T/scripts/"
for a in foo bar nfs; do printf 'spec:\n  version: "1.0.0"\n' > "$T/apps/$a/metadata.yaml"; done

# Multi-doc: one file deploying two apps — both must resolve.
cat > "$T/infrastructure/system-apps/storage.yaml" <<'EOF'
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
spec:
  url: oci://ghcr.io/librepod/marketplace/apps/nfs
  ref:
    tag: "1.0.0"
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
spec:
  url: oci://ghcr.io/librepod/marketplace/apps/bar
  ref:
    tag: "1.0.0"
EOF
cat > "$T/infrastructure/system-apps/catalog.yaml" <<'EOF'
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
spec:
  url: oci://ghcr.io/librepod/marketplace/catalog
  ref:
    tag: latest
EOF

G="git -c user.name=t -c user.email=t@t"
( cd "$T" && git init -q && $G add -A && $G commit -qm base )
BASE=$( cd "$T" && git rev-parse HEAD )

# Mixed change: an apps/ edit plus a multi-doc system-apps pin bump (both apps
# resolved from URLs, not the filename) must all land in the matrix.
( cd "$T" && sed -i 's/1.0.0/1.1.0/' infrastructure/system-apps/storage.yaml &&
  printf 'x\n' >> apps/foo/metadata.yaml && $G add -A && $G commit -qm change )
out=$( cd "$T" && bash scripts/detect-changed-apps.sh "$BASE" )
[ "$out" = '["bar","foo","nfs"]' ] || fail "mixed change: expected [\"bar\",\"foo\",\"nfs\"], got: $out"

# A non-app system-apps edit (catalog) maps to nothing.
BASE=$( cd "$T" && git rev-parse HEAD )
( cd "$T" && sed -i 's/latest/v2/' infrastructure/system-apps/catalog.yaml && $G add -A && $G commit -qm catalog )
out=$( cd "$T" && bash scripts/detect-changed-apps.sh "$BASE" )
[ "$out" = '[]' ] || fail "catalog-only change: expected [], got: $out"

echo PASS
