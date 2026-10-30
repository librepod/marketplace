#!/usr/bin/env bash
# Usage: bash scripts/publish-components.sh [--push] [--pr <n>] [--base <rev>] [all | <name>...]
# Publishes components/<name>/ as cosign-signed OCI artifacts. With no names it
# publishes the components changed since --base (default HEAD~1). Without
# --push it only prints the flux push commands (dry run).
# Env: OCI_REPO (default ghcr.io/librepod/marketplace/components); with --push
# also the cosign key and password env vars for non-PR signing.
set -euo pipefail
cd "$(dirname "$0")/.."

OCI_REPO="${OCI_REPO:-ghcr.io/librepod/marketplace/components}"
PUSH=0 PR="" BASE="HEAD~1" NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1 ;;
    --pr) PR="$2"; shift ;;
    --base) BASE="$2"; shift ;;
    *) NAMES+=("$1") ;;
  esac
  shift
done

if [ "${NAMES[0]:-}" = all ]; then
  NAMES=()
  for d in components/*/; do NAMES+=("$(basename "$d")"); done
elif [ ${#NAMES[@]} -eq 0 ]; then
  # Skip directories that were deleted in the range.
  for n in $(git diff --name-only "$BASE" HEAD -- components/ | cut -d/ -f2 | sort -u); do
    [ -f "components/$n/component.yaml" ] && NAMES+=("$n")
  done
fi

for n in ${NAMES[@]+"${NAMES[@]}"}; do
  [ -f "components/$n/component.yaml" ] || { echo "unknown component: $n" >&2; exit 2; }
done

push() { # <name> <tag>
  local ref="oci://${OCI_REPO}/$1:$2"
  if [ "$PUSH" -eq 0 ]; then
    echo "DRY RUN: flux push artifact $ref --path=./components/$1"
    return
  fi
  local digest
  digest=$(flux push artifact "$ref" \
    --path="./components/$1" \
    --source="$(git config --get remote.origin.url)" \
    --revision="$(git rev-parse HEAD)" \
    --ignore-paths=.git/,.gitignore,.gitmodules,.gitattributes,*.jpg,*.jpeg,*.gif,*.png,*.wmv,*.flv,*.tar.gz \
    --output json | jq -r '.repository + "@" + .digest')
  echo "Signing $digest"
  if [ -n "$PR" ]; then
    cosign sign --yes "$digest"
  else
    cosign sign --key env://COSIGN_PRIVATE_KEY --yes "$digest"
  fi
}

for n in ${NAMES[@]+"${NAMES[@]}"}; do
  # Same extraction as publish-apps.yaml: anchor to the spec field, drop a
  # trailing comment and the quotes.
  version=$(grep '^  version:' "components/$n/component.yaml" \
    | head -1 | sed -e 's/.*version: *//' -e 's/[[:space:]]*#.*//' | tr -d '"')
  [ -n "$version" ] || { echo "empty version in components/$n/component.yaml" >&2; exit 1; }
  if [ -n "$PR" ]; then
    push "$n" "pr-$PR"
  else
    push "$n" "$version"
    push "$n" latest
  fi
done
