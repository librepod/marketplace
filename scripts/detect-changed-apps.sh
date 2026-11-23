#!/usr/bin/env bash
# Usage: bash scripts/detect-changed-apps.sh <base-sha>
# Prints the JSON array of apps changed since <base-sha>, for the PR matrix in
# validate-apps.yaml. An app counts when files under apps/<app>/ moved (the
# usual app PR) or when a system-apps/*.yaml deploying it moved (the rollout
# PR of the two-phase flow — see check-version-lockstep.sh). App is resolved
# from the OCI URL, not the filename (storage.yaml deploys nfs-provisioner);
# only apps with metadata.yaml + overlays/librepod are emitted.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:?usage: detect-changed-apps.sh <base-sha>}"
APPS_REGISTRY="oci://ghcr.io/librepod/marketplace/apps/"

apps=""
for p in $(git diff --name-only "$BASE" HEAD -- apps/ infrastructure/system-apps/); do
  [ -f "$p" ] || continue  # deleted since BASE: nothing to resolve
  case "$p" in
    infrastructure/system-apps/*.yaml)
      found=$(sed -nE "s#.*${APPS_REGISTRY}([a-z0-9-]+).*#\1#p" "$p") ;;  # multi-doc: all apps
    apps/*)
      found=${p#apps/}; found=${found%%/*} ;;
    *) continue ;;
  esac
  for app in $found; do
    [ -f "apps/$app/metadata.yaml" ] && [ -d "apps/$app/overlays/librepod" ] || continue
    apps="$apps $app"
  done
done

for a in $apps; do echo "$a"; done | sort -u | jq -Rnc '[inputs]'
