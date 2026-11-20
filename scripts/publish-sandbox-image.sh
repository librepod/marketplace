#!/usr/bin/env bash
# Build the image factory8 runs this repo's agent steps in (flake.nix .#sandbox-image) and, with --push, push it to
# GHCR tagged with its Nix hash: the tag factory8's FACTORY8_IMAGES pins for librepod/marketplace.
# usage: scripts/publish-sandbox-image.sh [--push]
set -euo pipefail
case "${1:-}" in
  --push) push=1 ;;
  '') push= ;;
  *) echo "usage: $0 [--push]" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."

out=$(nix build .#sandbox-image --no-link --print-out-paths)
image=$("$out" | docker load | sed -n 's/^Loaded image: //p') # marketplace-sandbox:<nix hash>
: "${image:?docker load named no image}"
target=ghcr.io/librepod/$image
docker tag "$image" "$target"
if [ -n "$push" ]; then docker push "$target"; else echo "dry run, not pushed"; fi
echo "$target"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "Sandbox image: \`$target\`" >> "$GITHUB_STEP_SUMMARY"; fi
