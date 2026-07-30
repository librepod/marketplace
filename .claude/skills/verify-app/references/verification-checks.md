# Verification Checks

Detailed criteria for each verification layer used during app testing.

## 1. Flux Status

### Primary Check
- `flux get kustomization marketplace-<app-name>` shows `READY=True`
- Revision matches expected OCI artifact tag
- No suspended resources

### Extended Checks
- `flux tree kustomization marketplace-<app-name>` shows complete resource tree
  with all expected resources (Deployments, Services, Ingress, etc.)
- `flux logs --kind=Kustomization --name=marketplace-<app-name> --tail=30`
  shows no errors
- OCIRepository artifact pulled:
  ```bash
  kubectl get ocirepository marketplace-<app-name> -n flux-system
  ```
  Should show the artifact URL and digest matching the expected tag.

### Failure Indicators
| Message Pattern | Meaning |
|----------------|---------|
| "artifact not found" | OCI tag doesn't exist in GHCR |
| "build failed" | Kustomize build error in app manifests |
| "health check failed" | Probes failing on deployed pods |
| "dependency not ready" | `dependsOn` Kustomization not READY |

### Diagnostic Commands
```bash
# Full Kustomization status with conditions
kubectl get kustomization marketplace-<app-name> -n flux-system -o yaml

# OCIRepository details
kubectl get ocirepository marketplace-<app-name> -n flux-system -o yaml

# Recent reconciliation events
flux logs --kubeconfig ./librepod-dev.config \
  --kind=Kustomization --name=marketplace-<app-name> \
  -n flux-system --tail=50
```

---

## 2. Pod Health

### Primary Check
- All pods in `Running` state
- Ready count matches desired count (e.g., `1/1`)
- Restart count is 0 (or < 3 for apps with init containers)

### Probe Verification
```bash
# Pod Ready condition
kubectl get pod <pod-name> -n <namespace> \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
# Expected: True

# Restart count
kubectl get pod <pod-name> -n <namespace> \
  -o jsonpath='{.status.containerStatuses[0].restartCount}'
# Expected: 0

# Pod phase
kubectl get pod <pod-name> -n <namespace> \
  -o jsonpath='{.status.phase}'
# Expected: Running
```

### CrashLoopBackOff Detection
```bash
kubectl get pods -n <namespace> -o json | \
  jq -r '.items[] | select(.status.containerStatuses[]?.state.waiting.reason == "CrashLoopBackOff") | .metadata.name'
```
Any output = failure.

### Common Pod Failure Reasons
| Reason | Cause | Action |
|--------|-------|--------|
| `ImagePullBackOff` | Wrong image tag / no registry access | Verify OCI artifact contains correct image refs |
| `CrashLoopBackOff` | App crashing on startup | Check `kubectl logs <pod> --previous` |
| `Pending` | PVC can't bind / no node resources | Check StorageClass, NFS provisioner |
| `OOMKilled` | Memory limit too low | Check app's memory requirements |
| `CreateContainerConfigError` | Missing ConfigMap/Secret | Verify all referenced volumes exist |

### Acceptable vs Problematic Restarts
- ✅ **0 restarts** — ideal
- ⚠️ **1-2 restarts** — may be acceptable if app has init containers or self-healing behavior
- ❌ **3+ restarts** — investigate immediately, likely CrashLoop

---

## 3. HTTP Endpoint

### When to Check
Only for apps that expose an HTTP service (most apps with an Ingress). Skip for
headless services or non-HTTP protocols (e.g., wg-easy's WireGuard UDP port).

### Method 1: Port-Forward (recommended for dev testing)
```bash
# Find the service and port
kubectl get svc -n <namespace>

# Port-forward
kubectl --kubeconfig ./librepod-dev.config \
  port-forward svc/<svc-name> -n <namespace> 18080:<port> &
PF_PID=$!
sleep 3

# Test response
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:18080/ --max-time 10)
echo "HTTP Status: $HTTP_CODE"

# Optional: check response body
curl -s http://localhost:18080/ | head -20

# Clean up
kill $PF_PID 2>/dev/null
```

### Method 2: Ingress (if Traefik + DNS configured)
```bash
# Get the ingress host
kubectl get ingress -n <namespace>

# Curl via ingress (may need /etc/hosts entry or DNS)
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  http://<app-name>.librepod.dev/
```

### Acceptable Status Codes
| Code | Meaning | Verdict |
|------|---------|---------|
| 200 | OK | ✅ PASS |
| 301/302 | Redirect | ✅ PASS (service is running, redirecting to setup/login) |
| 401/403 | Unauthorized | ✅ PASS (service is running, auth required) |
| 502/503 | Bad Gateway | ❌ FAIL (upstream not ready or misconfigured) |
| 504 | Gateway Timeout | ❌ FAIL (app taking too long to respond) |
| 000 | Connection failed | ⚠️ SKIP or ❌ FAIL depending on context |

### Common Issues
- **Connection refused**: Service not running, wrong port, or port-forward failed
- **502 Bad Gateway**: App not ready, probe failing, or Service targetPort mismatch
- **503 Service Unavailable**: App starting up or temporarily overloaded

---

## 4. Log Inspection

### What to Look For
1. **Error-level entries**: `ERROR`, `FATAL`, `panic`, `exception`, `segfault`
2. **Crash indicators**: `SIGTERM`, `OOMKilled`, `terminated`
3. **Startup failures**: "failed to connect", "connection refused", "permission denied"
4. **Configuration errors**: "invalid config", "missing required", "unknown option"

### Commands
```bash
# Recent logs
kubectl --kubeconfig ./librepod-dev.config \
  logs -n <namespace> -l app=<app-name> --tail=100

# Grep for errors
kubectl --kubeconfig ./librepod-dev.config \
  logs -n <namespace> -l app=<app-name> --tail=100 | \
  grep -ciE 'error|fatal|panic|exception'

# Previous container (if restarted)
kubectl --kubeconfig ./librepod-dev.config \
  logs -n <namespace> -l app=<app-name> --previous

# All containers (if pod has sidecars)
kubectl --kubeconfig ./librepod-dev.config \
  logs -n <namespace> -l app=<app-name> --all-containers --tail=50
```

### Acceptable vs Problematic Logs
- ✅ Warnings about deprecated features (informational)
- ✅ "Starting server on port X" (normal startup)
- ✅ Connection attempts during init (transient)
- ✅ Debug/info level noise
- ❌ Repeated connection failures after startup
- ❌ Out-of-memory errors (`OOMKilled`)
- ❌ Stack traces / panics
- ❌ Permission denied on critical paths
- ❌ "configuration invalid" or "missing required field"

### Threshold
- **0 errors**: ✅ PASS
- **1-2 errors**: ⚠️ WARN (investigate if consistent pattern)
- **3+ errors**: ❌ FAIL

---

## 5. Resource Audit

### PVCs
```bash
kubectl --kubeconfig ./librepod-dev.config get pvc -n <namespace>
```
All PVCs should be in `Bound` state. If `Pending`, check:
- StorageClass exists: `kubectl get storageclass`
- NFS provisioner running: `kubectl get pods -n nfs-provisioner`

### ConfigMaps and Secrets
```bash
kubectl --kubeconfig ./librepod-dev.config get configmaps,secrets -n <namespace>
```
- ConfigMaps referenced by Deployment should exist
- Secrets referenced by `substituteFrom` should exist (check `flux-system` namespace
  for marketplace-managed secrets)

### Services and Endpoints
```bash
kubectl --kubeconfig ./librepod-dev.config get svc,endpoints -n <namespace>
```
- Each Service should have associated Endpoints
- Endpoints with `<none>` addresses → pods not ready or label selector mismatch

### Deployments and StatefulSets
```bash
kubectl --kubeconfig ./librepod-dev.config get deployments,statefulsets -n <namespace>
```
- `READY` column: should match desired count (e.g., `1/1`)
- `UP-TO-DATE` should equal desired
- `AVAILABLE` should equal desired

### Ingress
```bash
kubectl --kubeconfig ./librepod-dev.config get ingress -n <namespace>
```
- Ingress should have an ADDRESS assigned (Traefik assigns one)
- TLS configuration should reference a valid certificate

### Full Resource Dump (for debugging)
```bash
kubectl --kubeconfig ./librepod-dev.config get all -n <namespace>
kubectl --kubeconfig ./librepod-dev.config get pvc,configmaps,secrets -n <namespace>
```

---

## 6. HelmRelease Status

### When to Check
For apps deployed via Helm through Flux (HelmRelease CRD), in addition to the
Kustomization check.

### Primary Check
- `kubectl get helmrelease -n <namespace>` shows `READY=True`
- Revision matches expected chart version

### Diagnostic Commands
```bash
# HelmRelease status with conditions
kubectl get helmrelease -n <namespace> <name> -o yaml

# Check for specific failure conditions
kubectl get helmrelease -n <namespace> <name> \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")]}'

# Helm release history (if using Helm's own history)
helm history <release-name> -n <namespace>
```

### Common HelmRelease Failures
| Pattern | Cause | Action |
|---------|-------|--------|
| `install retries exhausted` | Chart values invalid or dependency missing | Check `flux logs` for the specific error |
| `chart pull failed` | OCI artifact corrupted or wrong tag | Re-publish the artifact |
| `test failed` | Helm test hook failed | Check test pod logs |
| `upgrade failed` | Incompatible values change | Review `helm diff` |

---

## App-Specific Considerations

### Apps Without HTTP Endpoints
Some apps don't expose HTTP (e.g., wg-easy has WireGuard UDP, step-certificates
has ACME protocol). For these:
- Skip the HTTP endpoint check (pass `--no-http` to verify-app.sh)
- Verify the TCP/UDP port is listening via pod logs or port-forward test
- Check that the Service exists with the correct port definition

### Apps with Init Containers
Init containers may fail before the main container starts. Check:
```bash
kubectl logs <pod-name> -n <namespace> --init-containers
```

### Apps with Long Startup Times
Some apps (e.g., databases, Java apps) take time to become ready. Increase
the reconciliation wait timeout and probe patience accordingly.

### StatefulSet Apps (Databases)
Apps like PostgreSQL, MySQL, or Seafile use StatefulSets with ordered rollouts:
- Verify each pod becomes Ready in sequence (pod-0, then pod-1, etc.)
- Check PVC binding for each volume claim template
- Ensure the headless Service exists for stable network identities
```bash
kubectl get statefulset -n <namespace>
kubectl get pvc -n <namespace>
```

### CronJob Apps
Apps with CronJob resources don't have continuously running pods:
- Verify the CronJob exists and is not suspended
- Check the last job run for success/failure
```bash
kubectl get cronjob -n <namespace>
kubectl get jobs -n <namespace>
```

### HTTPS/TLS Verification
Apps behind Traefik with cert-manager may need HTTPS verification. When testing
via Ingress (not port-forward), use HTTPS:
```bash
# Check TLS certificate status
kubectl get certificate -n <namespace>

# Test via HTTPS (requires DNS or /etc/hosts)
curl -sk https://<app-name>.librepod.dev/ -o /dev/null -w "%{http_code}\n"
```
Port-forward bypasses TLS entirely, which is fine for basic health checks.
