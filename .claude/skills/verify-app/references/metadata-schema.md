# metadata.yaml Schema Reference

Reference for the `metadata.yaml` format used by LibrePod marketplace apps.
Understanding this schema is essential for debugging template rendering issues.

## Top-Level Structure

```yaml
apiVersion: marketplace/v1
kind: AppDefinition
metadata:
  name: <app-name>
spec:
  displayName: "Human-Readable Name"
  description: "What the app does"
  icon: "https://url-to-icon"
  category: "Category"
  website: "https://project-url"
  version: "1.0.0"           # Default OCI artifact tag
  source: { ... }            # OCI artifact source definition
  params: { ... }            # Required user parameters
  secrets: [ ... ]           # Secrets to generate (optional)
  dependencies: { ... }      # Cluster dependencies
  templates: { ... }         # Flux resource templates
```

## Key Fields for Verification

### spec.version

The default OCI artifact tag used when no `--tag` is specified during rendering.
The `render-templates.py` script uses this as the fallback tag value.

### spec.templates

Map of Flux resource templates. Each key becomes a filename (e.g., `source` →
`source.yaml`). Four template types are recognized:

| Key | Required | Flux Resource | Purpose |
|-----|----------|---------------|---------|
| `source` | Yes | OCIRepository | Points to the OCI artifact in GHCR |
| `release` | Yes | Kustomization | Deploys the app from the OCI artifact |
| `secret` | No | Secret | App secrets (only if `spec.secrets` is defined) |
| `kustomization` | Yes | Kustomization | References all other templates |

**Variable substitution**: Templates use `${VAR}` syntax for substitution.
`render-templates.py` replaces:
- `${BASE_DOMAIN}` → the `--base-domain` argument (default: `librepod.dev`)
- `${SECRET_NAME}` → each secret defined in `spec.secrets`
- Any unrecognized `${VAR}` → left as-is (not substituted)

**Tag replacement**: The `source` template's `spec.ref.tag` field is replaced
with the effective OCI tag (from `--tag` argument or `spec.version`).

### spec.secrets

Array of secret definitions. Each secret can be:

```yaml
secrets:
  - name: ADMIN_TOKEN
    description: "Admin access token"
    required: false
    generate:
      type: random
      length: 64

  - name: FRP_AUTH_TOKEN
    description: "Auth token for FRP server"
    required: true
    # No generate field — user must provide this value
```

**Rendering behavior**:
- If `generate.type: random` → generates a random alphanumeric string
- If no `generate` field → generates a random placeholder with a warning to stderr
- The `required` field is informational only (does not affect rendering)

### spec.params

Required parameters that the user must provide:

```yaml
params:
  required:
    - name: BASE_DOMAIN
      description: "Base domain for cluster"
      type: string
      example: "example.com"
```

Currently, `BASE_DOMAIN` is the only required parameter for all apps. The
render script always substitutes it.

### spec.dependencies

Cluster dependencies that must be satisfied before the app can deploy:

```yaml
dependencies:
  required:
    - kind: IngressController
      description: "Traefik"
    - kind: StorageClass
      description: "nfs-client"
```

The verify pipeline checks these before proceeding (Stage 1, step 4).

## Example: Minimal App (whoami)

```yaml
templates:
  source: |
    apiVersion: source.toolkit.fluxcd.io/v1
    kind: OCIRepository
    metadata:
      name: marketplace-whoami
      namespace: flux-system
    spec:
      interval: 10m
      url: oci://ghcr.io/librepod/marketplace/apps/whoami
      ref:
        tag: "1.10.1"
  release: |
    apiVersion: kustomize.toolkit.fluxcd.io/v1
    kind: Kustomization
    metadata:
      name: marketplace-whoami
      namespace: flux-system
    spec:
      interval: 1h
      sourceRef:
        kind: OCIRepository
        name: marketplace-whoami
      path: ./overlays/librepod
      prune: true
      wait: true
      postBuild:
        substitute:
          BASE_DOMAIN: "${BASE_DOMAIN}"
  kustomization: |
    apiVersion: kustomize.config.k8s.io/v1beta1
    kind: Kustomization
    resources:
      - source.yaml
      - release.yaml
```

## Example: App with Secrets (vaultwarden)

```yaml
secrets:
  - name: ADMIN_TOKEN
    generate:
      type: random
      length: 64

templates:
  # ... source and release as above, plus:
  secret: |
    apiVersion: v1
    kind: Secret
    metadata:
      name: vaultwarden-config
      namespace: flux-system
    stringData:
      ADMIN_TOKEN: "${ADMIN_TOKEN}"
  kustomization: |
    apiVersion: kustomize.config.k8s.io/v1beta1
    kind: Kustomization
    resources:
      - source.yaml
      - release.yaml
      - secret.yaml    # ← includes secret.yaml
```
