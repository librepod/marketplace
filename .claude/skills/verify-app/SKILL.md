---
name: verify-app
description: This skill should be used when the user asks to "test an app", "verify app deployment", "install and verify an app", "e2e test for an app", "integration test an app", "smoke test an app", "validate an app", "run end-to-end test", or mentions testing/verifying a LibrePod marketplace app deployment. Simulates the full user installation flow through the Gogs user-apps repo with multi-layer verification.
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
  `./librepod-dev.config`)
- `flux` CLI available (enter `nix-shell shell.nix` if not installed)
- `kubectl` and `jq` CLIs available
- Gogs service running on the cluster (part of bootstrap, in `gogs` namespace)
- Target app exists in `apps/<app-name>/metadata.yaml` (local checkout) **or**
  on a remote PR branch (see PR artifact mode below)

**Kubeconfig health check** — run first before any pipeline stage. K3s rotates
client certificates; if this fails, prompt the user to update the kubeconfig:
```bash
kubectl --kubeconfig ./librepod-dev.config get nodes
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

**CWD safety** — use absolute paths for `--kubeconfig` throughout the
pipeline. Stage 4 (`cd` into the Gogs clone) changes the working directory,
breaking relative `./librepod-dev.config` references in subsequent stages.
Set a variable early:
```bash
KUBECONFIG="$(pwd)/librepod-dev.config"
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
5. For PR artifacts, verify the OCI artifact exists on GHCR:
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
  --kubeconfig ./librepod-dev.config \
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

**Resulting directory structure**:
```
/tmp/verify-app/<app-name>/
├── kustomization.yaml   (references source.yaml, release.yaml, [secret.yaml])
├── source.yaml          (OCIRepository pointing to the artifact)
├── release.yaml         (Kustomization deploying the app)
└── secret.yaml          (optional — app secrets)
```

## Stage 4: COMMIT

Push the rendered manifests to the Gogs `user-apps` repo via port-forward.

**4a. Port-forward to Gogs** (if not already running):
```bash
kubectl --kubeconfig "$KUBECONFIG" port-forward svc/gogs -n gogs 3000:80 &
GOGS_PF_PID=$!
sleep 2
```

**4b. Clone the user-apps repo**:
```bash
# Password "pass@w0rd" contains '@' — URL-encode as '%40'
git clone http://flux:pass%40w0rd@localhost:3000/flux/user-apps.git /tmp/verify-app/user-apps
```

**4c. Add the app manifests**:
1. Copy the rendered directory into the repo:
   ```bash
   cp -r /tmp/verify-app/<app-name> /tmp/verify-app/user-apps/<app-name>
   ```
2. Update the root `kustomization.yaml` in the repo to include the new app
   directory. If none exists, create one; if one exists, append `- <app-name>/`.
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
  status=$(flux get kustomization "marketplace-<app-name>" \
    --kubeconfig "$KUBECONFIG" 2>/dev/null | tail -1)
  echo "$status" | grep -q "True" && echo "READY" && break
  echo "Waiting... ($i/30)"
  sleep 10
done
```

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
1. Remove the app directory from the Gogs repo using `git -C` to avoid CWD drift:
   ```bash
   rm -rf /tmp/verify-app/user-apps/<app-name>
   # Remove from root kustomization.yaml
   git -C /tmp/verify-app/user-apps add .
   git -C /tmp/verify-app/user-apps commit -m "test: remove <app-name>"
   git -C /tmp/verify-app/user-apps push origin master
   ```
2. Trigger Flux reconciliation to prune resources:
   ```bash
   flux reconcile kustomization user-apps --kubeconfig "$KUBECONFIG" --with-source
   ```
3. Wait for pruning to complete, then verify resources are gone:
   ```bash
   kubectl --kubeconfig "$KUBECONFIG" get all -n <app-namespace>
   ```
4. If namespace is stuck in `Terminating`, see `references/troubleshooting.md`
   for the stuck namespace remediation.
5. Clean up port-forward and temp files:
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
