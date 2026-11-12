#!/usr/bin/env bash
# Publish a self-built app's release: the :<version> image and the matching
# :<version> manifest artifact, both key-signed. This is the ONLY writer of
# those version tags; master merges publish :latest / :<sha> only, so a
# released version never changes under a pinned cluster (issue #361). Called
# by .github/workflows/publish-release.yaml when a release PR merges.
#
#   bash scripts/publish-release.sh release/<app>-v<X.Y.Z> [--push]
#
# Without --push it validates and names what it would publish (dry run).
# Refuses unless <app> is self-built, the code and every pin carry the branch's
# version, and that version's manifest is not published yet.
set -euo pipefail

BRANCH=${1:?usage: bash scripts/publish-release.sh release/<app>-v<X.Y.Z> [--push]}
PUSH=${2:-}
case "$PUSH" in ""|--push) ;; *) echo "unknown option: $PUSH" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."

REF=${BRANCH#release/}
APP=${REF%-v*}
VERSION=${REF##*-v}
if [ "$REF" = "$BRANCH" ] || ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::$BRANCH is not a release/<app>-vX.Y.Z branch" >&2; exit 1
fi
case "$APP" in
  marketplace-ui) CONTEXT=ui; CODE_VERSION=$(node -p "require('./ui/package.json').version") ;;
  casdoor-sso-controller) CONTEXT=casdoor-sso-controller; CODE_VERSION=$(make -s -C casdoor-sso-controller print-version) ;;
  *) echo "::error::$APP is not a self-built app; its artifacts publish from master" >&2; exit 1 ;;
esac

# The image tag comes from the code, the manifest tag from metadata.yaml, and
# the overlay decides which image the manifest runs: all must agree.
[ "$CODE_VERSION" = "$VERSION" ] || { echo "::error::$CONTEXT is $CODE_VERSION, branch says $VERSION" >&2; exit 1; }
for f in "apps/$APP/metadata.yaml" "apps/$APP/overlays/librepod/kustomization.yaml" "infrastructure/system-apps/$APP.yaml"; do
  grep -q "\"$VERSION\"" "$f" || { echo "::error::$f does not pin $VERSION" >&2; exit 1; }
done

IMAGE=ghcr.io/librepod/$APP
ARTIFACT=ghcr.io/librepod/marketplace/apps/$APP
# The manifest is pushed last, so its tag marks a finished release. An image
# tag alone is a run that died midway; re-running rebuilds the same commit.
if docker manifest inspect "$ARTIFACT:$VERSION" >/dev/null 2>&1; then
  echo "::error::$ARTIFACT:$VERSION is already published and version tags are immutable; cut a new version" >&2; exit 1
fi

[ "$PUSH" = "--push" ] || { echo "Dry run: would publish $IMAGE:$VERSION and $ARTIFACT:$VERSION"; exit 0; }

retry() {
  # Ride out transient GHCR rate limits (HTTP 403) and Rekor flakes while signing.
  local i
  for i in 1 2 3 4; do
    "$@" && return
    echo "Attempt $i failed; retrying in $((i * 15))s: $*" >&2
    sleep $((i * 15))
  done
  "$@"
}

META=$(mktemp)
trap 'rm -f "$META"' EXIT
docker buildx build --push --metadata-file "$META" -t "$IMAGE:$VERSION" "$CONTEXT"
retry cosign sign --key env://COSIGN_PRIVATE_KEY --yes "$IMAGE@$(jq -er '."containerimage.digest"' "$META")"

DIGEST=$(flux push artifact "oci://$ARTIFACT:$VERSION" \
  --path="./apps/$APP" \
  --source="$(git config --get remote.origin.url)" \
  --revision="$(git rev-parse HEAD)" \
  --ignore-paths='.git/,.gitignore,.gitmodules,.gitattributes,*.jpg,*.jpeg,*.gif,*.png,*.wmv,*.flv,*.tar.gz' \
  --output json | jq -er '.repository + "@" + .digest')
retry cosign sign --key env://COSIGN_PRIVATE_KEY --yes "$DIGEST"
echo "Published $IMAGE:$VERSION and $ARTIFACT:$VERSION"
