#!/usr/bin/env bash
# Publish a self-built app's release: the :<version> image and the matching
# :<version> manifest artifact, both key-signed, then the <app>-v<version> git
# tag on the release commit. This is the ONLY writer of those version tags;
# master merges publish :latest / :<sha> only, so a released version never
# changes under a pinned cluster (issue #361). Called by the publish job of
# .github/workflows/release-self-built.yaml when a release PR merges.
#
#   bash scripts/publish-release.sh release/<app>-v<X.Y.Z> [--push]
#
# Without --push it validates and names what it would publish (dry run).
# Refuses unless <app> is self-built, the code and every pin carry the branch's
# version, and that version is not released yet.
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
TAG=$APP-v$VERSION
REV=$(git rev-parse HEAD)
# The git tag goes on last, so it marks a finished release.
if git ls-remote --tags origin "refs/tags/$TAG" | grep -q .; then
  echo "::error::$TAG is already released and version tags are immutable; cut a new version" >&2; exit 1
fi
# A manifest without its git tag is a run that died midway: only a re-run from
# the same commit may finish it, which rebuilds the same code.
if MANIFEST=$(docker manifest inspect "$ARTIFACT:$VERSION" 2>/dev/null); then
  [ "$(jq -r '.annotations."org.opencontainers.image.revision" // empty' <<<"$MANIFEST")" = "$REV" ] \
    || { echo "::error::$ARTIFACT:$VERSION was published from another commit; cut a new version" >&2; exit 1; }
  echo "::notice::Resuming the interrupted release of $TAG"
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
  --revision="$REV" \
  --ignore-paths='.git/,.gitignore,.gitmodules,.gitattributes,*.jpg,*.jpeg,*.gif,*.png,*.wmv,*.flv,*.tar.gz' \
  --output json | jq -er '.repository + "@" + .digest')
retry cosign sign --key env://COSIGN_PRIVATE_KEY --yes "$DIGEST"

git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  tag -a "$TAG" -m "$APP v$VERSION" "$REV"
git push origin "$TAG"
echo "Published $IMAGE:$VERSION and $ARTIFACT:$VERSION, tagged $TAG"
