#!/usr/bin/env bash
# Tests for scripts/publish-release.sh. Run from the repo root:
#   bash scripts/test-publish-release.sh
# Needs node, make, jq and git on PATH; docker, flux and cosign are shims that
# log their calls, so nothing touches a registry.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TMP.bin" "$TMP.log"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# Fixture: both self-built apps with every pin agreeing on the release version,
# plus an upstream app (gogs) whose pins agree too, so only the app check
# can refuse it.
mkdir -p "$TMP/scripts" "$TMP/ui" "$TMP/casdoor-sso-controller" "$TMP/infrastructure/system-apps"
cp "$REPO_ROOT/scripts/publish-release.sh" "$TMP/scripts/"
echo '{ "name": "marketplace-ui", "version": "0.16.0" }' > "$TMP/ui/package.json"
printf 'VERSION := 0.2.7\n\nprint-version:\n\t@echo $(VERSION)\n' > "$TMP/casdoor-sso-controller/Makefile"
for pair in marketplace-ui:0.16.0 casdoor-sso-controller:0.2.7 gogs:0.16.0; do
  app=${pair%:*} v=${pair#*:}
  mkdir -p "$TMP/apps/$app/overlays/librepod"
  printf 'metadata:\n  name: %s\nspec:\n  version: "%s"\n' "$app" "$v" > "$TMP/apps/$app/metadata.yaml"
  printf 'images:\n  - name: %s\n    newTag: "%s"\n' "$app" "$v" > "$TMP/apps/$app/overlays/librepod/kustomization.yaml"
  printf 'spec:\n  ref:\n    tag: "%s"\n' "$v" > "$TMP/infrastructure/system-apps/$app.yaml"
done
git -C "$TMP" init -q
git -C "$TMP" config user.email t@t && git -C "$TMP" config user.name t
git -C "$TMP" add -A && git -C "$TMP" commit -qm fixture
git -C "$TMP" remote add origin https://example.invalid/marketplace.git

# Shims. docker: `manifest inspect` succeeds only when FAKE_PUBLISHED is set;
# `buildx build` writes a digest to --metadata-file like buildx does. flux:
# echoes the pushed repository with a fixed digest.
export SHIM_LOG="$TMP.log"
mkdir -p "$TMP.bin"
cat > "$TMP.bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$SHIM_LOG"
if [ "$1" = manifest ]; then [ -n "${FAKE_PUBLISHED:-}" ]; exit; fi
while [ $# -gt 0 ]; do
  [ "$1" = --metadata-file ] && echo '{"containerimage.digest":"sha256:img"}' > "$2"
  shift
done
EOF
cat > "$TMP.bin/flux" <<'EOF'
#!/usr/bin/env bash
echo "flux $*" >> "$SHIM_LOG"
REPO=${3#oci://}
echo "{\"repository\":\"${REPO%:*}\",\"digest\":\"sha256:art\"}"
EOF
printf '#!/usr/bin/env bash\necho "cosign $*" >> "$SHIM_LOG"\n' > "$TMP.bin/cosign"
chmod +x "$TMP.bin"/*

run() { : > "$SHIM_LOG"; PATH="$TMP.bin:$PATH" bash "$TMP/scripts/publish-release.sh" "$@"; }
pushed() { grep -qE 'buildx|flux push|cosign' "$SHIM_LOG"; }
line_of() { grep -n -- "$1" "$SHIM_LOG" | head -1 | cut -d: -f1; }

# 1. Dry run: validates and names what it would publish, pushes nothing.
OUT="$(run release/marketplace-ui-v0.16.0)" || fail "dry run exited nonzero"
echo "$OUT" | grep -q 'ghcr.io/librepod/marketplace-ui:0.16.0' || fail "dry run did not name the image"
! pushed || fail "dry run pushed or signed"
echo "ok: dry run"

# 2. --push: image built from ui/ and signed, then the manifest pushed and
#    signed — only the :<version> tag, never :latest (master owns that).
run release/marketplace-ui-v0.16.0 --push >/dev/null || fail "--push exited nonzero"
grep -q -- '--push .*-t ghcr.io/librepod/marketplace-ui:0.16.0 ui$' "$SHIM_LOG" || fail "image not built from ui/ as :0.16.0"
grep -q 'cosign sign --key env://COSIGN_PRIVATE_KEY --yes ghcr.io/librepod/marketplace-ui@sha256:img' "$SHIM_LOG" \
  || fail "image not signed by digest"
grep -q 'flux push artifact oci://ghcr.io/librepod/marketplace/apps/marketplace-ui:0.16.0 --path=./apps/marketplace-ui' "$SHIM_LOG" \
  || fail "manifest not pushed as :0.16.0"
grep -q 'cosign sign --key env://COSIGN_PRIVATE_KEY --yes ghcr.io/librepod/marketplace/apps/marketplace-ui@sha256:art' "$SHIM_LOG" \
  || fail "manifest not signed by digest"
[ "$(line_of 'cosign sign .*marketplace-ui@')" -lt "$(line_of 'flux push')" ] || fail "manifest pushed before the image was signed"
! grep -q ':latest' "$SHIM_LOG" || fail "release must not touch :latest"
echo "ok: --push publishes image then manifest"

# 3. casdoor-sso-controller: built from its own dir, version from its Makefile.
run release/casdoor-sso-controller-v0.2.7 --push >/dev/null || fail "controller --push exited nonzero"
grep -q -- '-t ghcr.io/librepod/casdoor-sso-controller:0.2.7 casdoor-sso-controller$' "$SHIM_LOG" \
  || fail "controller image not built as :0.2.7"
grep -q 'flux push artifact oci://ghcr.io/librepod/marketplace/apps/casdoor-sso-controller:0.2.7 ' "$SHIM_LOG" \
  || fail "controller manifest not pushed as :0.2.7"
echo "ok: casdoor-sso-controller"

# 4. Refusals: nonzero exit and nothing pushed or signed.
refuses() { # <why> <args...>
  local why=$1; shift
  if run "$@" --push >/dev/null 2>&1; then fail "accepted: $why"; fi
  ! pushed || fail "pushed despite: $why"
  echo "ok: refuses $why"
}
refuses "an app we do not build" release/gogs-v0.16.0
refuses "a branch outside release/" marketplace-ui-v0.16.0
refuses "a non-semver version" release/marketplace-ui-vnext
sed -i 's/"0.16.0"/"0.16.1"/' "$TMP/apps/marketplace-ui/metadata.yaml" \
  "$TMP/apps/marketplace-ui/overlays/librepod/kustomization.yaml" "$TMP/infrastructure/system-apps/marketplace-ui.yaml"
refuses "pins the code does not match" release/marketplace-ui-v0.16.1
git -C "$TMP" checkout -q -- .

sed -i 's/newTag: "0.16.0"/newTag: "0.15.0"/' "$TMP/apps/marketplace-ui/overlays/librepod/kustomization.yaml"
refuses "a pin that missed the bump" release/marketplace-ui-v0.16.0
git -C "$TMP" checkout -q -- .

export FAKE_PUBLISHED=1
refuses "a version whose manifest is already published" release/marketplace-ui-v0.16.0
unset FAKE_PUBLISHED

echo "all publish-release tests passed"
