# Supply Chain Security

This document describes the Cosign-based supply chain security model for
LibrePod Marketplace. Every OCI artifact published to GHCR is cryptographically
signed, and FluxCD verifies signatures before deploying anything to the cluster.
Unsigned or tampered artifacts are rejected at deploy time.

All commands are run from the **repository root**.

For general FluxCD troubleshooting (reconciliation, drift, HelmRelease issues),
see [docs/FLUX_WORKFLOW.md](./FLUX_WORKFLOW.md).

---

## Supply Chain Security Overview

The LibrePod Marketplace uses a Cosign-based signing and verification system to
establish a supply-chain trust boundary around every artifact deployed to a
cluster.

**How it works:**

1. Every OCI artifact in GHCR (bootstrap + per-app) is cryptographically signed
   with a Cosign ECDSA-P256 key pair during CI
2. FluxCD OCIRepository resources verify signatures before pulling artifacts
3. Unsigned or tampered artifacts are rejected at deploy time (`SourceVerified=False`)
4. The trust anchor is the `cosign-pub` Secret in the `flux-system` namespace

### Signing and Verification Flow

```
Developer push --> GitHub Actions --> Cosign signs artifact --> GHCR (signed artifact)
                                                                |
                                        FluxCD OCIRepository pulls artifact
                                                                |
                                        Verifies Cosign signature against cosign-pub Secret
                                                                |
                                        Deploy (valid) / Reject (invalid or missing)
```

### Trust Boundary Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Cosign key pair | GitHub Actions Secrets (private), Kubernetes Secret (public) | Signs and verifies artifacts |
| CI signing step | `.github/workflows/publish-apps.yaml`, `.github/workflows/publish-bootstrap.yaml` | Signs both versioned and latest tags after push |
| OCIRepository verify block | `infrastructure/system-apps/*.yaml` | Tells FluxCD to verify before pulling |
| cosign-pub Secret | `infrastructure/system-configs/cosign-pub.yaml` | Contains the public key for verification |
| FluxInstance patch | Bootstrap OCIRepository verification | Verifies the bootstrap artifact |

---

## How Verification Works

### OCIRepository Verify Block

Each OCIRepository resource in the cluster includes a `spec.verify` block that
tells FluxCD source-controller to verify the artifact's Cosign signature during
pull:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: traefik
  namespace: flux-system
spec:
  interval: 10m
  url: oci://ghcr.io/librepod/marketplace/apps/traefik
  ref:
    tag: "1.0.0"
  verify:
    provider: cosign
    secretRef:
      name: cosign-pub
```

The `spec.verify` block has two fields:

- **`provider: cosign`** — Tells FluxCD to use Cosign for signature verification
- **`secretRef.name: cosign-pub`** — References the Kubernetes Secret containing
  the public key

### The cosign-pub Secret

The public key is stored as a Kubernetes Secret in the `flux-system` namespace:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cosign-pub
  namespace: flux-system
type: Opaque
stringData:
  cosign.pub: |
    -----BEGIN PUBLIC KEY-----
    MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkAgu26dkUj9UcO0zoEpli4CD8B0p
    k+YPa1RlIz625eldAwx56argKN0jqdy82pfGor3qZBA++QWwlUrHH9VK7A==
    -----END PUBLIC KEY-----
```

This Secret is deployed from `infrastructure/system-configs/cosign-pub.yaml` and
is included in the `system-configs` Kustomization.

### What Gets Verified

All 13 OCIRepository resources in the cluster have verification enabled:

- **12 marketplace app OCIRepositories** — defined in `infrastructure/system-apps/*.yaml`
  (traefik, cert-manager, step-certificates, step-issuer, casdoor, oauth2-proxy,
  gogs, nfs-provisioner, reflector, wg-easy, whoami, flux-operator-mcp)
- **1 bootstrap OCIRepository** — `marketplace-bootstrap`, configured via a
  FluxInstance kustomize patch (not a static YAML file, since the bootstrap
  OCIRepository is managed by the FluxInstance operator)

### CI Signing Pattern

Both CI workflows sign artifacts identically after pushing them to GHCR:

```yaml
- name: Install Cosign
  uses: sigstore/cosign-installer@v4.1.1
  with:
    cosign-release: 'v3.0.6'

- name: Push and sign artifact
  env:
    COSIGN_PRIVATE_KEY: ${{ secrets.COSIGN_PRIVATE_KEY }}
    COSIGN_PASSWORD: ${{ secrets.COSIGN_PASSWORD }}
  run: |
    flux push artifact oci://ghcr.io/...:version ...
    cosign sign --key env://COSIGN_PRIVATE_KEY --yes "ghcr.io/...:version"
    flux push artifact oci://ghcr.io/...:latest ...
    cosign sign --key env://COSIGN_PRIVATE_KEY --yes "ghcr.io/...:latest"
```

Both the versioned tag (e.g., `1.0.0`) and the `latest` tag are signed for
every artifact. This ensures FluxCD can verify regardless of which tag it
references.

---

## Checking Verification Status

Use these commands to check whether OCIRepository artifacts are verified on the
cluster. All commands require the `--kubeconfig` flag pointing to your cluster
kubeconfig.

### Check all OCIRepositories at a glance

```bash
flux get ocirepository --kubeconfig ./kubeconfig -n flux-system
```

This shows a table with the `READY` column. A verified artifact shows `True`; a
verification failure shows `False` with an error message.

### Inspect a specific OCIRepository in detail

```bash
kubectl get ocirepository <name> -n flux-system -o yaml | grep -A5 "verified"
```

Look for `SourceVerified: "True"` in the status. If verification failed, the
`conditions` section contains a `VerificationError` with details.

### View FluxCD reconciliation logs for verification events

```bash
flux logs --kubeconfig ./kubeconfig --kind=OCIRepository -n flux-system --tail=50
```

This shows recent reconciliation attempts including verification successes and
failures. Filter by name with `--name=<ocirepository-name>`.

### Check Kubernetes events for verification activity

```bash
kubectl get events -n flux-system --sort-by='.lastTimestamp' | grep -i verif
```

FluxCD emits Kubernetes events when verification fails, including the error
message from Cosign.

### Manually verify an artifact signature (outside the cluster)

```bash
cosign verify --key cosign.pub ghcr.io/librepod/marketplace/apps/traefik:1.0.0
```

This uses the local `cosign.pub` file to verify the artifact signature directly
against GHCR, bypassing FluxCD entirely. Useful for debugging CI issues or
confirming that an artifact was signed correctly before it reaches the cluster.

---

## Verification Failure Modes

When signature verification fails, FluxCD sets `SourceVerified=False` on the
OCIRepository and records a `VerificationError` condition. The downstream
Kustomization will not reconcile until the issue is resolved.

The following five failure modes cover all common verification failure scenarios.

### Failure Mode 1: Unsigned Artifact

**Symptom:** `SourceVerified=False`, `VerificationError` in OCIRepository status,
error message contains "no matching signatures".

**Cause:** The artifact was published before Cosign signing was enabled in CI, or
the CI signing step failed silently (e.g., missing `COSIGN_PRIVATE_KEY` secret).

**Diagnostic:**

```bash
# Check OCIRepository status
kubectl get ocirepository <name> -n flux-system -o yaml | grep -A10 "conditions"

# Verify artifact signature manually
cosign verify --key cosign.pub ghcr.io/librepod/marketplace/apps/<app>:<tag>
# Expected output: error "no matching signatures"
```

**Recovery:**

1. Re-run the CI workflow to re-publish and sign the artifact. Use the
   `workflow_dispatch` trigger on GitHub Actions with the affected app name.
2. Trigger FluxCD reconciliation after the signed artifact is available:

   ```bash
   flux reconcile kustomization system-apps --kubeconfig ./kubeconfig --with-source
   ```

3. Verify the OCIRepository shows `SourceVerified=True`.

### Failure Mode 2: Tampered Artifact

**Symptom:** `SourceVerified=False`, `VerificationError` in OCIRepository status,
error message contains "signature verification failed" or "signatures did not match".

**Cause:** Artifact content was modified after signing. This could indicate a
supply-chain attack, registry corruption, or an accidental overwrite.

**Diagnostic:**

```bash
# Manual verification fails
cosign verify --key cosign.pub ghcr.io/librepod/marketplace/apps/<app>:<tag>

# Compare artifact digest with CI build log
# The CI workflow logs the full artifact digest on push
flux get ocirepository <name> -n flux-system
```

**Recovery:**

1. Identify the last known-good commit in the repository.
2. Re-run CI from that commit to republish the artifact with a fresh signature:

   ```bash
   # Via GitHub Actions: re-run the publish-apps or publish-bootstrap workflow
   # for the affected commit
   ```

3. Trigger reconciliation on the cluster:

   ```bash
   flux reconcile kustomization system-apps --kubeconfig ./kubeconfig --with-source
   ```

4. If you suspect a supply-chain attack, also rotate the signing key pair (see
   Key Rotation below) and audit the CI pipeline for unauthorized changes.

### Failure Mode 3: Wrong Key

**Symptom:** `SourceVerified=False`, `VerificationError` in OCIRepository status,
error message contains "no matching signatures" (identical to unsigned artifact).

**Cause:** The artifact was signed with a different Cosign key pair than the one
whose public key is stored in the cluster's `cosign-pub` Secret.

**Diagnostic:**

```bash
# Verify with the correct public key (if available)
cosign verify --key <correct-key>.pub ghcr.io/librepod/marketplace/apps/<app>:<tag>

# Check what public key is in the cluster
kubectl get secret cosign-pub -n flux-system -o jsonpath='{.stringData.cosign\.pub}'
```

If the artifact verifies with a different key but not with the cluster key, the
keys are mismatched.

**Recovery:**

1. Determine which key pair was used to sign the artifact. Check GitHub Actions
   Secrets for `COSIGN_PRIVATE_KEY` and compare the corresponding public key.
2. Update the `cosign-pub` Secret with the correct public key:

   ```bash
   kubectl --kubeconfig ./kubeconfig apply -f infrastructure/system-configs/cosign-pub.yaml
   ```

3. Trigger reconciliation:

   ```bash
   flux reconcile kustomization system-apps --kubeconfig ./kubeconfig --with-source
   ```

### Failure Mode 4: Missing cosign-pub Secret

**Symptom:** OCIRepository shows an error condition referencing a missing secret
named "cosign-pub". The `SourceVerified` field may not appear at all, and the
OCIRepository status shows `Ready=False` with a secret lookup error.

**Cause:** The `cosign-pub` Secret was not deployed to the cluster. This can
happen if the `system-configs` Kustomization was skipped during bootstrap, or
if the Secret was accidentally deleted.

**Diagnostic:**

```bash
# Check if the Secret exists
kubectl get secret cosign-pub -n flux-system
# Expected output if missing: Error from server (NotFound)
```

**Recovery:**

1. Apply the Secret from the repository:

   ```bash
   kubectl --kubeconfig ./kubeconfig apply -f infrastructure/system-configs/cosign-pub.yaml
   ```

2. Trigger reconciliation to re-attempt verification:

   ```bash
   flux reconcile kustomization system-apps --kubeconfig ./kubeconfig --with-source
   ```

3. Verify the Secret exists and OCIRepositories recover:

   ```bash
   kubectl get secret cosign-pub -n flux-system
   flux get ocirepository --kubeconfig ./kubeconfig -n flux-system
   ```

### Failure Mode 5: Key Rotation Scenario

**Symptom:** After a key rotation, all existing artifacts fail verification with
"no matching signatures". New artifacts signed with the new key verify correctly.

**Cause:** Artifacts in GHCR were signed with the old key pair, but the cluster
now has the new `cosign-pub` Secret containing only the new public key.

**Diagnostic:**

```bash
# Old artifacts fail with new key
cosign verify --key new-cosign.pub ghcr.io/librepod/marketplace/apps/<app>:<old-tag>
# Expected: error "no matching signatures"

# Old artifacts pass with old key (if available)
cosign verify --key old-cosign.pub ghcr.io/librepod/marketplace/apps/<app>:<old-tag>
# Expected: verification succeeds
```

**Recovery:**

1. Re-sign all existing artifacts with the new key. This requires running CI with
   the new `COSIGN_PRIVATE_KEY` secret. Use `workflow_dispatch` with `["all"]` to
   re-publish and re-sign every app.
2. Re-publish the bootstrap artifact as well (it uses a separate workflow).
3. Trigger reconciliation on all clusters:

   ```bash
   flux reconcile kustomization system-apps --kubeconfig ./kubeconfig --with-source
   flux reconcile kustomization system-configs --kubeconfig ./kubeconfig --with-source
   ```

---

## Key Rotation

This section describes the key rotation procedure at a **conceptual level**.
Key rotation is not currently implemented but will be needed in the future
(OPS-01 in v2 requirements). This guide provides sufficient detail to plan the
implementation.

### Rotation Steps

1. **Generate a new Cosign key pair:**

   ```bash
   cosign generate-key-pair
   ```

   This creates `cosign.key` (private) and `cosign.pub` (public). Protect the
   private key — it is the trust anchor for the entire supply chain.

2. **Upload the new private key to GitHub Actions Secrets:**

   Update the `COSIGN_PRIVATE_KEY` and `COSIGN_PASSWORD` secrets in the
   GitHub repository settings (Settings > Secrets and variables > Actions).

3. **Update the cosign-pub Secret in the repository:**

   Replace the public key in `infrastructure/system-configs/cosign-pub.yaml`
   with the new `cosign.pub` content.

4. **Push changes to trigger CI:**

   Pushing the updated `cosign-pub.yaml` to `master` triggers the
   `publish-bootstrap` workflow (which watches `infrastructure/**`). Existing
   app artifacts are not automatically re-signed — run the `publish-apps`
   workflow with `["all"]` to re-publish and re-sign all apps.

5. **Clusters pick up the new key:**

   New clusters bootstrapping from the repository get the new key automatically.
   Existing clusters reconcile and pick up the updated `cosign-pub` Secret
   through the `system-configs` Kustomization.

6. **Discard the old key:**

   Once all clusters have reconciled and all artifacts are re-signed with the
   new key, the old key pair can be safely discarded. There is no reason to
   keep it once no artifacts reference it.

### Considerations

- **Transition period:** During rotation, there is a window where old artifacts
  (signed with the old key) fail verification against clusters that have already
  picked up the new public key. Minimize this window by re-signing all artifacts
  quickly after updating the cluster Secret.
- **Multiple keys:** FluxCD does not support verifying against multiple public
  keys simultaneously. A full rotation (old key out, new key in) is required.
- **Automation opportunity:** A future enhancement could automate re-signing as
  part of the rotation process, reducing the transition window to near zero.

---

## Quick Reference

| Goal | Command |
|------|---------|
| Check all OCIRepository verification status | `flux get ocirepository --kubeconfig ./kubeconfig -n flux-system` |
| View verification events | `flux logs --kubeconfig ./kubeconfig --kind=OCIRepository -n flux-system --tail=50` |
| Manually verify an artifact | `cosign verify --key cosign.pub ghcr.io/librepod/marketplace/apps/<app>:<tag>` |
| Check cosign-pub Secret exists | `kubectl get secret cosign-pub -n flux-system` |
| Force reconciliation after fix | `flux reconcile kustomization system-apps --kubeconfig ./kubeconfig --with-source` |
| Reconcile system-configs (Secret changes) | `flux reconcile kustomization system-configs --kubeconfig ./kubeconfig --with-source` |
| Inspect OCIRepository verification error | `kubectl get ocirepository <name> -n flux-system -o yaml \| grep -A10 conditions` |
| Generate a new Cosign key pair | `cosign generate-key-pair` |
| Re-publish all apps via CI | GitHub Actions: Run `Publish App Artifacts` workflow with `["all"]` |

For general FluxCD troubleshooting (HelmRelease stuck states, service port
confusion, feature branch testing), see [docs/FLUX_WORKFLOW.md](./FLUX_WORKFLOW.md).
