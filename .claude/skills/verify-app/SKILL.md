---
name: verify-app
description: Run a full end-to-end deployment test for a LibrePod marketplace app (test / smoke / e2e / install-and-verify). Renders templates from metadata.yaml, commits to the Gogs user-apps repo, lets Flux reconcile, and multi-layer-verifies the result.
---

# Verify LibrePod Marketplace App

Run a full end-to-end deployment test for a LibrePod marketplace app. This skill
simulates the real user installation flow: render templates from `metadata.yaml`,
commit to the Gogs `user-apps` repo, let Flux reconcile, and verify the app reaches
a healthy state.

## Purpose

Provide a repeatable, automated verification pipeline that catches real-world
deployment issues (missing dependencies, wrong image refs, probe misconfigurations,
networking problems) that static validation alone cannot find. Use cases:

- **New app PRs** — verify the app deploys from its PR-published OCI artifact
- **Existing apps** — verify any app in the marketplace still deploys correctly
- **Version updates** — verify an app works after bumping its version/tag

## When Not to Use

- **Static validation only** — if the goal is just to check YAML syntax or schema
  validity, use `flux build` + `kubeconform` directly (see `docs/FLUX_WORKFLOW.md`)
- **App already deployed** — if the app is already running on the cluster and just
  needs a health check, run `verify-app.sh` directly without the full pipeline
- **No cluster access** — this skill requires a live Kubernetes cluster

## Prerequisites

- Access to the target Kubernetes cluster (default: `librepod-dev`, kubeconfig at
  `~/.kube/librepod-dev.config` — the sibling `librepod-*.config`
  symlinks there are production devices; never point at them)
- `flux` CLI available (enter `nix-shell shell.nix` if not installed)
- `kubectl` and `jq` CLIs available
- Gogs service running on the cluster (part of bootstrap, in `gogs` namespace)
- Target app exists in `apps/<app-name>/metadata.yaml` (local checkout) **or**
  on a remote PR branch (see PR artifact mode below)

**Kubeconfig health check** — run first before any pipeline stage. K3s rotates
client certificates; if this fails, prompt the user to update the kubeconfig:
```bash
kubectl --kubeconfig ~/.kube/librepod-dev.config get nodes
# Common failure: "tls: failed to verify certificate: x509: certificate signed by unknown authority"
# → K3s has rotated server CA. Fetch fresh kubeconfig from the node:
#   ssh root@<node-ip> "cat /etc/rancher/k3s/k3s.yaml"
```

**PR artifact mode** — when testing an app from a PR (no local checkout), the
skill scripts live in this skill's directory, not the repo. Use absolute paths:
```bash
SKILL_DIR="$(pwd)/.claude/skills/verify-app"
python3 "$SKILL_DIR/scripts/render-templates.py" ...
bash "$SKILL_DIR/scripts/verify-app.sh" ...
```

**CWD safety** — the kubeconfig path is absolute, so it stays valid when
Stage 4 (`cd` into the Gogs clone) changes the working directory. In scripts,
use the expanded form (`~` does not expand inside double quotes):
```bash
KUBECONFIG="$HOME/.kube/librepod-dev.config"
```

## Pipeline Stages

| # | Stage     | Purpose                                      | Duration |
|---|-----------|----------------------------------------------|----------|
| 1 | RESOLVE   | Read metadata.yaml, determine OCI tag        | ~5s      |
| 2 | VALIDATE  | Build + kubeconform locally (optional)       | ~10s     |
| 3 | RENDER    | Generate YAML from templates, substitute vars | ~5s      |
| 4 | COMMIT    | Port-forward Gogs, clone/push to user-apps   | ~15s     |
| 5 | RECONCILE | Trigger Flux, wait for READY=True            | ~2-5min  |
| 6 | VERIFY    | Multi-layer health checks                    | ~1min    |
| 7 | REPORT    | Summarize pass/fail                          | instant  |
| 8 | CLEANUP   | Optionally revert Gogs commit, uninstall app | ~2min    |

## Stage 1: RESOLVE

Determine the app name and OCI artifact tag.

**Inputs** (infer from context or ask the user):
- `<app-name>` — the marketplace app to test (e.g., `whoami`, `vaultwarden`)
- `<tag>` — OCI artifact tag. Common values:
  - `PR-<number>` — artifact published by a PR's CI workflow
  - `latest` — most recent publish on master
  - Specific version — e.g., `1.35.2-alpine`
  - If not specified, use `spec.version` from metadata.yaml

**Actions**:
1. Read `apps/<app-name>/metadata.yaml` to extract:
   - `spec.version` — default OCI tag
   - `spec.templates` — source, release, secret (optional), kustomization
   - `spec.params` — required parameters (typically `BASE_DOMAIN`)
   - `spec.secrets` — secrets to generate (if any)
   - `spec.dependencies` — required cluster dependencies

   For PR artifacts without a local checkout:
   ```bash
   git fetch origin <pr-branch-name>
   git show origin/<pr-branch-name>:apps/<app-name>/metadata.yaml
   ```
   Find the branch name from a PR number: `gh pr view <number> --json headRefName`

2. Determine the effective OCI tag priority: user-specified > PR-specific >
   `spec.version` > `latest`
3. Set `BASE_DOMAIN`: default `librepod.dev` for the dev cluster
4. Verify cluster dependencies are met (check that system apps like traefik,
   nfs-provisioner are deployed)
5. **Settings-backed apps**: if the app tree has an `ExternalSecret` referring to
   the `openbao` ClusterSecretStore (settings like API keys / DB passwords live in
   OpenBao, not in Git), verify the KV entry exists and seed it if not — otherwise
   pods land in `CreateContainerConfigError` and Stage 5 times out:
   ```bash
   TOKEN=$(kubectl --kubeconfig "$KUBECONFIG" get secret openbao-credentials \
     -n openbao -o jsonpath='{.data.root-token}' | base64 -d)
   kubectl --kubeconfig "$KUBECONFIG" exec -n openbao openbao-0 -- \
     env BAO_TOKEN="$TOKEN" BAO_ADDR=http://127.0.0.1:8200 \
     bao kv get apps/<app-name>  # 400/404 → seed with `bao kv put apps/<app-name> KEY=...`
   ```
   Values must match what `spec.settings.items` documents (e.g. exact key lengths).
   Reuse an existing entry — its values must stay stable across reinstalls (a
   rebound NFS volume keeps the old DB password).
6. For PR artifacts, verify the OCI artifact exists on GHCR:
   ```bash
   docker manifest inspect ghcr.io/librepod/marketplace/apps/<app-name>:<tag>
   ```

## Stage 2: VALIDATE

Optionally validate manifests locally before deploying. **Skip entirely when
testing PR artifacts** — CI already validated the manifests before publishing
the OCI artifact. Only run when testing from a local checkout with changes.

**Important**: This stage validates the app's *kustomize overlays* (the
manifests inside the OCI artifact). Stage 3 renders the *Flux wrapper*
(OCIRepository + Kustomization + Secret) from metadata.yaml templates. These
are different sources.

Build and validate with kubeconform:
```bash
flux build kustomization <app-name> \
  --kubeconfig ~/.kube/librepod-dev.config \
  --path ./apps/<app-name>/overlays/librepod \
  --local-sources GitRepository/flux-system/librepod-apps=./ \
  | kubeconform \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      -strict -summary
```

## Stage 3: RENDER

Generate Flux resources from the app's templates. Use the skill's
`render-templates.py` script for deterministic rendering:

```bash
python3 "$SKILL_DIR/scripts/render-templates.py" \
  --app <app-name> \
  --tag <oci-tag> \
  --base-domain librepod.dev \
  --output-dir /tmp/verify-app
```

The script extracts templates from `spec.templates`, substitutes `${BASE_DOMAIN}`
and secret variables, overrides the OCI tag in the source template, and writes
rendered YAML to the output directory.

**Resulting directory structure** — this is exactly what lands at `apps/<app-name>/`
in the user-apps repo. There is no root `kustomization.yaml`: Flux auto-generates one
from the whole tree, so the directory's presence IS the installation (#182).
```
/tmp/verify-app/<app-name>/
├── kustomization.yaml   (references source.yaml, release.yaml, [secret.yaml])
├── source.yaml          (OCIRepository pointing to the artifact)
├── release.yaml         (Kustomization deploying the app)
└── secret.yaml          (optional — app secrets)
```

## Stage 4: COMMIT

Push the rendered manifests to the Gogs `user-apps` repo via port-forward.

**4a. Port-forward to Gogs** (if not already running). Use a high port —
`localhost:3000` may already be forwarded to something else:
```bash
kubectl --kubeconfig "$KUBECONFIG" port-forward svc/gogs -n gogs 3999:80 &
GOGS_PF_PID=$!
sleep 2
```

**4b. Clone the user-apps repo**:
```bash
# Password "pass@w0rd" contains '@' — URL-encode as '%40'
git clone http://flux:pass%40w0rd@localhost:3999/flux/user-apps.git /tmp/verify-app/user-apps
```

**4c. Add the app manifests**:
1. Copy the rendered directory into the repo, under `apps/`:
   ```bash
   mkdir -p /tmp/verify-app/user-apps/apps
   cp -r /tmp/verify-app/<app-name> /tmp/verify-app/user-apps/apps/<app-name>
   ```
2. **Nothing else to edit.** Committing `apps/<app-name>/` IS the install — Flux
   generates the root kustomization from the tree. Do NOT create a root
   `kustomization.yaml`: it would be an allow-list that suppresses every app not
   named in it, and the next marketplace-ui boot deletes it anyway
   (`UserAppsRepoService.migrateLayout`).
3. Commit and push using `git -C` to avoid changing working directory:
   ```bash
   git -C /tmp/verify-app/user-apps add .
   git -C /tmp/verify-app/user-apps commit -m "test: add <app-name> (tag: <oci-tag>)"
   git -C /tmp/verify-app/user-apps push origin master
   ```

**4d. Keep port-forward alive** — needed for Stage 5 reconciliation monitoring.

## Stage 5: RECONCILE

Trigger Flux to pick up the Gogs commit and deploy the app.

```bash
# Reconcile the Gogs source and user-apps kustomization together
flux reconcile kustomization user-apps \
  --kubeconfig "$KUBECONFIG" --with-source
```

Wait for the app's Kustomization to appear and become READY:
```bash
for i in $(seq 1 30); do
  ks_state=$(flux get kustomization "marketplace-<app-name>" \
    --kubeconfig "$KUBECONFIG" 2>/dev/null | tail -1)
  echo "$ks_state" | grep -q "True" && echo "READY" && break
  echo "Waiting... ($i/30)"
  sleep 10
done
```

(Do not name the variable `status` — it is read-only in zsh.)

Timeout is 5 minutes (30 × 10s). If the Kustomization fails:
1. Check reconciliation logs:
   ```bash
   flux logs --kubeconfig "$KUBECONFIG" --kind=Kustomization \
     --name="marketplace-<app-name>" -n flux-system --tail=30
   ```
2. Consult `references/troubleshooting.md` for common failure patterns
3. Report the failure and stop — do not proceed to Stage 6
4. Clean up the port-forward (`kill $GOGS_PF_PID`) on early exit

## Stage 6: VERIFY

Run multi-layer verification checks. For detailed criteria per check, consult
`references/verification-checks.md`. Use the skill's `verify-app.sh` script:

```bash
bash "$SKILL_DIR/scripts/verify-app.sh" \
  --app <app-name> \
  --namespace <app-namespace> \
  --kubeconfig "$KUBECONFIG"
```

For apps without HTTP endpoints (e.g., wg-easy, step-certificates), add `--no-http`:
```bash
bash "$SKILL_DIR/scripts/verify-app.sh" --app wg-easy --no-http --kubeconfig "$KUBECONFIG"
```

**Verification layers**:
1. **Flux status** — Kustomization READY=True, OCIRepository pulled
2. **Pod health** — All Running, 0 restarts, probes passing
3. **HTTP endpoint** — Curl returns expected status code (200, 301, 401 acceptable)
4. **Log inspection** — No error-level entries in recent logs
5. **Resource audit** — PVCs bound, HelmReleases Ready, Services have endpoints

## Stage 7: REPORT

Present a summary table of all checks from the script output:

```
┌─────────────────────┬────────┬──────────────────────────────┐
│ Check               │ Status │ Details                      │
├─────────────────────┼────────┼──────────────────────────────┤
│ Flux Kustomization  │ ✅ PASS │ READY=True                   │
│ Pod Health          │ ✅ PASS │ 1/1 Running, 0 restarts      │
│ HTTP Endpoint       │ ✅ PASS │ 200 OK                       │
│ Log Inspection      │ ✅ PASS │ No errors in last 100 lines  │
│ PVCs                │ ⏭️ SKIP │ No PVCs (app may not use...) │
│ Endpoints           │ ✅ PASS │ 1 service(s) have endpoints  │
└─────────────────────┴────────┴──────────────────────────────┘
```

For failures, include: the failing check, relevant output (error messages, pod
status, log snippets), and troubleshooting suggestions from
`references/troubleshooting.md`.

**Auth-gated apps** (metadata depends on `AuthProxy`, or the IngressRoute uses
`oauth2-forwardauth`): the script probes the Service directly via port-forward,
so the request arrives **without** the SSO header/cookie. Auth-guard ERROR log
lines caused by the probe itself (e.g. `No user in header`) are expected —
classify Log Inspection as PASS-with-note after confirming every ERROR line is
a guard rejection. To verify the SSO acceptance path, simulate the proxy by
sending the injected header yourself (check the app's
`AUTHENTICATION_GUARD_HEADER` env for the spelling):
```bash
kubectl port-forward svc/<app> -n <namespace> 4123:80 &
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  -H 'X-Auth-Request-Email: probe@example.com' http://localhost:4123/
# expect a login/redirect target that differs from the no-header response
```
Caution: this can create a real user in the app's DB — clean it up (and any
ownership-role side effects) per the app's schema before finishing.

### Failure Escalation

When verification fails, follow this escalation path:
1. **Check Flux logs** — `flux logs --kind=Kustomization --name=marketplace-<app> --tail=30`
2. **Describe failing pods** — `kubectl describe pod <pod> -n <namespace>`
3. **Check previous container logs** — `kubectl logs <pod> -n <namespace> --previous`
4. **Consult `references/troubleshooting.md`** — match symptoms to known patterns
5. **Report to user** — include all diagnostic output and suggest next steps

## Stage 8: CLEANUP

Ask the user whether to clean up after the test. Default to cleaning up to avoid
leaving test resources on the cluster.

If yes:
1. **Capture PV NFS paths FIRST** — PVs disappear when Flux prunes, and deleting
   the namespace does NOT delete the NFS folders (a reinstall would rebind to
   old data):
   ```bash
   kubectl --kubeconfig "$KUBECONFIG" get pv -o json | python3 -c '
   import json,sys
   for pv in json.load(sys.stdin)["items"]:
       cr = pv["spec"].get("claimRef",{})
       if cr.get("namespace") == "<app-namespace>":
           print(cr.get("name"), pv["spec"]["nfs"]["path"])'
   ```
2. Delete the app directory from the Gogs repo using `git -C` to avoid CWD drift.
   Deleting the directory is the whole uninstall — there is no root
   `kustomization.yaml` entry to remove:
   ```bash
   git -C /tmp/verify-app/user-apps rm -r --quiet apps/<app-name>
   git -C /tmp/verify-app/user-apps commit -m "test: remove <app-name>"
   git -C /tmp/verify-app/user-apps push origin master
   ```
3. Trigger Flux reconciliation to prune resources:
   ```bash
   flux reconcile kustomization user-apps --kubeconfig "$KUBECONFIG" --with-source
   ```
4. Wait for pruning to complete, then verify resources are gone:
   ```bash
   kubectl --kubeconfig "$KUBECONFIG" get all -n <app-namespace>
   ```
5. If namespace is stuck in `Terminating`, see `references/troubleshooting.md`
   for the stuck namespace remediation.
6. **Wipe the captured NFS folders** for a true clean slate (one-off privileged
   pod on the NFS-exporting node; adjust the hostPath to the export root):
   ```bash
   cat <<'EOF' | kubectl --kubeconfig "$KUBECONFIG" apply -f -
   apiVersion: v1
   kind: Pod
   metadata:
     name: <app-name>-nfs-wipe
   spec:
     restartPolicy: Never
     tolerations: [{key: node-role.kubernetes.io/control-plane, effect: NoSchedule}]
     containers:
       - name: wipe
         image: alpine:3
         command: ["sh", "-c", "rm -rf /exports/<app-name> && echo WIPED"]
         volumeMounts: [{name: e, mountPath: /exports}]
     volumes:
       - name: e
         hostPath: {path: /exports, type: Directory}
   EOF
   kubectl --kubeconfig "$KUBECONFIG" logs <app-name>-nfs-wipe  # then delete the pod
   ```
7. Clean up port-forward and temp files:
   ```bash
   kill $GOGS_PF_PID 2>/dev/null
   rm -rf /tmp/verify-app
   ```

## Additional Resources

### Scripts
These scripts live in the skill's own directory within the project:
- **`$SKILL_DIR/scripts/render-templates.py`** — Extract and render metadata.yaml
  templates with variable substitution and OCI tag override. Requires `pyyaml`
  (`pip install pyyaml` or `nix-shell -p python3Packages.pyyaml`).
- **`$SKILL_DIR/scripts/verify-app.sh`** — Run all verification checks and output
  structured results. Supports `--no-http` for apps without HTTP endpoints.

Where `SKILL_DIR` resolves to the skill's directory (project-local at
`.claude/skills/verify-app`). Set it as shown in the Prerequisites section,
or use the full path directly.

### Reference Files
- **`references/verification-checks.md`** — Detailed verification criteria, edge
  cases, and per-check diagnostic commands
- **`references/troubleshooting.md`** — Common deployment failures, diagnostic
  commands, and remediation steps
- **`references/metadata-schema.md`** — metadata.yaml schema reference for
  understanding template rendering behavior
