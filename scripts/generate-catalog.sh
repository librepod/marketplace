#!/bin/bash
#
# Generates catalog.yaml from app metadata files.

set -e

# Byte-order collation everywhere below: deterministic app ordering in the
# generated catalog regardless of the invoking environment's locale (also
# governs bash's glob-expansion sort in the loop).
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CATALOG_FILE="${REPO_ROOT}/catalog.yaml"
APP_COUNT=0

# Extract a YAML literal block value from spec.templates.<key> in metadata.yaml
# Outputs the content with 4-space indent (to nest under the app entry)
extract_template_block() {
  local file="$1"
  local key="$2"
  awk -v key="    ${key}: |" '
    $0 == key { found=1; next }
    found && /^    [a-z]/ { exit }
    found { if (NF > 0) print "      " $0 }
  ' "$file"
}

# Start catalog
cat > "$CATALOG_FILE" <<'HEADER'
apiVersion: marketplace/v1
kind: Catalog
metadata:
  generatedAt: "TIMESTAMP"
apps:
HEADER

# Replace timestamp
sed -i "s/TIMESTAMP/$(date -u +%Y-%m-%dT%H:%M:%SZ)/" "$CATALOG_FILE"

# Find all metadata.yaml files. The glob loop (not $(... | sort)) keeps paths
# with whitespace intact; LC_ALL=C above makes the expansion order deterministic.
for metadata_file in "$REPO_ROOT"/apps/*/metadata.yaml; do
  # Unmatched glob expands to the literal pattern — skip it.
  [ -e "$metadata_file" ] || continue
  app_dir=$(dirname "$metadata_file")
  app_name=$(basename "$app_dir")

  # Skip if no overlays/librepod exists (not a proper app)
  if [ ! -d "$app_dir/overlays/librepod" ]; then
    echo "Skipping $app_name (no overlays/librepod)"
    continue
  fi

  echo "Adding: $app_name"
  APP_COUNT=$((APP_COUNT + 1))

  # Extract fields using grep/sed (no yq dependency)
  NAME=$(grep '^  name:' "$metadata_file" | head -1 | sed 's/.*name: *//')
  VERSION=$(grep '^  version:' "$metadata_file" | head -1 | sed 's/.*version: *//' | tr -d '"')
  if [ -z "$VERSION" ]; then
    echo "ERROR: $app_name has empty spec.version" >&2; exit 1
  fi
  DISPLAY_NAME=$(grep '^  displayName:' "$metadata_file" | sed 's/.*displayName: *//' | tr -d '"')
  CATEGORY=$(grep '^  category:' "$metadata_file" | sed 's/.*category: *//' | tr -d '"')
  ICON=$(grep '^  icon:' "$metadata_file" | sed 's/.*icon: *//' | tr -d '"')
  DESCRIPTION=$(grep '^  description:' "$metadata_file" | head -1 | sed 's/.*description: *//' | tr -d '"')
  SOURCE_TYPE=$(grep '^    type:' "$metadata_file" | head -1 | sed 's/.*type: *//' | tr -d '"')
  SOURCE_URL=$(grep '^    url:' "$metadata_file" | head -1 | sed 's/.*url: *//' | tr -d '"')

  # Start entry with basic fields
  cat >> "$CATALOG_FILE" <<ENTRY
    - name: ${NAME}
      version: "${VERSION}"
      displayName: "${DISPLAY_NAME}"
      description: "${DESCRIPTION}"
      category: "${CATEGORY}"
      icon: "${ICON}"
      sourceType: ${SOURCE_TYPE}
      sourceUrl: "${SOURCE_URL}"
ENTRY

  # Extract templates
  TMPL_SOURCE=$(extract_template_block "$metadata_file" "source")
  # Fill the version sentinel from spec.version (single source of truth).
  TMPL_SOURCE=$(printf '%s' "$TMPL_SOURCE" | sed "s/__VERSION__/${VERSION}/g")
  TMPL_RELEASE=$(extract_template_block "$metadata_file" "release")
  TMPL_SECRET=$(extract_template_block "$metadata_file" "secret")
  TMPL_KUSTOMIZATION=$(extract_template_block "$metadata_file" "kustomization")

  if [ -n "$TMPL_SOURCE" ] || [ -n "$TMPL_RELEASE" ]; then
    echo "      templates:" >> "$CATALOG_FILE"
    if [ -n "$TMPL_SOURCE" ]; then
      echo "        source: |" >> "$CATALOG_FILE"
      echo "$TMPL_SOURCE" >> "$CATALOG_FILE"
    fi
    if [ -n "$TMPL_RELEASE" ]; then
      echo "        release: |" >> "$CATALOG_FILE"
      echo "$TMPL_RELEASE" >> "$CATALOG_FILE"
    fi
    if [ -n "$TMPL_SECRET" ]; then
      echo "        secret: |" >> "$CATALOG_FILE"
      echo "$TMPL_SECRET" >> "$CATALOG_FILE"
    fi
    if [ -n "$TMPL_KUSTOMIZATION" ]; then
      echo "        kustomization: |" >> "$CATALOG_FILE"
      echo "$TMPL_KUSTOMIZATION" >> "$CATALOG_FILE"
    fi
  fi

  # Extract secrets section
  SECRETS_LINE=$(grep '^  secrets:' "$metadata_file" | head -1 | sed 's/.*secrets: *//')
  if [ "$SECRETS_LINE" = "[]" ]; then
    echo "      secrets: []" >> "$CATALOG_FILE"
  else
    SECRETS_CONTENT=$(awk '/^  secrets:/ { found=1; next } found && /^  [a-z]/ { exit } found && NF > 0 { print }' "$metadata_file")
    if [ -n "$SECRETS_CONTENT" ]; then
      echo "      secrets:" >> "$CATALOG_FILE"
      echo "$SECRETS_CONTENT" | sed 's/^/        /' >> "$CATALOG_FILE"
    fi
  fi

  # Extract settings section (install questions + allowCustom) verbatim — the
  # installer and the install dialog read it from catalog.yaml. Keeps whatever
  # follows `settings:` on its own line (flow style: `settings: { allowCustom: true }`,
  # minus a trailing comment) and blank lines inside the block (paragraph breaks in
  # `description: |`); blank lines are emptied, not indented, so they never add
  # spaces to a block scalar.
  SETTINGS_INLINE=$(grep -m1 '^  settings:' "$metadata_file" | sed -e 's/^  settings:[[:space:]]*//' -e 's/^#.*//' || true)
  SETTINGS_CONTENT=$(awk '/^  settings:/ { found=1; next } found && /^  [a-z]/ { exit } found { print }' "$metadata_file" \
    | sed -e 's/^[[:space:]]*$//' -e '/./s/^/        /')
  if [ -n "$SETTINGS_INLINE" ] || [ -n "$SETTINGS_CONTENT" ]; then
    echo "      settings:${SETTINGS_INLINE:+ $SETTINGS_INLINE}" >> "$CATALOG_FILE"
    if [ -n "$SETTINGS_CONTENT" ]; then echo "$SETTINGS_CONTENT" >> "$CATALOG_FILE"; fi
  fi
done

if grep -q '__VERSION__' "$CATALOG_FILE"; then
  echo "ERROR: __VERSION__ sentinel leaked into catalog.yaml" >&2; exit 1
fi

# An empty catalog is always a regression (extraction failure, moved metadata
# schema, ...), never a valid state — this repo ships dozens of apps.
if [ "$APP_COUNT" -eq 0 ]; then
  echo "ERROR: no apps found under apps/*/metadata.yaml (with overlays/librepod) — refusing to write an empty catalog" >&2
  exit 1
fi

echo
echo "Catalog written to: $CATALOG_FILE"
