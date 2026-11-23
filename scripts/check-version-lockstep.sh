#!/usr/bin/env bash
# Usage: bash scripts/check-version-lockstep.sh
# Asserts the version-pin invariants of the two-PR release flow:
#   PR 1 (app bump): apps/<app>/metadata.yaml + base/ocirepository.yaml +
#     manifest changes — publishes the new artifact. Renovate automates this
#     side. Drift against the deploy pin is LEGAL here (check 1 warns).
#   PR 2 (rollout): the infrastructure/system-apps/<app>.yaml pin bump — this
#     is what updates the fleet; it gets e2e + mandatory review (CODEOWNERS on
#     infrastructure/system-apps/). Past the grace period the drift goes from
#     warning to failure: the fleet is stranded on the old artifact. The weekly
#     schedule on validate-apps.yaml re-runs this check so a forgotten PR 2
#     fails even when no commit touches the watched paths.
#
#  1. Every infrastructure/system-apps/*.yaml OCIRepository pulling
#     oci://ghcr.io/librepod/marketplace/apps/<app> must pin ref.tag equal to
#     apps/<app>/metadata.yaml spec.version (published artifact tag == deployed
#     tag). The app is resolved from the URL, not the filename (storage.yaml
#     deploys nfs-provisioner). Entries pulling anything else (the catalog's
#     oci://.../marketplace/catalog) are out of scope. Mismatches warn while
#     the drift is younger than 14 days (GRACE below) and fail after; age =
#     last commit touching the app's metadata.yaml, so CI needs
#     fetch-depth: 0 (unknown age degrades to a warning, never a silent pass).
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
GRACE=14
bump_age_days() { # <path> — days since the last commit touching it; empty = unknowable
  local d
  d=$(git log -1 --format=%ct -- "$1" 2>/dev/null) || return 0
  [ -n "$d" ] || return 0
  echo $(( ( $(date +%s) - d ) / 86400 ))
}
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
          age=$(bump_age_days "$m")
          msg="$app: deploys tag $tag but apps/$app/metadata.yaml pins $version"
          if [ -n "$age" ] && [ "$age" -gt "$GRACE" ]; then
            bad "$f" "$msg — drift is ${age}d old (grace ${GRACE}d): ship the rollout PR (bump this pin) or revert the app bump"
          else
            echo "::warn file=$f::$msg — rollout PR due within ${GRACE}d${age:+ (drift age: ${age}d)}" >&2
          fi
        fi
        ;;
    esac
  done <<< "$rows"
done

# --- 2. opt-in chart/app version lockstep (marker set guarded, check 3) --------
# Empty default: no app on master carries the marker yet. The first app whose
# chart is tagged from its own release adds the marker AND this default in the
# same PR (check 3 fails until both move together).
EXPECTED_LOCKSTEP_APPS="${EXPECTED_LOCKSTEP_APPS:-}"
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
