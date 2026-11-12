#!/usr/bin/env bash
# One-click release cut for a self-built app: bump its code version and its
# three pins, commit, and open a release PR. Called by the cut job of
# .github/workflows/release-self-built.yaml (--pr) and runnable locally for testing.
#
#   bash scripts/cut-release.sh <marketplace-ui|casdoor-sso-controller> <patch|minor> [--pr]
#
# Without --pr, only the working tree is mutated (dry run): inspect
# `git diff`, then `git checkout -- .` to discard. With --pr, commits
# "release(<app>): vX.Y.Z" on a release/<app>-vX.Y.Z branch, pushes it, and
# opens a PR against master (master is protected; the merge IS the release —
# it fires release-self-built's publish job, the sole writer of the :X.Y.Z image,
# manifest and <app>-vX.Y.Z git tag, and publish-bootstrap).
#
# Refuses to cut if the target version is already released (git-tagged), if a
# pin missed the bump, or if anything beyond the app's version files changed. A
# new cut supersedes the app's open release PR (closes it, deletes its branch),
# so re-dispatching while a release PR hangs is always safe.
set -euo pipefail

USAGE="usage: bash scripts/cut-release.sh <marketplace-ui|casdoor-sso-controller> <patch|minor> [--pr]"
APP=${1:?$USAGE}
BUMP=${2:?$USAGE}
PUSH=${3:-}
case "$BUMP" in patch|minor) ;; *) echo "$USAGE" >&2; exit 2 ;; esac
case "$PUSH" in ""|--pr) ;; *) echo "unknown option: $PUSH" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."

# Each app keeps its code version in its own place; the three pins are alike.
case "$APP" in
  marketplace-ui) CODE=(ui/package.json ui/package-lock.json) ;;
  casdoor-sso-controller) CODE=(casdoor-sso-controller/Makefile) ;;
  *) echo "::error::$APP is not a self-built app" >&2; exit 2 ;;
esac
PINS=(
  "apps/$APP/metadata.yaml"
  "infrastructure/system-apps/$APP.yaml"
  "apps/$APP/overlays/librepod/kustomization.yaml"
)
code_version() {
  case "$APP" in
    marketplace-ui) node -p "require('./ui/package.json').version" ;;
    casdoor-sso-controller) make -s -C casdoor-sso-controller print-version ;;
  esac
}
set_code_version() {
  case "$APP" in
    # npm keeps package.json and package-lock.json in sync — sed on a lockfile
    # risks hitting dependency versions.
    marketplace-ui) (cd ui && npm version "$1" --no-git-tag-version >/dev/null) ;;
    casdoor-sso-controller) sed -i -E "s/^VERSION := .*/VERSION := $1/" casdoor-sso-controller/Makefile ;;
  esac
}

IFS=. read -r MAJOR MINOR PATCH <<< "$(code_version)"
case "$BUMP" in
  minor) NEXT=$MAJOR.$((MINOR + 1)).0 ;;
  patch) NEXT=$MAJOR.$MINOR.$((PATCH + 1)) ;;
esac

# Supersede: a release PR left hanging goes stale the moment this dispatch
# cuts fresh pins (conflicting version bumps, or a version that downgrades
# whatever merged in between). Close it, drop its branch, and re-cut from
# current master — re-dispatching is always the recovery. Only this app's bot
# branches (release/<app>-v*) are touched.
if [ "$PUSH" = "--pr" ]; then
  while read -r NUM HEAD_REF; do
    [ -n "$NUM" ] || continue
    echo "Superseding release PR #$NUM ($HEAD_REF)"
    gh pr close "$NUM" --comment "Superseded by a fresh release cut from current master."
    git push origin --delete "$HEAD_REF" || true
  done <<< "$(gh pr list --state open --json number,headRefName \
    --jq ".[] | select(.headRefName | startswith(\"release/$APP-v\")) | \"\(.number) \(.headRefName)\"")"
fi

if git ls-remote --tags origin "refs/tags/$APP-v$NEXT" | grep -q .; then
  echo "::error::Refusing to cut: $APP-v$NEXT is already released"
  exit 1
fi

set_code_version "$NEXT"
# Pins: each pattern matches exactly one line in its file.
sed -i -E '0,/^  version:/s/^  version:.*/  version: "'"$NEXT"'"/' "${PINS[0]}"
sed -i -E 's/^    tag: ".*"/    tag: "'"$NEXT"'"/' "${PINS[1]}"
sed -i -E 's/newTag: ".*"/newTag: "'"$NEXT"'"/' "${PINS[2]}"

# Drift guard: a pin missed here ships pins that disagree — the failure mode
# that wedges fresh bootstraps on an old version (publish-release.sh refuses
# such a merge too). Require the new version everywhere and nothing else
# changed.
[ "$(code_version)" = "$NEXT" ] || { echo "::error::code version did not pick up $NEXT"; exit 1; }
for f in "${PINS[@]}"; do
  grep -q "\"$NEXT\"" "$f" || { echo "::error::$f did not pick up $NEXT"; exit 1; }
done
EXPECTED=$(printf '%s\n' "${CODE[@]}" "${PINS[@]}" | sort)
ACTUAL=$(git status --porcelain | cut -c4- | sort)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "::error::Bump must modify exactly its version files; got:"
  printf '%s\n' "$ACTUAL"
  exit 1
fi

[ "$PUSH" = "--pr" ] || { echo "Dry run: bumped $APP to $NEXT, nothing committed or pushed."; exit 0; }

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
BRANCH="release/$APP-v$NEXT"
git checkout -b "$BRANCH"
git add "${CODE[@]}" "${PINS[@]}"
git commit -m "release($APP): v$NEXT"
git push origin "$BRANCH"
gh pr create --base master --head "$BRANCH" \
  --title "release($APP): v$NEXT" \
  --body "Merging bumps $APP's code version and pins to $NEXT. The merge runs release-self-built's publish job (the only writer of the \`:$NEXT\` image + manifest and the \`$APP-v$NEXT\` git tag) and publish-bootstrap."
