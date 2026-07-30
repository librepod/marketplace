# Troubleshooting

Common deployment failures, diagnostic commands, and remediation steps for
LibrePod marketplace app verification.

## OCI Artifact Issues

### Artifact Not Found

**Symptom**: OCIRepository shows "artifact not found" or "failed to pull"

**Diagnosis**:
```bash
# Check OCIRepository status
kubectl get ocirepository marketplace-<app-name> -n flux-system -o yaml

# Verify artifact exists in GHCR locally
flux pull artifact oci://ghcr.io/librepod/marketplace/apps/<app-name>:<tag> -o /tmp/check-artifact
```

**Remediation**:
- Verify the tag exists: check the PR's GitHub Actions workflow output
- For PR artifacts: ensure the `publish-apps` workflow completed for the PR
- Force re-pull:
  ```bash
  flux reconcile source oci marketplace-<app-name> -n flux-system
  ```

### Stale Artifact Cache

**Symptom**: Source-controller serves old artifact after re-publishing at the same tag

**Diagnosis**:
```bash
# Check current digest
kubectl get ocirepository marketplace-<app-name> -n flux-system \
  -o jsonpath='{.status.artifact.digest}'
```

**Remediation**:
```bash
flux reconcile source oci marketplace-<app-name> -n flux-system
```

---

## Flux Reconciliation Issues

### Kustomization Stuck in ReconciliationFailed

**Diagnosis**:
```bash
# Status with conditions
flux get kustomization marketplace-<app-name> --kubeconfig ./librepod-dev.config

# Reconciliation logs
flux logs --kubeconfig ./librepod-dev.config \
  --kind=Kustomization --name=marketplace-<app-name> \
  -n flux-system --tail=30
```

**Common causes**:
- Build error in kustomize overlays (check YAML syntax)
- Missing variable substitution (`BASE_DOMAIN` not set)
- Dependency Kustomization not ready
- Resource conflict with existing cluster resources

### HelmRelease Stuck (RetriesExceeded)

**Symptom**: HelmRelease shows `Stalled=True`, refuses to retry even after
fixing the underlying issue.

**Remediation**:
```bash
# Check HelmRelease status
kubectl --kubeconfig ./librepod-dev.config get helmrelease -n <namespace> <name>

# Delete the stuck HelmRelease (Flux recreates from Kustomization)
kubectl --kubeconfig ./librepod-dev.config delete helmrelease -n <namespace> <name>

# Trigger reconciliation
flux reconcile kustomization marketplace-<app-name> --kubeconfig ./librepod-dev.config
```

### Gogs Source Not Updating

**Symptom**: `user-apps-source` GitRepository not picking up new commits from Gogs

**Diagnosis**:
```bash
# Check GitRepository status
flux get source git user-apps-source --kubeconfig ./librepod-dev.config

# Check Gogs pod is running
kubectl --kubeconfig ./librepod-dev.config get pods -n gogs
```

**Remediation**:
```bash
# Force reconcile the Gogs source
flux reconcile source git user-apps-source --kubeconfig ./librepod-dev.config

# If Gogs is down, check its pod
kubectl --kubeconfig ./librepod-dev.config describe pod -n gogs -l app=gogs
```

**Common causes**:
- Gogs service not running (pod crashed or not deployed)
- Authentication secret `user-apps-source-auth` expired or missing
- Port-forward disconnected during testing (if using local port-forward)

### user-apps Kustomization Not Creating App Resources

**Symptom**: `user-apps` Kustomization is READY but app resources don't appear

**Diagnosis**:
```bash
# Check if the app's OCIRepository was created
kubectl get ocirepository -n flux-system | grep marketplace-<app-name>

# Check if the app's Kustomization was created
flux get kustomization | grep marketplace-<app-name>

# Check user-apps source revision
flux get source git user-apps-source --kubeconfig ./librepod-dev.config
```

**Common causes**:
- Root `kustomization.yaml` in user-apps repo doesn't reference the app directory
- App's `kustomization.yaml` references wrong filenames
- YAML syntax error in rendered templates

---

## Pod Issues

### ImagePullBackOff

**Symptom**: Pod shows `ImagePullBackOff` or `ErrImagePull`

**Diagnosis**:
```bash
kubectl describe pod <pod-name> -n <namespace> | grep -A10 "Events"
```

**Common causes**:
- Wrong image tag in the OCI artifact (typo or tag doesn't exist)
- Private registry requiring image pull secrets
- Image doesn't exist for the node's architecture (e.g., `arm64` vs `amd64`)
- OCI artifact was published with wrong content

**Remediation**: Fix the image tag in the app's base manifests and re-publish the OCI artifact.

### CrashLoopBackOff

**Symptom**: Pod repeatedly restarts

**Diagnosis**:
```bash
# Current logs
kubectl logs <pod-name> -n <namespace> --tail=50

# Previous container logs (most useful for crash diagnosis)
kubectl logs <pod-name> -n <namespace> --previous

# Pod events
kubectl describe pod <pod-name> -n <namespace> | grep -A20 "Events"
```

**Common causes**:
- Missing ConfigMap/Secret referenced as environment variable
- App fails on startup due to invalid configuration
- Missing PVC mount (volume not bound)
- Permission issues writing to mounted volumes
- App requires a database or service that isn't ready yet

### Pending Pods

**Symptom**: Pod stuck in `Pending` state

**Diagnosis**:
```bash
kubectl describe pod <pod-name> -n <namespace> | grep -A15 "Events"
```

**Common causes**:
- PVC can't bind (StorageClass missing, NFS provisioner down)
- Insufficient CPU/memory on nodes
- Node selector or taint/toleration mismatch
- PodDisruptionBudget preventing scheduling

---

## Networking Issues

### Service Port vs targetPort Mismatch

**Symptom**: Connections fail even though pod is running and Service exists

**Cause**: Service `port` (what clients connect to) differs from `targetPort`
(container port). Clients must use the Service `port`.

**Diagnosis**:
```bash
kubectl get svc <svc-name> -n <namespace> -o yaml | grep -A5 "ports:"
```

**Remediation**: Ensure init containers and health checks connect to the
Service `port`, not the container `targetPort`.

### Ingress Not Routing Traffic

**Symptom**: External traffic not reaching the app through Ingress

**Diagnosis**:
```bash
# Check ingress exists and has address
kubectl get ingress -n <namespace>

# Check Traefik logs for routing errors
kubectl logs -n traefik -l app.kubernetes.io/name=traefik --tail=50
```

**Common causes**:
- Using `Ingress` resource instead of `IngressRoute` (Traefik prefers CRDs)
- Missing TLS certificate / cert-manager not issuing
- Middleware (auth, rate-limiting) blocking requests
- DNS not resolving the ingress host

---

## Flux Variable Substitution

### Shell Scripts Mangled by postBuild.substitute

**Symptom**: Shell scripts in ConfigMaps have `${VAR:-default}` replaced with
empty strings

**Cause**: Flux's `postBuild.substitute` processes `${VAR}` in ALL manifest
content, including ConfigMap data.

**Remediation**: Add annotation to disable substitution for that ConfigMap:
```yaml
configMapGenerator:
  - name: my-script
    files:
      - script.sh=my-script.sh
    options:
      annotations:
        kustomize.toolkit.fluxcd.io/substitute: disabled
```

### Missing Substitute Variables

**Symptom**: `${BASE_DOMAIN}` resolves to empty string in deployed manifests

**Diagnosis**:
```bash
# Check Kustomization's postBuild config
kubectl get kustomization marketplace-<app-name> -n flux-system -o yaml | grep -A10 postBuild
```

**Remediation**: Ensure `BASE_DOMAIN` is set in the Kustomization's
`postBuild.substitute` or `substituteFrom` Secret.

---

## Cleanup Issues

### Resources Not Pruned After Removal

**Symptom**: App still running after removing its directory from the Gogs repo

**Cause**: `prune: true` only prunes resources managed by the Kustomization.
If resources were created outside the Kustomization, they persist.

**Remediation**:
```bash
# Force reconcile to trigger pruning
flux reconcile kustomization user-apps \
  --kubeconfig ./librepod-dev.config --with-source

# If namespace still exists
kubectl delete namespace <namespace>

# Check for orphaned resources
kubectl get all,pvc,configmaps,secrets -n <namespace>
```

### Namespace Stuck in Terminating

**Symptom**: Namespace remains in `Terminating` state after removing app from
Gogs repo and triggering Flux pruning.

**Diagnosis**:
```bash
kubectl get namespace <namespace> -o json | jq '.spec.finalizers'
```

**Remediation**:
```bash
# Force-remove finalizers (use with caution)
kubectl patch namespace <namespace> -p '{"metadata":{"finalizers":null}}'

# If that doesn't work, force delete via proxy
kubectl proxy &
kubectl delete namespace <namespace> --api-version=v1 --grace-period=0
```

### Flux Kustomization Name Conflict

**Symptom**: New verification fails because a `marketplace-<app-name>` Kustomization
already exists from a previous run.

**Diagnosis**:
```bash
flux get kustomization | grep "marketplace-<app-name>"
```

**Remediation**:
```bash
# Delete the old Kustomization and OCIRepository
kubectl delete kustomization "marketplace-<app-name>" -n flux-system
kubectl delete ocirepository "marketplace-<app-name>" -n flux-system

# If a secret was created, delete it too
kubectl delete secret "<app-name>-config" -n flux-system

# Re-run the pipeline from Stage 4
```

### PVC Data Retention with NFS

**Note**: With NFS storage, deleting a PVC does NOT delete the underlying data
on the NFS server. New PVCs with the same name will rebind to existing data.

To truly reset PVC data, run a cleanup job with an NFS volume mount:
```bash
# Find the NFS server address from the StorageClass
NFS_SERVER=$(kubectl get storageclass nfs-client -o jsonpath='{.parameters.server}')
NFS_PATH=$(kubectl get storageclass nfs-client -o jsonpath='{.parameters.path}')

kubectl run nfs-cleanup --rm -it --restart=Never \
  --image=busybox \
  --overrides="{\"spec\":{\"containers\":[{\"name\":\"cleanup\",\"image\":\"busybox\",\"command\":[\"sh\",\"-c\",\"rm -rf /data/<namespace>/*\"],\"volumeMounts\":[{\"name\":\"nfs\",\"mountPath\":\"/data\"}]}],\"volumes\":[{\"name\":\"nfs\",\"nfs\":{\"server\":\"$NFS_SERVER\",\"path\":\"$NFS_PATH\"}}]}}"
```

---

## Cluster Access Issues

### Kubeconfig Certificate Expired

**Symptom**: `kubectl` fails with "tls: failed to verify certificate: x509: certificate
signed by unknown authority" or "Unauthorized"

**Cause**: K3s rotates server CA and client certificates. The embedded certs in
`librepod-dev.config` go stale, especially if the cluster was rebuilt or certs
were manually rotated.

**Diagnosis**:
```bash
# Test connectivity (should return JSON even on auth failure)
curl -sk https://<server-ip>:6443/healthz

# If curl works but kubectl fails → cert mismatch
kubectl --kubeconfig ./librepod-dev.config get nodes
```

**Remediation**:
```bash
# Fetch fresh kubeconfig from the cluster node (requires SSH access)
ssh root@<node-ip> "cat /etc/rancher/k3s/k3s.yaml" > ./librepod-dev.config

# Update the server address if needed (replace 127.0.0.1 with actual IP)
sed -i 's|server: https://127.0.0.1:6443|server: https://<node-ip>:6443|' ./librepod-dev.config
```

---

## Gogs Access Issues

### Port-Forward Fails

**Symptom**: `port-forward` command fails or immediately exits

**Diagnosis**:
```bash
# Check Gogs service exists
kubectl get svc -n gogs

# Check Gogs pod is running
kubectl get pods -n gogs
```

**Remediation**:
- Ensure Gogs is deployed: `flux get kustomization gogs`
- If Gogs pod is not ready, check its logs
- Try a different local port: `port-forward ... 3001:80` (3000 may be in use)

### Git Push Authentication Failure

**Symptom**: `git push` fails with authentication error

**Remediation**:
```bash
# Use URL-encoded password ('@' → '%40') to avoid ambiguity
git clone http://flux:pass%40w0rd@localhost:3000/flux/user-apps.git

# If URL-encoding issues persist, use git credential helper
git config credential.helper store
```

### Git Push Rejected (Non-Fast-Forward)

**Symptom**: `git push` fails because remote has commits not in local clone

**Remediation**:
```bash
git pull --rebase origin master
git push origin master
```
