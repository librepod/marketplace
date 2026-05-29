#!/bin/bash
#
# Generates catalog.yaml from app metadata files.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CATALOG_FILE="${REPO_ROOT}/catalog.yaml"
CONFIGMAP_CATALOG="${REPO_ROOT}/apps/marketplace-ui/base/catalog.yaml"

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

# Extract a spec-level YAML section (params, secrets) from metadata.yaml
# Outputs the section with 4-space indent
extract_spec_section() {
  local file="$1"
  local section="$2"
  awk -v section="  ${section}:" '
    $0 == section { found=1; next }
    found && /^  [a-z]/ && !/^  [a-z]*:/ { next }
    found && /^  [a-z][a-zA-Z]*:/ { exit }
    found && /^  -/ { print "    " $0; next }
    found && /^    / { print "    " $0; next }
    found && NF == 0 { print "" }
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

# Find all metadata.yaml files
for metadata_file in "$REPO_ROOT"/apps/*/metadata.yaml; do
  app_dir=$(dirname "$metadata_file")
  app_name=$(basename "$app_dir")

  # Skip if no overlays/librepod exists (not a proper app)
  if [ ! -d "$app_dir/overlays/librepod" ]; then
    echo "Skipping $app_name (no overlays/librepod)"
    continue
  fi

  echo "Adding: $app_name"

  # Extract fields using grep/sed (no yq dependency)
  NAME=$(grep '^  name:' "$metadata_file" | head -1 | sed 's/.*name: *//')
  VERSION=$(grep '^  version:' "$metadata_file" | head -1 | sed 's/.*version: *//' | tr -d '"')
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

  # Extract params section
  PARAMS_CONTENT=$(awk '/^  params:/ { found=1; next } found && /^  [a-z]/ { exit } found && NF > 0 { print }' "$metadata_file")
  if [ -n "$PARAMS_CONTENT" ]; then
    echo "      params:" >> "$CATALOG_FILE"
    echo "$PARAMS_CONTENT" | sed 's/^/        /' >> "$CATALOG_FILE"
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
done

# Copy to marketplace-ui ConfigMap source
cp "$CATALOG_FILE" "$CONFIGMAP_CATALOG"

echo
echo "Catalog written to: $CATALOG_FILE"
echo "ConfigMap catalog:  $CONFIGMAP_CATALOG"
