# Step Certificates Application

This document describes the architecture, design decisions, and rationale behind the refactored Step Certificates deployment in LibrePod.

## Overview

The Step Certificates application provides a Certificate Authority (CA) for the LibrePod home lab cluster. It uses Smallstep's step-ca software to issue and manage X.509 certificates with integration to cert-manager via the StepIssuer custom resource.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ArgoCD GitOps Sync                              │
│                    (triggers deployment process)                        │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Sync Wave -10                                   │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  PVC: step-certificates-data                                    │    │
│  │  (Dynamic provisioning via nfs-client storage class)            │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Sync Wave: 0 (default)                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  step-certificates Deployment                                   │    │
│  │  ├─ initContainer: step-ca-init                                 │    │
│  │  │  └─ Initializes CA on PVC (runs once)                        │    │
│  │  ├─ mainContainer: step-ca                                      │    │
│  │  │  └─ Serves CA API on port 9000                               │    │
│  │  └─ sidecarContainer: root-ca-server                            │    │
│  │     └─ Serves root CA cert via HTTP (pod lifecycle)             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              ↓                                          │
│                  (Pod ready: CA initialized & running)                  │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Sync Wave: 5                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  PostSync Job: bootstrap-step-resources                         │    │
│  │  ├─ initContainer: wait-for-ca                                  │    │
│  │  │  └─ Waits for CA /health endpoint (curl health check)        │    │
│  │  └─ mainContainer: bootstrap-resources                          │    │
│  │     └─ Creates ConfigMaps and Secrets for cert-manager         │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

## Component Structure

### Base Resources (`base/`)

- **`namespace.yaml`**: Defines the `step-ca` namespace
- **Helm Chart**: Deploys the step-certificates chart from Smallstep's Helm repository

### Overlay Resources (`overlays/librepod/`)

- **`pvc.yaml`**: PersistentVolumeClaim for CA data persistence (placed in overlay, not base, to allow per-environment storage configuration)

### Components (`components/`)

#### 1. **init-container** Component

**Purpose**: Initializes the Step CA on the PVC before the main container starts.

**Key Files**:
- `components/init-container/script.sh`: CA initialization script
- `components/init-container/patch.yaml`: Adds initContainer to Deployment
- `components/init-container/kustomization.yaml`: Generates ConfigMaps using `configMapGenerator`

**Configuration** (via `configMapGenerator`):
- `step-ca-init-script`: Shell script that performs CA initialization
- `step-ca-init-env`: Environment variables (CA_URL, CA_NAME, CA_DNS_*, etc.)

**Behavior**:
1. Checks if PVC is mounted (critical requirement)
2. Checks if CA already exists (idempotent)
3. Generates passwords if not provided
4. Runs `step ca init` with configured parameters
5. Writes passwords to PVC for main container to use
6. Displays CA fingerprint for verification

**Why initContainer?**
- **Guarantees initialization**: Blocks main container until complete
- **Pod lifecycle integration**: Automatic retry on failure
- **No race conditions**: Runs in the same pod that will use the CA
- **Simpler than Jobs**: No need for sync waves or RBAC for PVC access

#### 2. **bootstrap-step-resources** Component

**Purpose**: Creates cert-manager integration resources (ConfigMaps and Secrets) after CA is running.

**Key Files**:
- `components/bootstrap-step-resources/job.yaml`: PostSync Job definition
- `components/bootstrap-step-resources/job.sh`: Bootstrap script
- `components/bootstrap-step-resources/role.yaml`, `serviceaccount.yaml`, `rolebinding.yaml`: RBAC

**Behavior**:
1. **InitContainer**: Waits for CA to be healthy using `curl` health check
2. **MainContainer**: Creates resources from PVC data:
   - ConfigMaps: `step-certificates-config`, `step-certificates-certs`
   - Secrets: `step-certificates-ca-password`, `step-certificates-provisioner-password`, `step-certificates-certificate-issuer-password`, `step-certificates-secrets` (private keys)

`step-certificates-certs` (public root + intermediate) stays local to this
namespace: step-issuer and the root-ca-server sidecar consume it here.
Cross-namespace distribution rides the same bootstrap Job: its `publish_ca`
step pushes the certs into the openbao KV store at `apps/step-ca`
(kubernetes-auth role `step-certificates`), which consumer namespaces sync
via ExternalSecret (docs/sso-app-author-guide.md §4).

**Why PostSync Job?**
- **Namespace-scoped**: Must create resources in step-ca namespace
- **One-time operation**: Only runs after initial deployment or CA re-initialization
- **RBAC requirements**: Needs permissions to create ConfigMaps and Secrets via a dedicated service account
- **Dependency on running CA**: Cannot run until CA server is healthy

#### 3. **root-ca-server** Component

**Purpose**: Sidecar container that serves the root CA certificate via HTTP for easy distribution to clients.

**Key Files**:
- `components/root-ca-server/patch-add-sidecar.yaml`: Adds nginx sidecar to Deployment
- `components/root-ca-server/nginx.conf`: nginx configuration (mounted via `configMapGenerator`-generated ConfigMap)
- `components/root-ca-server/index.html`: HTML landing page (mounted via `configMapGenerator`-generated ConfigMap)

**Behavior**:
- Mounts root CA certificate from PVC using `subPath`
- Serves HTTP on port 8080
- Provides a friendly landing page with download instructions

**Why Sidecar?**
- **Lifecyle-aligned**: Runs as long as the pod runs
- **Direct PVC access**: Mounts CA cert directly from PVC
- **No stale data**: Updates automatically when CA is re-initialized

### Patches (`overlays/librepod/`)

- **`patch-deployment.yaml`**: Configures PVC volume mounting
- **`patch-remove-test-pod.yaml`**: Removes Helm test pod from deployment

## Design Rationale

### Why initContainer Instead of Jobs for CA Initialization?

The original architecture used **three ArgoCD hook Jobs**:
1. `bootstrap-pvc` (PreSync, wave: -10) - Initialize CA on PVC
2. `bootstrap-configmap` (PreSync, wave: -5) - Create ConfigMaps (now disabled)
3. `bootstrap-step-resources` (PostSync, wave: 5) - Create ConfigMaps and Secrets for cert-manager

**Problem**: Race condition between PVC provisioning and Job execution.

**Why ArgoCD Sync Waves Didn't Work**:
- Sync waves control **creation order**, not **readiness**
- ArgoCD creates resources in wave order but doesn't wait for readiness
- PVC transitions: `Pending` → `Bound` (dynamic provisioning takes time)
- Jobs try to mount PVC before it's `Bound` → **MountFailed** error

**The initContainer Solution**:
```
Old Architecture (Race Condition):
┌─────────────┐     ┌────────────────────────────┐
│ PVC Created │ ──▶ │ Job Starts Immediately     │
│ (wave: -10) │     │ (wave: -5)                 │
│             │     │ ❌ PVC not Bound yet       │
└─────────────┘     └────────────────────────────┘

New Architecture (Pod Lifecycle):
┌──────────────────────────────────────────────────┐
│ Pod Created                                      │
│ ├─ initContainer: Waits for PVC to be Bound      │
│ │   (Kubernetes guarantees this works)           │
│ ├─ initContainer: Initializes CA on PVC          │
│ └─ mainContainer: Starts CA server               │
│     ✅ PVC is ready, CA is initialized           │
└──────────────────────────────────────────────────┘
```

**Benefits**:
1. **Eliminates race condition**: Pod lifecycle guarantees PVC is ready
2. **Reduced complexity**: From 3 Jobs to 1 Job
3. **No RBAC for PVC access**: initContainer runs in pod context
4. **Idempotent**: Checks for existing CA before initializing
5. **Automatic retry**: Pod restart on failure

### Why Keep PostSync Job for Bootstrap Resources?

The `bootstrap-step-resources` Job **must** remain as a PostSync hook because:

1. **Namespace Requirement**: Creates resources in `step-ca` namespace
2. **Dependency on Running CA**: Must wait for CA server to be healthy
3. **RBAC Requirements**: Needs a dedicated service account with permissions to create ConfigMaps and Secrets
4. **One-time Operation**: Only runs after initial deployment or re-initialization

This cannot be an initContainer because:
- InitContainers run in **pod context** (bound to the pod's service account)
- Should not run on every pod restart (only after CA initialization)

## Environment Variables

### init-container Component

| Variable | Description | Default |
|----------|-------------|---------|
| `CA_URL` | URL where CA will be accessible | `https://step-certificates.step-ca.svc.cluster.local` |
| `CA_NAME` | Human-readable CA name | `LibrePod` |
| `CA_DNS_1` | Primary DNS name for CA | `127.0.0.1` |
| `CA_DNS_2` | Secondary DNS name | `ca.libre.pod` |
| `CA_DNS_3` | K8s service DNS | `step-certificates.step-ca` |
| `CA_DNS_4` | Full K8s service DNS | `step-certificates.step-ca.svc.cluster.local` |
| `CA_ADDRESS` | CA listening address | `0.0.0.0:9000` |
| `CA_DEFAULT_PROVISIONER` | Default provisioner name | `default-jwk` |
| `CA_PASSWORD` | CA admin password | Auto-generated if not set |
| `CA_PROVISIONER_PASSWORD` | Provisioner password | Auto-generated if not set |

### bootstrap-step-resources Component

| Variable | Description | Required |
|----------|-------------|----------|
| `STEPISSUER_NAMESPACE` | Target namespace for created resources | Yes |
| `STEPPATH` | Path to CA data on PVC | Yes |

## Security Considerations

1. **Passwords**: Auto-generated passwords are stored on PVC and in Kubernetes Secrets
2. **RBAC**: Bootstrap Job uses minimal required permissions (Role, not ClusterRole where possible)
3. **Security Context**: All containers run as non-root user (UID 1000)
4. **Network Policies**: Consider adding network policies to restrict access to CA API

## Dependencies

1. **cert-manager**: Must be installed for StepIssuer resource
2. **step-issuer**: External cert-manager issuer controller ([GitHub](https://github.com/smallstep/step-issuer))
3. **Storage Class**: `nfs-client` (or other ReadWriteOnce storage class)
4. **ArgoCD**: For GitOps deployment (optional, can use plain kubectl)

## References

- [Smallstep Step CA Documentation](https://smallstep.com/docs/step-ca/)
- [StepIssuer for cert-manager](https://github.com/smallstep/step-issuer)
- [Kubernetes InitContainers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- [ArgoCD Resource Hooks](https://argocd-operator.readthedocs.io/en/latest/Reference/argocd_hook/)
