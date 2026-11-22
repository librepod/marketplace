#!/usr/bin/env bash
# Usage: bash scripts/check-version-lockstep.sh
# Asserts the version-pin lockstep that app-bump automation only partially
# maintains: Renovate covers apps/*/metadata.yaml and apps/*/base/ocirepository.yaml,
# but the infrastructure/system-apps deploy pin is hand-maintained — a partial
# bump strands every cluster on the old artifact with no failing signal.
#
#  1. Every infrastructure/system-apps/*.yaml OCIRepository pulling
#     oci://ghcr.io/librepod/marketplace/apps/<app> must pin ref.tag equal to
#     apps/<app>/metadata.yaml spec.version (published artifact tag == deployed
#     tag). The app is resolved from the URL, not the filename (storage.yaml
#     deploys nfs-provisioner). Entries pulling anything else (the catalog's
#     oci://.../marketplace/catalog) are out of scope.
#  2. Every apps/*/base/ocirepository.yaml carrying a "# lockstep:" comment must
#     pin ref.tag equal to spec.version. Opt-in per app, only for charts tagged
#     from the app release itself (chart version == app version, e.g. casdoor
#     since its chart moved into the app repo); most charts version
#     independently (cert-manager, traefik, immich, ...) and must not declare it.
#  3. The marker set itself is guarded: the apps carrying "# lockstep:" must be
#     exactly EXPECTED_LOCKSTEP_APPS below, so a lost marker (formatter, editor
#     slip) cannot silently disable check 2 for an app — a no-failing-signal
#     mode in the very guard built to eliminate them. A list, not tag==version
#     detection: coincidental equality exists (flux-operator-mcp 0.44.0/0.44.0
#     on an independently versioned upstream chart).
#
# Needs yq v4 (nix-shell shell.nix). Exit 0 = lockstep holds.
set -euo pipefail
cd "$(dirname "$0")/.."

APPS_REGISTRY="oci://ghcr.io/librepod/marketplace/apps/"
STATUS=0
bad() { echo "::error file=$1::$1: $2" >&2; STATUS=1; }

shopt -s nullglob

# --- 1. system-apps deploy pins == app metadata versions ----------------------
for f in infrastructure/system-apps/*.yaml; do
  rows=$(yq '. | select(.kind == "OCIRepository") | [.spec.url // "", .spec.ref.tag // ""] | @tsv' "$f" 2>/dev/null) \
    || { bad "$f" "cannot parse YAML"; continue; }
  while IFS=$'\t' read -r url tag; do
    case "$url" in
      "$APPS_REGISTRY"*)
        app="${url#"$APPS_REGISTRY"}"
        m="apps/$app/metadata.yaml"
        if [ ! -f "$m" ]; then
          bad "$f" "pulls $url but $m does not exist"
          continue
        fi
        version=$(yq '.spec.version // ""' "$m")
        if [ -z "$tag" ]; then
          bad "$f" "$app: OCIRepository has no ref.tag (apps/$app/metadata.yaml pins $version)"
        elif [ "$tag" != "$version" ]; then
          bad "$f" "$app: deploys tag $tag but apps/$app/metadata.yaml pins $version — bump both in one commit or clusters stay on the old artifact"
        fi
        ;;
    esac
  done <<< "$rows"
done

# --- 2. opt-in chart/app version lockstep (marker set guarded, check 3) --------
EXPECTED_LOCKSTEP_APPS="${EXPECTED_LOCKSTEP_APPS:-casdoor}"
marked=""
for f in apps/*/base/ocirepository.yaml; do
  grep -q '# lockstep:' "$f" || continue
  app="$(basename "$(dirname "$(dirname "$f")")")"
  marked="${marked:+$marked$'\n'}$app"
  m="apps/$app/metadata.yaml"
  [ -f "$m" ] || { bad "$f" "lockstep marker present but $m does not exist"; continue; }
  tag=$(yq '.spec.ref.tag // ""' "$f")
  version=$(yq '.spec.version // ""' "$m")
  if [ -z "$tag" ]; then
    bad "$f" "$app: lockstep marker present but ref.tag is empty (metadata.yaml pins $version)"
  elif [ "$tag" != "$version" ]; then
    bad "$f" "$app: chart tag $tag != apps/$app/metadata.yaml spec.version $version — this chart is tagged from the app release; bump both together"
  fi
done

# --- 3. the marker set must equal EXPECTED_LOCKSTEP_APPS (fail-closed) ---------
expected="$(echo "$EXPECTED_LOCKSTEP_APPS" | tr ' ' '\n' | sed '/^$/d' | sort)"
if [ "$(printf '%s\n' "$marked" | sort)" != "$expected" ]; then
  echo "::error::apps carrying '# lockstep:' [$(printf '%s' "$marked" | tr '\n' ' ')] != EXPECTED_LOCKSTEP_APPS [$EXPECTED_LOCKSTEP_APPS] — a marker was lost (check 2 goes fail-open for that app) or added; update EXPECTED_LOCKSTEP_APPS in scripts/check-version-lockstep.sh" >&2
  STATUS=1
fi

[ "$STATUS" -eq 0 ] && echo "OK"
exit "$STATUS"
