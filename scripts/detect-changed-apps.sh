#!/usr/bin/env bash
# Usage: bash scripts/detect-changed-apps.sh <base-sha>
# Prints the JSON array of apps changed since <base-sha>, consumed by the PR
# matrix in validate-apps.yaml. Two sources, one gate: an app counts as changed
# when files under apps/<app>/ moved (the usual app PR), or when an
# infrastructure/system-apps/*.yaml that deploys it moved — the rollout PR of
# the two-phase flow often touches nothing else and must run the same
# validate/e2e matrix. The app is resolved from the OCI registry URL, not the
# filename (storage.yaml deploys nfs-provisioner); non-app repositories (the
# catalog) resolve to nothing. Only apps with metadata.yaml and
# overlays/librepod are emitted — what the validate matrix can actually run.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:?usage: detect-changed-apps.sh <base-sha>}"
APPS_REGISTRY="oci://ghcr.io/librepod/marketplace/apps/"

apps=""
for p in $(git diff --name-only "$BASE" HEAD -- apps/ infrastructure/system-apps/); do
  [ -f "$p" ] || continue  # deleted since BASE: nothing to resolve
  case "$p" in
    infrastructure/system-apps/*.yaml)
      app=$(sed -nE "s#.*${APPS_REGISTRY}([a-z0-9-]+).*#\1#p" "$p" | head -1) ;;
    apps/*)
      app=${p#apps/}; app=${app%%/*} ;;
  esac
  [ -n "${app:-}" ] || continue
  [ -f "apps/$app/metadata.yaml" ] && [ -d "apps/$app/overlays/librepod" ] || continue
  apps="$apps $app"
done

for a in $apps; do echo "$a"; done | sort -u | jq -R . | jq -sc .
