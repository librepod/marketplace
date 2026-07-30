# Example: Verify Whoami App

A complete example of verifying the `whoami` app through the full pipeline.

## Context

User request: "test the whoami app"
App: `whoami` — simple echo server, no secrets, no PVCs.

## Commands Run

### Stage 1: RESOLVE

```bash
# Read metadata
cat apps/whoami/metadata.yaml
# → version: "1.10.1", no secrets, depends on traefik

# Verify cluster is accessible
kubectl --kubeconfig ./librepod-dev.config get nodes
# → NAME   STATUS   ROLES   AGE   VERSION
# → dev    Ready    <none>  42d   v1.31.5+k3s1

# Check dependencies
kubectl --kubeconfig ./librepod-dev.config get pods -n traefik
# → traefik-xxx  Running
```

### Stage 2: VALIDATE (skipped)

No local changes to validate — testing existing app.

### Stage 3: RENDER

```bash
SKILL_DIR="$(pwd)/.claude/skills/verify-app"

python3 "$SKILL_DIR/scripts/render-templates.py" \
  --app whoami \
  --tag 1.10.1 \
  --base-domain librepod.dev \
  --output-dir /tmp/verify-app
```

Expected output:
```
Rendering app: whoami
  OCI tag: 1.10.1
  Base domain: librepod.dev
  Output: /tmp/verify-app/whoami

  Rendered: source.yaml
  Rendered: release.yaml
  Rendered: kustomization.yaml

Rendered 3 files for whoami
```

### Stage 4: COMMIT

```bash
KUBECONFIG="$(pwd)/librepod-dev.config"

# Port-forward Gogs
kubectl --kubeconfig "$KUBECONFIG" port-forward svc/gogs -n gogs 3000:80 &
GOGS_PF_PID=$!
sleep 2

# Clone, add, commit, push
git clone http://flux:pass%40w0rd@localhost:3000/flux/user-apps.git /tmp/verify-app/user-apps
cp -r /tmp/verify-app/whoami /tmp/verify-app/user-apps/whoami

# Update root kustomization.yaml
cat > /tmp/verify-app/user-apps/kustomization.yaml << 'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - whoami/
EOF

git -C /tmp/verify-app/user-apps add .
git -C /tmp/verify-app/user-apps commit -m "test: add whoami (tag: 1.10.1)"
git -C /tmp/verify-app/user-apps push origin master
```

### Stage 5: RECONCILE

```bash
flux reconcile kustomization user-apps --kubeconfig "$KUBECONFIG" --with-source

# Wait for readiness
for i in $(seq 1 30); do
  status=$(flux get kustomization marketplace-whoami --kubeconfig "$KUBECONFIG" 2>/dev/null | tail -1)
  echo "$status" | grep -q "True" && echo "READY" && break
  echo "Waiting... ($i/30)"
  sleep 10
done
```

Expected: `READY` within 2-3 minutes.

### Stage 6: VERIFY

```bash
bash "$SKILL_DIR/scripts/verify-app.sh" \
  --app whoami \
  --namespace whoami \
  --kubeconfig "$KUBECONFIG"
```

Expected output:
```
==========================================
  Verifying: whoami
  Namespace: whoami
==========================================

▸ Checking Flux reconciliation...
▸ Checking pod health...
▸ Checking HTTP endpoint...
▸ Checking logs...
▸ Auditing resources...

==========================================
  Results: 6 passed, 0 failed, 0 warnings
==========================================

Check                    Status     Details
─────                    ───────    ───────
Flux Kustomization       ✅ PASS   READY=True
OCIRepository            ✅ PASS   Artifact pulled (digest: sha256:abc123...)
Pod Health               ✅ PASS   1 pod(s) Running
Restarts                 ✅ PASS   0 restarts
Probes                   ✅ PASS   All pods Ready (probes passing)
HTTP Endpoint            ✅ PASS   HTTP 200
Log Inspection           ✅ PASS   0 error-level entries in last 100 lines
PVCs                     ⏭️  SKIP  No PVCs (app may not use persistent storage)
Endpoints                ✅ PASS   1 service(s) have endpoints
Resources                ✅ PASS   0 ConfigMap(s), 0 Secret(s)

✅ Verification PASSED for whoami
```

### Stage 8: CLEANUP

```bash
# Remove app from Gogs
rm -rf /tmp/verify-app/user-apps/whoami
echo 'apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: []' > /tmp/verify-app/user-apps/kustomization.yaml
git -C /tmp/verify-app/user-apps add .
git -C /tmp/verify-app/user-apps commit -m "test: remove whoami"
git -C /tmp/verify-app/user-apps push origin master

# Trigger Flux pruning
flux reconcile kustomization user-apps --kubeconfig "$KUBECONFIG" --with-source

# Verify cleanup
kubectl --kubeconfig "$KUBECONFIG" get all -n whoami
# → No resources found

# Clean up
kill $GOGS_PF_PID 2>/dev/null
rm -rf /tmp/verify-app
```
