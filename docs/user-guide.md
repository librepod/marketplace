# LibrePod Marketplace User Guide

This guide explains how to bootstrap a LibrePod cluster with the Marketplace and install applications.

## Prerequisites

- A clean k3s cluster with kubectl access
- FluxCD installed (use flux operator if deploying via LibrePod server)
- A domain name configured with DNS pointing to your cluster

## 1. Bootstrap the Marketplace

The bootstrap artifact deploys all core infrastructure: Traefik, cert-manager, Gogs, NFS provisioner, and more.

### 1.1 Create the bootstrap manifest

Create a file called `bootstrap-manifest.yaml` with the following content:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: bootstrap
  namespace: flux-system
spec:
  interval: 1h
  path: ./
  prune: true
  sourceRef:
    kind: OCIRepository
    name: librepod-bootstrap
  postBuild:
    substitute:
      BASE_DOMAIN: "example.com"  # Replace with your domain
```

**Important:** Replace `example.com` with your actual domain name.

### 1.2 Pull and apply the bootstrap OCI artifact

```bash
# Pull the bootstrap artifact
flux pull artifact oci://ghcr.io/librepod/marketplace/bootstrap:latest --output=/tmp/bootstrap

# Apply to cluster
kustomize build /tmp/bootstrap | kubectl apply -f -
```

### 1.3 Wait for infrastructure to be ready

```bash
# Monitor Flux reconciliation
flux get kustomizations -n flux-system
```

Expected output shows all kustomizations as `READY=True`. Wait 5-10 minutes for all infrastructure to be deployed.

```bash
# Check Gogs is ready
kubectl get pods -n gogs
```

Gogs should show 2 pods running: `gogs-xxxxx` and `gogs-postgres-xxxxx`.

## 2. Verify Bootstrap

### 2.1 Access Gogs

Gogs is the private git repository where your cluster state lives. The Gogs UI is available at:

```
https://gogs.<BASE_DOMAIN>
```

Login credentials:
- **Username:** `librepod`
- **Password:** `librepod`

### 2.2 Check the user-apps repo

The repo-init Job automatically created the `user-apps` repo in Gogs. Verify it exists:

1. Log into the Gogs web UI
2. You should see a repository named `user-apps`
3. Click into it to see the initial seed commit

## 3. Install an Application

To install an application, you copy the manifest templates from the catalog into your `user-apps` repo.

### 3.1 Browse the catalog

The catalog lists all available applications. You can view it by pulling the catalog artifact:

```bash
flux pull artifact oci://ghcr.io/librepod/marketplace/catalog:latest --output=/tmp/catalog
cat /tmp/catalog/catalog.yaml
```

The artifact is a directory containing both `catalog.yaml` and the `kustomization.yaml`
that renders it into the `marketplace-catalog` ConfigMap on each cluster.

Each app has:
- `name`: Technical identifier (used in filenames)
- `displayName`: Human-friendly name
- `version`: Current version
- `description`: What the app does

### 3.2 Get install templates

Each app has install templates that you copy to your `user-apps` repo. The templates are:

1. `source.yaml` - OCIRepository reference
2. `release.yaml` - Kustomization CR
3. `secret.yaml` - Secret with app secrets
4. `kustomization.yaml` - Top-level Kustomization

**Find these templates:** Look in the app's `metadata.yaml` under `spec.templates`.

### 3.3 Configure and install

#### Step 1: Clone the user-apps repo locally

```bash
# From your private Gogs repo
git clone http://librepod:librepod@gogs.<BASE_DOMAIN>/flux/user-apps.git
cd user-apps
```

#### Step 2: Copy app templates

For example, to install **Vaultwarden**:

1. Create a directory structure:
```bash
mkdir -p vaultwarden
cd vaultwarden
```

2. Copy the four templates from Vaultwarden's `metadata.yaml`:
   - Create `source.yaml` with the `source` template content
   - Create `release.yaml` with the `release` template content
   - Create `secret.yaml` with the `secret` template content
   - Create `kustomization.yaml` with the `kustomization` template content

#### Step 3: Configure parameters

Edit the templates to set your values:

1. In `release.yaml`, update `postBuild.substitute.BASE_DOMAIN` to your domain
2. In `secret.yaml`, replace `${SECRET_NAME}` placeholders or generate passwords
3. For secrets with `generate: {type: random}`, run:
   ```bash
   # Generate random password
   openssl rand -base64 32
   ```

#### Step 4: Commit to Gogs

```bash
git add .
git commit -m "Add vaultwarden"
git push origin main
```

### 3.4 Verify installation

FluxCD will detect the change and reconcile automatically:

```bash
# Watch the reconciliation
flux logs -n flux-system --kind=Kustomization --name=marketplace-vaultwarden --tail=50

# Or check status
flux get kustomizations -n flux-system
```

Expected: `marketplace-vaultwarden` shows `READY=True` after a few minutes.

```bash
# Check the app is running
kubectl get pods -n vaultwarden
```

Access the app at:
```
https://vaultwarden.<BASE_DOMAIN>
```

## 4. Update an Application

To update an app's version or configuration:

1. Clone the `user-apps` repo
2. Navigate to the app's directory
3. Edit the templates (e.g., update `spec.version` in `source.yaml`)
4. Commit and push

FluxCD will automatically apply the new version.

## 5. Remove an Application

To uninstall an app:

```bash
# Clone user-apps repo
cd user-apps

# Delete the app directory
rm -rf vaultwarden

# Commit and push
git commit -am -m "Remove vaultwarden"
git push origin main
```

FluxCD will delete the app's resources after reconciliation.

## 6. Recovery

If your cluster is lost but your Gogs data persists (or you have backups):

### 6.1 Bootstrap again

Run the same bootstrap manifest from Section 1.1.

### 6.2 Restore user-apps

The `user-apps-source` Kustomization will re-connect Flux to your private Gogs repo. If the repo exists:

1. The `user-apps-source` Flux GitRepository will sync automatically
2. All apps in the repo will be re-deployed

If the repo was also lost, recreate it by pushing templates from the catalog.

## 7. Common Issues

### Flux not reconciling

```bash
# Trigger reconciliation manually
flux reconcile kustomization bootstrap -n flux-system --with-source
```

### App not starting

```bash
# Check app status
flux get kustomizations -n flux-system
flux logs -n flux-system --kind=Kustomization --name=<app-name> --tail=50

# Check pod status
kubectl get pods -n <app-namespace>
kubectl logs -n <app-namespace> <pod-name>
```

### Secrets not applying

Flux substitutes variables after secrets are created. If secret creation fails, check the Secret in `flux-system` namespace exists:

```bash
kubectl get secrets -n flux-system
```

## Support

For issues with:
- **Bootstrapping:** Check infrastructure logs: `flux logs -n flux-system --tail=100`
- **App installation:** Check app-specific logs: `kubectl logs -n <app-namespace> <pod>`
- **FluxCD:** See [FluxCD documentation](https://fluxcd.io/docs/)
