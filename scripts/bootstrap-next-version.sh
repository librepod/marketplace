#!/usr/bin/env bash
# Compute the next marketplace/bootstrap release version from system-app pin
# changes since the last marketplace-bootstrap-v* tag.
#
# Usage (inside a git checkout):
#   bash scripts/bootstrap-next-version.sh
#
# Output: prints "NEXT=<version-or-empty>" and a notes block to stdout; in CI
# also appends step outputs `next` and multiline `notes` to $GITHUB_OUTPUT.
#
# Rules (spec: docs/superpowers/specs/2026-10-21-bootstrap-release-optimization-design.md):
#   - highest bump level across all pin changes wins
#   - added / removed system app          -> minor
#   - rollback or non-semver tag change   -> patch (rollback is flagged in notes)
#   - non-pin infra/clusters change       -> patch (default)
#   - no diff since the last release tag  -> NEXT empty (skip release)
set -euo pipefail

TAG_PREFIX="marketplace-bootstrap-v"
PINS_DIR="infrastructure/system-apps"

fail() { echo "::error::$1" >&2; exit 1; }

VERSION="$(git tag -l "${TAG_PREFIX}*" | sed "s/^${TAG_PREFIX}//" | sort -V | tail -n1)"
[ -n "$VERSION" ] || fail "no ${TAG_PREFIX}* tags found; seed the tag line with one manual Release Bootstrap Artifact dispatch"
BASE="${TAG_PREFIX}${VERSION}"

semver_or_empty() {  # strip quotes + leading v; echo X.Y.Z or "" if not semver
  local v="${1//\"/}"
  v="${v#v}"
  if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$v"; fi
}

pin_at() {  # pin_at <git-ref> <file> -> raw tag value ("" if absent / no pin)
  git show "$1:$2" 2>/dev/null | grep -m1 'tag:' | sed 's/.*tag: *//' || true
}

seg_cmp() {  # segment-wise compare of two X.Y.Z; prints -1 / 0 / 1
  local a=(${1//./ }) b=(${2//./ }) i
  for i in 0 1 2; do
    if (( a[i] < b[i] )); then echo -1; return
    elif (( a[i] > b[i] )); then echo 1; return; fi
  done
  echo 0
}

LEVEL_NUM=0   # 0 none, 1 patch, 2 minor, 3 major
NOTES=""

record() {  # record <level-num> <note-line>
  NOTES="${NOTES}$2"$'\n'
  if (( $1 > LEVEL_NUM )); then LEVEL_NUM=$1; fi
}

# Union of pin files at BASE and at HEAD (handles added/removed files).
FILES="$(
  { git ls-tree -r --name-only "$BASE" -- "$PINS_DIR"; git ls-files "$PINS_DIR"; } | sort -u
)"

while IFS= read -r f; do
  [ -n "$f" ] || continue
  old_raw="$(pin_at "$BASE" "$f")"
  new_raw="$(pin_at HEAD "$f")"
  [ "$old_raw" = "$new_raw" ] && continue
  app="$(basename "$f" .yaml)"
  old="$(semver_or_empty "$old_raw")"
  new="$(semver_or_empty "$new_raw")"
  if [ -z "$old" ] && [ -n "$new" ]; then
    record 2 "$app added [minor]"
    continue
  fi
  if [ -n "$old" ] && [ -z "$new" ]; then
    record 2 "$app removed [minor]"
    continue
  fi
  if [ -z "$old" ] || [ -z "$new" ] || [ "$old" = "$new" ]; then
    continue  # cosmetic-only or pinless-both-sides: not a pin change
  fi
  if [ "$(seg_cmp "$old" "$new")" -ge 0 ]; then
    record 1 "$app $old->$new [patch, rollback]"
    continue
  fi
  o=(${old//./ }) n=(${new//./ })
  if (( o[0] < n[0] )); then
    record 3 "$app $old->$new [major]"
  elif (( o[1] < n[1] )); then
    record 2 "$app $old->$new [minor]"
  else
    record 1 "$app $old->$new [patch]"
  fi
done <<< "$FILES"

NEXT=""
if ! git diff --quiet "$BASE" HEAD -- clusters/ infrastructure/; then
  if [ "$LEVEL_NUM" -eq 0 ]; then
    LEVEL_NUM=1
    NOTES="no pin changes (non-pin infrastructure edit) [patch]"$'\n'
  fi
  v=(${VERSION//./ })
  case "$LEVEL_NUM" in
    3) NEXT="$((v[0] + 1)).0.0" ;;
    2) NEXT="${v[0]}.$((v[1] + 1)).0" ;;
    1) NEXT="${v[0]}.${v[1]}.$((v[2] + 1))" ;;
  esac
fi

NOTES="$(echo "$NOTES" | sed '/^$/d')"
echo "NEXT=$NEXT"
echo "NOTES:"
echo "$NOTES"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "next=$NEXT"
    echo "notes<<EOF"
    echo "$NOTES"
    echo "EOF"
  } >> "$GITHUB_OUTPUT"
fi
