#!/usr/bin/env bash
# Usage: bash scripts/check-app-components.sh [<app>...]
# Validates components/*/component.yaml and, for every app (default: all apps
# with spec.components) that opts in, that each listed component composes into
# the app's overlay. Needs yq v4 and kustomize (nix-shell shell.nix).
set -euo pipefail
cd "$(dirname "$0")/.."

ANN='librepod.org/component-target'
RESERVED=" BASE_DOMAIN DEVICE_IP INSTANCE_NAME "
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STATUS=0
bad() { echo "FAIL $1: $2" >&2; STATUS=1; }

check_descriptor() { # <component>
  local c="$1" f="components/$1/component.yaml" k="components/$1/kustomization.yaml"
  [ -f "$f" ] || { bad "$c" "missing component.yaml"; return; }
  [ "$(yq '.kind' "$f")" = "ComponentDefinition" ] || bad "$c" "kind must be ComponentDefinition"
  [ "$(yq '.metadata.name' "$f")" = "$c" ] || bad "$c" "metadata.name must equal the directory name"
  local version kind
  version=$(yq '.spec.version // ""' "$f")
  kind=$(yq '.spec.kind // ""' "$f")
  [ -n "$version" ] || bad "$c" "spec.version is empty"
  [[ "$kind" == patch || "$kind" == resource ]] || bad "$c" "spec.kind must be patch or resource"
  [ "$(yq '.kind' "$k" 2>/dev/null)" = "Component" ] || bad "$c" "kustomization.yaml must be kind: Component"
  if [ "$(yq '.images // [] | length' "$k" 2>/dev/null)" -gt 0 ]; then
    [ "$(yq "[.images[] | select(.newTag == \"$version\")] | length" "$k")" -gt 0 ] \
      || bad "$c" "no images: entry has newTag equal to spec.version ($version)"
  fi
  local name from pattern
  while IFS=$'\t' read -r name from pattern; do
    [ -n "$name" ] || continue
    [[ "$from" == install || "$from" == app || "$from" == derived ]] || bad "$c" "value $name: from must be install, app or derived"
    [[ "$RESERVED" != *" $name "* ]] || bad "$c" "value $name is a reserved name"
    if [ "$from" = install ]; then
      [[ "$pattern" == ^*\$ ]] || bad "$c" "value $name: pattern must start with ^ and end with \$"
    fi
  done < <(yq '.spec.values // [] | .[] | [.name, .from, .pattern // ""] | @tsv' "$f")
  # Apps only ever read their public hostname from PUBLIC_HOST, whichever exposure is picked.
  if [ "$(yq '.spec.group // ""' "$f")" = exposure ]; then
    [ "$(yq '[.spec.values // [] | .[] | select(.name == "PUBLIC_HOST")] | length' "$f")" -gt 0 ] \
      || bad "$c" "an exposure component must provide a PUBLIC_HOST value"
  fi
  local f2 vars
  for f2 in components/"$c"/*.yaml components/"$c"/*.env; do
    [ -f "$f2" ] || continue
    vars=$(grep -o '\${[^}]*}' "$f2" | grep -v ':=' || true)
    [ -z "$vars" ] || bad "$c" "$(basename "$f2"): \${VAR} without a := default: $(echo $vars)"
  done
}

check_pair() { # <app> <component>
  local app="$1" c="$2" scope="$1/$2" cf="components/$2/component.yaml" mf="apps/$1/metadata.yaml"
  [ -f "$cf" ] || { bad "$scope" "unknown component $c"; return; }
  local declared given k
  declared=$(yq '.spec.values // [] | .[].name' "$cf")
  given=$(yq ".spec.components[] | select(.name == \"$c\") | .values // {} | keys | .[]" "$mf")
  for k in $given; do
    grep -qx "$k" <<<"$declared" || bad "$scope" "value $k is not declared by the component"
  done
  for k in $(yq '.spec.values // [] | .[] | select(.from == "app") | .name' "$cf"); do
    grep -qx "$k" <<<"$given" || bad "$scope" "from: app value $k is not supplied by the app"
  done

  local w="$TMP/$app-$c" ov
  mkdir -p "$w"; cp -r "apps/$app" "$w/$app"; mkdir -p "$w/$app/shared-components"
  cp -r "components/$c" "$w/$app/shared-components/$c"
  ov="$w/$app/overlays/librepod"
  kustomize build "$ov" > "$w/base.yaml" 2>"$w/err" || { bad "$scope" "baseline build failed: $(head -c 300 "$w/err")"; return; }
  local kind; kind=$(yq '.spec.kind' "$cf")
  local sel="select(.kind == \"Deployment\" and .metadata.annotations[\"$ANN\"] == \"true\")"
  if [ "$kind" = patch ]; then
    local n; n=$(yq ea "[$sel] | length" "$w/base.yaml" 2>/dev/null || echo 0)
    [ "$n" -eq 1 ] || { bad "$scope" "need exactly one Deployment annotated $ANN, found $n"; return; }
    [ "$(yq "$sel | .metadata.annotations[\"kustomize.toolkit.fluxcd.io/substitute\"] // \"\"" "$w/base.yaml")" != disabled ] \
      || { bad "$scope" "target Deployment has substitute: disabled, component values would not apply"; return; }
  fi
  yq -i ".components += [\"../../shared-components/$c\"]" "$ov/kustomization.yaml"
  kustomize build "$ov" > "$w/out.yaml" 2>"$w/err" || { bad "$scope" "build with component failed: $(head -c 300 "$w/err")"; return; }
  if [ "$kind" = patch ]; then
    yq "$sel | ((.spec.template.spec.containers // []) + (.spec.template.spec.initContainers // []))[].name" "$w/out.yaml" \
      | grep -qx "$c" || bad "$scope" "annotated Deployment has no container named $c after composing"
  else
    [ "$(grep -c '^kind:' "$w/out.yaml")" -gt "$(grep -c '^kind:' "$w/base.yaml")" ] \
      || bad "$scope" "composing added no resources"
  fi
}

shopt -s nullglob
for d in components/*/; do check_descriptor "$(basename "$d")"; done

APPS=("$@")
if [ ${#APPS[@]} -eq 0 ]; then
  for m in apps/*/metadata.yaml; do
    [ "$(yq '.spec.components // [] | length' "$m")" -gt 0 ] && APPS+=("$(basename "$(dirname "$m")")")
  done
fi
for app in ${APPS[@]+"${APPS[@]}"}; do
  for c in $(yq '.spec.components // [] | .[].name' "apps/$app/metadata.yaml"); do
    check_pair "$app" "$c"
  done
done

[ "$STATUS" -eq 0 ] && echo "OK"
exit "$STATUS"
