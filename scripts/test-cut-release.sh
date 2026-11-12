#!/usr/bin/env bash
# Tests for scripts/cut-release.sh. Run from the repo root:
#   bash scripts/test-cut-release.sh
# Needs node, npm and make on PATH; everything else runs in a throwaway git
# fixture with a bare "origin" and a gh shim on PATH so the tag guard and --pr
# never touch the network.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TMP.origin.git" "$TMP.bin" "$TMP.gh-calls" "$TMP.pr-list"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# Fixture: a throwaway repo mirroring both self-built apps' version files, with
# a bare origin.
mkdir -p "$TMP/scripts" "$TMP/ui" "$TMP/casdoor-sso-controller" "$TMP/infrastructure/system-apps"
cp "$REPO_ROOT/scripts/cut-release.sh" "$TMP/scripts/"
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
printf 'VERSION := 0.2.6\n\nprint-version:\n\t@echo $(VERSION)\n' > "$TMP/casdoor-sso-controller/Makefile"
for pair in marketplace-ui:0.12.0 casdoor-sso-controller:0.2.6; do
  app=${pair%:*} v=${pair#*:}
  mkdir -p "$TMP/apps/$app/overlays/librepod"
  printf 'metadata:\n  name: %s\n  version: "%s"\n' "$app" "$v" > "$TMP/apps/$app/metadata.yaml"
  printf 'spec:\n  ref:\n    tag: "%s"\n' "$v" > "$TMP/infrastructure/system-apps/$app.yaml"
  printf 'images:\n  - name: %s\n    newTag: "%s"\n' "$app" "$v" > "$TMP/apps/$app/overlays/librepod/kustomization.yaml"
done

git -C "$TMP" init -q
git -C "$TMP" config user.email t@t && git -C "$TMP" config user.name t
git -C "$TMP" add -A && git -C "$TMP" commit -qm fixture && git -C "$TMP" branch -M master
git init -q --bare "$TMP.origin.git" # outside the work tree, or the drift guard counts it
git -C "$TMP" remote add origin "$TMP.origin.git"
git -C "$TMP" push -q origin master

SCRIPT="$TMP/scripts/cut-release.sh"
reset_tree() { git -C "$TMP" checkout -q master; git -C "$TMP" checkout -q -- .; git -C "$TMP" clean -qfd; }

# gh shim, outside the work tree like the bare origin so the drift guard
# doesn't count it. It answers `pr list` from $TMP.pr-list (empty unless a test
# seeds it) and logs every call.
mkdir -p "$TMP.bin"
cat > "$TMP.bin/gh" <<EOF
#!/usr/bin/env bash
echo "gh \$*" >> "$TMP.gh-calls"
[ "\$1 \$2" = "pr list" ] && cat "$TMP.pr-list" 2>/dev/null || true
exit 0
EOF
chmod +x "$TMP.bin/gh"

# 1. Dry run: bumps the code version and the three pins, changes exactly those
#    five files, commits nothing.
OUT="$(bash "$SCRIPT" marketplace-ui minor)" || fail "dry run exited nonzero"
echo "$OUT" | grep -q 0.13.0 || fail "dry run did not report 0.13.0"
[ "$(git -C "$TMP" status --porcelain | wc -l)" -eq 5 ] || fail "dry run: expected exactly 5 modified files"
grep -q '"version": *"0.13.0"' "$TMP/ui/package.json" || fail "package.json version"
grep -q 'version: "0.13.0"' "$TMP/apps/marketplace-ui/metadata.yaml" || fail "metadata.yaml pin"
grep -q 'tag: "0.13.0"' "$TMP/infrastructure/system-apps/marketplace-ui.yaml" || fail "infra pin"
grep -q 'newTag: "0.13.0"' "$TMP/apps/marketplace-ui/overlays/librepod/kustomization.yaml" || fail "overlay pin"
[ "$(git -C "$TMP" log --oneline | wc -l)" -eq 1 ] || fail "dry run must not commit"
echo "ok: dry run"

# 2. --pr: the release branch lands on origin and a PR is opened via gh, while
#    master stays put and no git tag is pushed (the publish job tags the merge
#    commit once the artifacts exist).
reset_tree
PATH="$TMP.bin:$PATH" bash "$SCRIPT" marketplace-ui patch --pr >/dev/null || fail "--pr exited nonzero"
[ -z "$(git -C "$TMP" status --porcelain)" ] || fail "--pr left a dirty tree"
[ "$(git -C "$TMP" rev-parse master)" = "$(git -C "$TMP.origin.git" rev-parse master)" ] \
  || fail "master must not move — releases land via PR"
git -C "$TMP.origin.git" rev-parse --verify -q refs/heads/release/marketplace-ui-v0.12.1 >/dev/null \
  || fail "release branch not pushed to origin"
[ -z "$(git -C "$TMP.origin.git" tag)" ] || fail "cutting must not push a git tag"
git -C "$TMP" log -1 --format=%s | grep -qx 'release(marketplace-ui): v0.12.1' || fail "commit subject"
grep -q -- '--base master' "$TMP.gh-calls" || fail "gh pr create not called with --base master"
grep -q -- "--head release/marketplace-ui-v0.12.1" "$TMP.gh-calls" || fail "gh pr create not called with the release branch"
echo "ok: --pr"

# 3. Tag guard: refuses a version that is already released (git-tagged).
reset_tree
git -C "$TMP" tag marketplace-ui-v0.12.1 && git -C "$TMP" push -q origin marketplace-ui-v0.12.1
if OUT="$(bash "$SCRIPT" marketplace-ui patch 2>&1)"; then fail "tag guard did not refuse"; fi
echo "$OUT" | grep -q "already released" || fail "tag guard message missing"
echo "ok: tag guard"

# 4. Drift guard: refuses when anything beyond the app's version files changed.
reset_tree
echo stray > "$TMP/STRAY.md" && git -C "$TMP" add STRAY.md
if OUT="$(bash "$SCRIPT" marketplace-ui minor 2>&1)"; then fail "drift guard did not refuse"; fi
echo "$OUT" | grep -q "exactly its version files" || fail "drift guard message missing"
echo "ok: drift guard"

# 5. Supersede: a hanging release PR of the same app is closed, its branch
#    deleted from origin, and a fresh PR cut from current master.
reset_tree
git -C "$TMP" checkout -qb release/marketplace-ui-v0.12.5
git -C "$TMP" commit -q --allow-empty -m "release(marketplace-ui): v0.12.5"
git -C "$TMP" push -q origin release/marketplace-ui-v0.12.5
git -C "$TMP" checkout -q master
printf '7 release/marketplace-ui-v0.12.5\n' > "$TMP.pr-list"
rm -f "$TMP.gh-calls"
PATH="$TMP.bin:$PATH" bash "$SCRIPT" marketplace-ui minor --pr >/dev/null || fail "supersede run exited nonzero"
grep -q 'startswith("release/marketplace-ui-v")' "$TMP.gh-calls" || fail "supersede not scoped to this app's release PRs"
grep -q 'pr close 7' "$TMP.gh-calls" || fail "superseded PR not closed"
git -C "$TMP.origin.git" rev-parse --verify -q refs/heads/release/marketplace-ui-v0.12.5 >/dev/null \
  && fail "superseded branch not deleted from origin"
grep -q -- '--head release/marketplace-ui-v0.13.0' "$TMP.gh-calls" || fail "fresh release PR not opened"
rm -f "$TMP.pr-list"
echo "ok: supersede"

# 6. casdoor-sso-controller: the code version lives in its Makefile.
reset_tree
bash "$SCRIPT" casdoor-sso-controller patch >/dev/null || fail "controller dry run exited nonzero"
[ "$(git -C "$TMP" status --porcelain | wc -l)" -eq 4 ] || fail "controller: expected exactly 4 modified files"
grep -qx 'VERSION := 0.2.7' "$TMP/casdoor-sso-controller/Makefile" || fail "controller Makefile VERSION"
grep -q 'version: "0.2.7"' "$TMP/apps/casdoor-sso-controller/metadata.yaml" || fail "controller metadata.yaml pin"
grep -q 'tag: "0.2.7"' "$TMP/infrastructure/system-apps/casdoor-sso-controller.yaml" || fail "controller infra pin"
grep -q 'newTag: "0.2.7"' "$TMP/apps/casdoor-sso-controller/overlays/librepod/kustomization.yaml" || fail "controller overlay pin"
reset_tree
rm -f "$TMP.gh-calls"
PATH="$TMP.bin:$PATH" bash "$SCRIPT" casdoor-sso-controller minor --pr >/dev/null || fail "controller --pr exited nonzero"
git -C "$TMP" log -1 --format=%s | grep -qx 'release(casdoor-sso-controller): v0.3.0' || fail "controller commit subject"
grep -q -- '--head release/casdoor-sso-controller-v0.3.0' "$TMP.gh-calls" || fail "controller release PR not opened"
echo "ok: casdoor-sso-controller"

# 7. Refuses what it cannot cut.
reset_tree
bash "$SCRIPT" gogs patch >/dev/null 2>&1 && fail "accepted an app we do not build"
bash "$SCRIPT" marketplace-ui major >/dev/null 2>&1 && fail "accepted a major bump"
[ -z "$(git -C "$TMP" status --porcelain)" ] || fail "a refused cut changed files"
echo "ok: refusals"

echo "PASS: cut-release.sh"
