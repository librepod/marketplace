#!/usr/bin/env bash
# Tests for scripts/release-marketplace-ui.sh. Run from the repo root:
#   bash scripts/test-release-marketplace-ui.sh
# Needs node + npm on PATH; everything else runs in a throwaway git fixture
# with a bare "origin" so the tag guard and --push never touch the network.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# Fixture: a throwaway repo mirroring the five pin paths, with a bare origin.
mkdir -p "$TMP/scripts" "$TMP/ui" \
  "$TMP/apps/marketplace-ui/overlays/librepod" "$TMP/infrastructure/system-apps"
cp "$REPO_ROOT/scripts/release-marketplace-ui.sh" "$TMP/scripts/"
cat > "$TMP/ui/package.json" <<'EOF'
{ "name": "marketplace-ui", "version": "0.12.0", "private": true }
EOF
cat > "$TMP/ui/package-lock.json" <<'EOF'
{
  "name": "marketplace-ui",
  "version": "0.12.0",
  "lockfileVersion": 3,
  "packages": { "": { "name": "marketplace-ui", "version": "0.12.0" } }
}
EOF
printf 'metadata:\n  name: marketplace-ui\n  version: "0.12.0"\n' \
  > "$TMP/apps/marketplace-ui/metadata.yaml"
printf 'spec:\n  ref:\n    tag: "0.12.0"\n' \
  > "$TMP/infrastructure/system-apps/marketplace-ui.yaml"
printf 'images:\n  - name: ui\n    newTag: "0.12.0"\n' \
  > "$TMP/apps/marketplace-ui/overlays/librepod/kustomization.yaml"

git -C "$TMP" init -q
git -C "$TMP" config user.email t@t && git -C "$TMP" config user.name t
git -C "$TMP" add -A && git -C "$TMP" commit -qm fixture && git -C "$TMP" branch -M master
git init -q --bare "$TMP.origin.git" # outside the work tree, or the drift guard counts it
git -C "$TMP" remote add origin "$TMP.origin.git"
git -C "$TMP" push -q origin master

SCRIPT="$TMP/scripts/release-marketplace-ui.sh"
reset_tree() { git -C "$TMP" checkout -q -- .; git -C "$TMP" clean -qfd; }

# 1. Dry run: bumps all five pins, changes exactly five files, commits nothing.
OUT="$(bash "$SCRIPT" minor)" || fail "dry run exited nonzero"
echo "$OUT" | grep -q 0.13.0 || fail "dry run did not report 0.13.0"
[ "$(git -C "$TMP" status --porcelain | wc -l)" -eq 5 ] || fail "dry run: expected exactly 5 modified files"
grep -q 'version: "0.13.0"' "$TMP/apps/marketplace-ui/metadata.yaml" || fail "metadata.yaml pin"
grep -q 'tag: "0.13.0"' "$TMP/infrastructure/system-apps/marketplace-ui.yaml" || fail "infra pin"
grep -q 'newTag: "0.13.0"' "$TMP/apps/marketplace-ui/overlays/librepod/kustomization.yaml" || fail "overlay pin"
[ "$(git -C "$TMP" log --oneline | wc -l)" -eq 1 ] || fail "dry run must not commit"
echo "ok: dry run"

# 2. --push: commit, master push, and annotated tag all land on origin.
reset_tree
bash "$SCRIPT" patch --push >/dev/null || fail "--push exited nonzero"
[ -z "$(git -C "$TMP" status --porcelain)" ] || fail "--push left a dirty tree"
[ "$(git -C "$TMP" rev-parse master)" = "$(git -C "$TMP.origin.git" rev-parse master)" ] \
  || fail "master not pushed to origin"
git -C "$TMP.origin.git" tag | grep -qx marketplace-ui-v0.12.1 || fail "tag not pushed"
git -C "$TMP" log -1 --format=%s | grep -qx 'release(marketplace-ui): v0.12.1' || fail "commit subject"
echo "ok: --push"

# 3. Tag guard: refuses when the target tag already exists on origin.
reset_tree
git -C "$TMP" tag marketplace-ui-v0.12.2 && git -C "$TMP" push -q origin marketplace-ui-v0.12.2
if OUT="$(bash "$SCRIPT" patch 2>&1)"; then fail "tag guard did not refuse"; fi
echo "$OUT" | grep -q "already exists" || fail "tag guard message missing"
echo "ok: tag guard"

# 4. Drift guard: refuses when anything beyond the five pins changed.
reset_tree
echo stray > "$TMP/STRAY.md" && git -C "$TMP" add STRAY.md
if OUT="$(bash "$SCRIPT" minor 2>&1)"; then fail "drift guard did not refuse"; fi
echo "$OUT" | grep -q "exactly the five pin files" || fail "drift guard message missing"
echo "ok: drift guard"

echo "PASS: release-marketplace-ui.sh"
