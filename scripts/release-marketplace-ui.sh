#!/usr/bin/env bash
# One-click marketplace-ui release: bump the five version pins, commit, tag,
# and open a PR. Called by .github/workflows/release-marketplace-ui.yaml (--pr)
# and runnable locally for testing.
#
#   bash scripts/release-marketplace-ui.sh <patch|minor> [--pr]
#
# Without --pr, only the working tree is mutated (dry run): inspect
# `git diff`, then `git checkout -- .` to discard. With --pr, commits
# "release(marketplace-ui): vX.Y.Z" on a release/marketplace-ui-vX.Y.Z
# branch, pushes branch + tag to origin, and opens a PR against master
# (master is protected; the merge IS the release — it fires the publish
# workflows through their on:push path triggers).
#
# Refuses to release if the target tag already exists, if a pin file missed
# the bump, or if anything beyond the five pin files changed. A new cut
# supersedes any open release PR (closes it, deletes its branch and tag), so
# re-dispatching while a release PR hangs is always safe.
set -euo pipefail

BUMP=${1:?usage: bash scripts/release-marketplace-ui.sh <patch|minor> [--pr]}
PUSH=${2:-}
case "$PUSH" in ""|--pr) ;; *) echo "unknown option: $PUSH" >&2; exit 2 ;; esac
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

# Supersede: a release PR left hanging goes stale the moment this dispatch
# cuts fresh pins (conflicting lockfile/version bumps, or a version that
# downgrades whatever merged in between). Close it, drop its branch and tag,
# and re-cut from current master — re-dispatching is always the recovery.
# Runs before the tag guard so re-cutting the same version works; only bot
# branches (release/marketplace-ui-v*) are touched, never a human's manual
# release branch.
if [ "$PUSH" = "--pr" ]; then
  while read -r NUM HEAD_REF; do
    [ -n "$NUM" ] || continue
    echo "Superseding release PR #$NUM ($HEAD_REF)"
    gh pr close "$NUM" --comment "Superseded by a fresh release cut from current master."
    git push origin --delete "$HEAD_REF" || true
    git push origin --delete "marketplace-ui-v${HEAD_REF#release/marketplace-ui-v}" || true
  done <<< "$(gh pr list --state open --json number,headRefName \
    --jq '.[] | select(.headRefName | startswith("release/marketplace-ui-v")) | "\(.number) \(.headRefName)"')"
fi

if git ls-remote --tags origin "refs/tags/marketplace-ui-v$NEXT" | grep -q .; then
  echo "::error::Refusing to release: tag marketplace-ui-v$NEXT already exists (release may already be cut — check for an open PR)"
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

[ "$PUSH" = "--pr" ] || { echo "Dry run: bumped to $NEXT, nothing committed or pushed."; exit 0; }

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
BRANCH="release/marketplace-ui-v$NEXT"
git checkout -b "$BRANCH"
git add "${FILES[@]}"
git commit -m "release(marketplace-ui): v$NEXT"
git push origin "$BRANCH"
# The tag rides along with the branch: it marks the release and guards a
# second dispatch against cutting the same version before the PR merges.
git tag -a "marketplace-ui-v$NEXT" -m "marketplace-ui v$NEXT"
git push origin "marketplace-ui-v$NEXT"
gh pr create --base master --head "$BRANCH" \
  --title "release(marketplace-ui): v$NEXT" \
  --body "Merging bumps all five version pins to $NEXT; the merge push fires publish-marketplace-ui, publish-apps and publish-bootstrap via their \`on: push\` path triggers."
