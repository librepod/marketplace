#!/usr/bin/env bash
# One-click marketplace-ui release: bump the five version pins, commit, tag,
# and push. Called by .github/workflows/release-marketplace-ui.yaml (--push)
# and runnable locally for testing.
#
#   bash scripts/release-marketplace-ui.sh <patch|minor> [--push]
#
# Without --push, only the working tree is mutated (dry run): inspect
# `git diff`, then `git checkout -- .` to discard. With --push, commits
# "release(marketplace-ui): vX.Y.Z", tags marketplace-ui-vX.Y.Z, and pushes
# master + tag to origin.
#
# Refuses to release if the target tag already exists, if a pin file missed
# the bump, or if anything beyond the five pin files changed.
set -euo pipefail

BUMP=${1:?usage: bash scripts/release-marketplace-ui.sh <patch|minor> [--push]}
PUSH=${2:-}
case "$PUSH" in ""|--push) ;; *) echo "unknown option: $PUSH" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."

FILES=(
  ui/package.json ui/package-lock.json
  apps/marketplace-ui/metadata.yaml
  infrastructure/system-apps/marketplace-ui.yaml
  apps/marketplace-ui/overlays/librepod/kustomization.yaml
)

# Pins 1+2 and the version arithmetic: npm version bumps package.json and
# package-lock.json in sync — sed on a lockfile risks hitting dependency
# versions.
(cd ui && npm version "$BUMP" --no-git-tag-version)
NEXT=$(node -p "require('./ui/package.json').version")

if git ls-remote --tags origin "refs/tags/marketplace-ui-v$NEXT" | grep -q .; then
  echo "::error::Refusing to release: tag marketplace-ui-v$NEXT already exists"
  exit 1
fi

# Pins 3-5: each pattern matches exactly one line in its file.
sed -i -E '0,/^  version:/s/^  version:.*/  version: "'"$NEXT"'"/' \
  apps/marketplace-ui/metadata.yaml
sed -i -E 's/^    tag: ".*"/    tag: "'"$NEXT"'"/' \
  infrastructure/system-apps/marketplace-ui.yaml
sed -i -E 's/newTag: ".*"/newTag: "'"$NEXT"'"/' \
  apps/marketplace-ui/overlays/librepod/kustomization.yaml

# Drift guard: a pin missed here ships pins that disagree — the failure mode
# that wedges fresh bootstraps on an old UI. Require the new version in each
# pin file and exactly five changed files.
for f in "${FILES[@]}"; do
  grep -q "\"$NEXT\"" "$f" || { echo "::error::$f did not pick up $NEXT"; exit 1; }
done
EXPECTED=$(printf '%s\n' "${FILES[@]}" | sort)
ACTUAL=$(git status --porcelain | cut -c4- | sort)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "::error::Bump must modify exactly the five pin files; got:"
  printf '%s\n' "$ACTUAL"
  exit 1
fi

[ "$PUSH" = "--push" ] || { echo "Dry run: bumped to $NEXT, nothing committed or pushed."; exit 0; }

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "${FILES[@]}"
git commit -m "release(marketplace-ui): v$NEXT"
git push origin master
git tag -a "marketplace-ui-v$NEXT" -m "marketplace-ui v$NEXT"
git push origin "marketplace-ui-v$NEXT"
