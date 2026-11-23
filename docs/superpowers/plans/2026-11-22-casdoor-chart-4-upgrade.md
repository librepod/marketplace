# Casdoor Chart 3.106.0 → 4.29.0 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the casdoor chart pin 3.106.0 → 4.29.0 across all three lockstep pins, delete the postRender probe patch and the CI guard that watched it, and prove by render verification that the chart's native probes and values contracts replace the patch exactly (issue #375).

**Architecture:** Pure manifest + CI change — no application code. The pin bump and the postRender patch deletion land as one atomic commit: deleting the patch before the bump would reintroduce #366, and bumping without deleting keeps the silent-mismatch risk class the issue retires. The guard script and its workflow step die in a second commit. All correctness evidence is static (helm-template render diffs against a 3.106.0 baseline, plus an endpoint sweep of the two codebases that call casdoor); live checks are a maintainer handoff — production kubeconfigs are off-limits to agent sessions per the repo's skills.

**Tech Stack:** Flux CD (HelmRelease, OCIRepository, Kustomization), Helm OCI chart `oci://registry-1.docker.io/casbin/casdoor-helm-charts`, kustomize, kubeconform, yq (mikefarah syntax), GitHub Actions, bash.

**Spec:** `docs/superpowers/specs/2026-11-22-casdoor-chart-4-upgrade-design.md` (issue #375). The spec's §3 facts are verified at source — do **not** re-derive them; spec §7 mandates re-running the render verification and endpoint sweep in the implementation PR, which is exactly what Tasks 1 and 3 do.

**Execution location:** The spec and this plan are committed on branch `factory8/x8luwu`. Work on a branch that contains those commits (so the spec path resolves); the implementation PR targets `master`. Never merge your own PR.

## Global Constraints

- **Lockstep — chart version == casdoor app version.** All three pins read `"4.29.0"` and move in ONE commit:
  - `apps/casdoor/base/ocirepository.yaml` `spec.ref.tag` (chart)
  - `apps/casdoor/metadata.yaml` `spec.version` (catalog)
  - `infrastructure/system-apps/casdoor.yaml` `spec.ref.tag` (the bootstrap's pin of `ghcr.io/librepod/marketplace/apps/casdoor` — the third pin the issue's checklist missed)
- **No `probe:` values override and no postRenderers block** in the final state — the chart's defaults ARE the fix (spec Approach D is an anti-goal).
- **No code changes** under `casdoor-sso-controller/` or `ui/` (spec §3 verified the 4.x contracts; Task 3 re-verifies statically).
- **Values stay verbatim** apart from deletions: `envFrom` (casdoor-env ConfigMap), `service.port: 80`, the `/data` + `/tmp` mounts, `extraVolumes` (casdoor-data PVC).
- **`dataSourceName` stays exactly as-is** — do not adopt the chart 4.x `busy_timeout`/WAL pragmas; WAL relies on shared-memory mmap and is unsafe on the NFS-backed `/data` PVC (spec §5).
- **The Renovate comment in metadata.yaml stays as-is** (same `depName=registry-1.docker.io/casbin/casdoor-helm-charts` under Approach A).
- **Public-repo privacy (CLAUDE.md):** no personal device names, hostnames, domains, or incident narratives in commits, the PR, or docs — say "the production cluster", "the nightly backup".
- **Non-interactive shell (CLAUDE.md):** `rm -f`, `cp -f`, `mv -f`.
- **Commits:** conventional-commit prefixes; end each message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Repo tooling appends a `Factory8-Run:` trailer after it on every commit — expected, leave it.
- **Tooling:** helm/kustomize/kubectl/yq/flux are on PATH (or via `nix-shell shell.nix --run '…'`). `helm template` pulls the OCI chart and kubeconform fetches its CRD catalog — both need network.
- **The PR stays open for review** and ends with the attribution line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

Failure modes the spec implies but no live test exercises — each pinned by a task's assertions:

1. **Fresh-install first start (#366) and warmup under load (#273):** on a wiped PVC, org/app/admin/cert seeding over NFS takes minutes; the container must not be liveness-killed mid-init. A ≥5-minute startup budget (periodSeconds 10 × failureThreshold 30) with timeoutSeconds 5 must come from chart defaults alone. → Task 1 Step 6 probe assertions.
2. **4.x values-contract drift:** if `envFrom`, `service.port`, `extraVolumeMounts`, or `extraVolumes` stopped rendering, casdoor would silently write its DB to container-local disk and lose every SSO session on pod restart — no CI would notice. → Task 1 Step 6 contract assertions + Step 7's exhaustive diff whitelist.
3. **Partial lockstep bump:** a missed third pin (`infrastructure/system-apps/casdoor.yaml`) leaves production clusters deploying artifact 3.106.0 forever with no failing signal anywhere. → Task 1 Step 4 stale-pin grep.
4. **Dangling references after deletion:** a workflow step invoking the deleted guard turns every later casdoor PR red; a stale reference misleads the next reader. → Task 2 Step 3 repo-wide grep.
5. **Admin-API drift in casdoor 4.x:** the controller and marketplace-ui onboarding call ~16 casdoor endpoints over query-string M2M auth; a dropped route or changed auth breaks SSO cluster-wide at rollout — CI never sees it. → Task 3 Steps 1–2 static sweep + the handoff checklist's controller round-trip and real sign-in.

---

### Task 1: Bump the three lockstep pins and delete the postRender probe patch (one atomic commit)

**Files:**
- Modify: `apps/casdoor/base/ocirepository.yaml:10`
- Modify: `apps/casdoor/metadata.yaml:14`
- Modify: `infrastructure/system-apps/casdoor.yaml:10`
- Modify: `apps/casdoor/overlays/librepod/patch-helmrelease.yaml` (delete lines 36–38, 44–46, and 48–100; reword line 16)

**Interfaces:**
- Consumes: repo as-is; chart tags 3.106.0 and 4.29.0 on `oci://registry-1.docker.io/casbin/casdoor-helm-charts`.
- Produces: chart pin `"4.29.0"` in the three files above; an overlay HelmRelease patch reduced to `spec.values` only (envFrom / service.port 80 / /data + /tmp mounts / casdoor-data volume); render evidence at `/tmp/casdoor-upgrade/` (Task 3 consumes it; re-run Steps 1 and 6 if cleared).

- [ ] **Step 1: Capture the 3.106.0 baseline render**

Proves the render pipeline works before the change is relied on, and produces the diff base. Uses a fixed directory because shell state does not persist between tool calls.

```bash
mkdir -p /tmp/casdoor-upgrade
kustomize build apps/casdoor/overlays/librepod > /tmp/casdoor-upgrade/overlay-before.yaml
yq 'select(.kind=="HelmRelease") | .spec.values' /tmp/casdoor-upgrade/overlay-before.yaml > /tmp/casdoor-upgrade/values.yaml
helm template casdoor oci://registry-1.docker.io/casbin/casdoor-helm-charts \
  --version 3.106.0 -f /tmp/casdoor-upgrade/values.yaml > /tmp/casdoor-upgrade/render-3.106.0.yaml
grep -c "kind: Deployment" /tmp/casdoor-upgrade/render-3.106.0.yaml
```

Expected: all commands succeed; the last prints ≥ 1. `values.yaml` is unaffected by this task's edits (they touch `postRenderers` and comments, not `spec.values`), so it serves both renders.

- [ ] **Step 2: Bump the three pins — exact edits**

- `apps/casdoor/base/ocirepository.yaml:10`: `tag: "3.106.0"` → `tag: "4.29.0"`
- `apps/casdoor/metadata.yaml:14`: `version: "3.106.0"` → `version: "4.29.0"` (leave the `# renovate:` and `# serge:` comment lines above untouched)
- `infrastructure/system-apps/casdoor.yaml:10`: `tag: "3.106.0"` → `tag: "4.29.0"` (first document, the OCIRepository; the Kustomization document below it has no tag)

- [ ] **Step 3: Strip `patch-helmrelease.yaml` down to the values patch**

1. Delete lines 48–100 — the probe-history comment plus the whole `postRenderers:` block (the deletion condition recorded in that comment is met; that is the point of this issue).
2. Delete the commented-out init-data remnants: lines 36–38 (the mount) and 44–46 (the volume). The file now ends after the `extraVolumes` block.
3. Reword the envFromConfigmap NB — keep the warning (the trim bug is still present in 4.x), drop the version anchor. Exact resulting copy:

```yaml
    # NB: we use envFrom (whole-ConfigMap) rather than per-key envFromConfigmap
    # because the chart's envFromConfigmap helper has a {{- end -}} trim bug that
    # concatenates list entries when there are 2+, producing invalid YAML.
```

Everything else in the file stays verbatim: the env-override comment block (dataSourceName/runmode rationale), `envFrom`, `service.port: 80`, both `data` mounts with the session-persistence rationale and the no-subPath note, and the `casdoor-data` volume.

- [ ] **Step 4: Run repo-level lockstep and manifest assertions**

```bash
if grep -rn '3\.106\.0' apps infrastructure .github scripts --exclude-dir=.git; then echo "FAIL: stale 3.106.0 pin"; exit 1; else echo "ok: no 3.106.0 left"; fi
grep -c '4\.29\.0' apps/casdoor/base/ocirepository.yaml apps/casdoor/metadata.yaml infrastructure/system-apps/casdoor.yaml   # 1 in each file
grep -c 'postRenderers\|init-data' apps/casdoor/overlays/librepod/patch-helmrelease.yaml   # 0
kustomize build apps/casdoor/overlays/librepod | yq 'select(.kind=="HelmRelease") | .spec.postRenderers'   # null
```

Then the CI gates, exactly as `validate-apps.yaml` runs them:

```bash
kustomize build apps/casdoor/overlays/librepod | kubeconform \
  -schema-location default \
  -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  -strict -ignore-missing-schemas -summary
flux build kustomization casdoor --path apps/casdoor/overlays/librepod \
  --local-sources GitRepository/flux-system/librepod-apps=./ --dry-run || true
```

Expected: `ok: no 3.106.0 left`; counts 1/1/1 and 0; `null`; kubeconform reports 0 invalid resources. `flux build` mirrors CI's invocation, which tolerates its exit code — kustomize + kubeconform are the gates.

- [ ] **Step 5: Run the still-present CI guard against the edited state**

The guard was written to hold in both states; running it here demonstrates the transition preserves its invariant before Task 2 deletes it.

```bash
bash scripts/test-casdoor-probe-patch.sh
```

Expected output includes `== no postRenderers block — chart must ship native probes ==`, then `startupProbe: /api/health, failureThreshold=30`, `livenessProbe: /api/health, failureThreshold=3`, `readinessProbe: /api/health, failureThreshold=3`, and the final `PASS:` line.

- [ ] **Step 6: Render 4.29.0 and assert probe, lockstep, and contract invariants**

```bash
helm show chart oci://registry-1.docker.io/casbin/casdoor-helm-charts --version 4.29.0 | grep -E '^(version|appVersion):'
helm template casdoor oci://registry-1.docker.io/casbin/casdoor-helm-charts \
  --version 4.29.0 -f /tmp/casdoor-upgrade/values.yaml > /tmp/casdoor-upgrade/render-4.29.0.yaml
R=/tmp/casdoor-upgrade/render-4.29.0.yaml
yq 'select(.kind=="Deployment") | .spec.template.spec.containers[0].startupProbe | {"path": .httpGet.path, "port": .httpGet.port, "period": .periodSeconds, "timeout": .timeoutSeconds, "failures": .failureThreshold}' "$R"
yq 'select(.kind=="Deployment") | .spec.template.spec.containers[0].livenessProbe  | {"path": .httpGet.path, "port": .httpGet.port, "period": .periodSeconds, "timeout": .timeoutSeconds, "failures": .failureThreshold}' "$R"
yq 'select(.kind=="Deployment") | .spec.template.spec.containers[0].readinessProbe | {"path": .httpGet.path, "port": .httpGet.port, "period": .periodSeconds, "timeout": .timeoutSeconds, "failures": .failureThreshold}' "$R"
yq 'select(.kind=="Deployment") | .spec.template.spec.containers | length' "$R"                                     # 1
yq 'select(.kind=="Deployment") | .spec.template.spec.containers[0] | .name + " " + .image' "$R"                      # casdoor-helm-charts casbin/casdoor:4.29.0
yq 'select(.kind=="Deployment") | .spec.template.spec.containers[0].envFrom[0].configMapRef.name' "$R"                # casdoor-env
yq 'select(.kind=="Deployment") | .spec.template.spec.containers[0].volumeMounts[] | .name + " -> " + .mountPath' "$R"  # data -> /data, data -> /tmp
yq 'select(.kind=="Deployment") | .spec.template.spec.volumes[] | select(.name == "data") | .persistentVolumeClaim.claimName' "$R"  # casdoor-data
yq 'select(.kind=="Service") | .spec.ports[0].port' "$R"                                                              # 80
yq 'select(.kind=="Deployment" or .kind=="Service" or .kind=="ConfigMap" or .kind=="ServiceAccount") | .kind + " " + .metadata.name' "$R"
```

Expected (spec §2/§3): `version: 4.29.0` and `appVersion: 4.29.0` (the lockstep check); all three probes `path /api/health`, `port http`, `period 10`, `timeout 5`, with `failures` 30 (startup) / 3 / 3; one container `casdoor-helm-charts`, image `casbin/casdoor:4.29.0`; envFrom → `casdoor-env`; mounts `data -> /data` and `data -> /tmp`; volume `data` → claim `casdoor-data`; Service port 80; names exactly `Deployment casdoor`, `Service casdoor`, `ConfigMap casdoor-config`, `ServiceAccount casdoor`. Any mismatch → STOP: the chart does not match spec §3; report rather than adapt.

- [ ] **Step 7: Diff the two full renders**

```bash
diff -u /tmp/casdoor-upgrade/render-3.106.0.yaml /tmp/casdoor-upgrade/render-4.29.0.yaml || true
```

Expected hunks — and nothing else (spec §3's exhaustive list, plus one execution-time addition):

1. version labels + image tag (`helm.sh/chart: casdoor-helm-charts-4.29.0`, `app.kubernetes.io/version: "4.29.0"`, `image: casbin/casdoor:4.29.0`)
2. the probe fix (bare `livenessProbe` on `/` → startup/liveness/readiness on `/api/health`)
3. `dataSourceName` in ConfigMap `casdoor-config` gaining `&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)` — harmless, our env override wins
4. *(expected and derived, verified during execution)* the pod-template `checksum/config` annotation changes — the chart computes it as `sha256` of the rendered config (`templates/deployment.yaml:17` is identical in both versions), `templates/configmap.yaml` is identical, and the only feeding delta is hunk 3's dataSourceName pragma from `_helpers.tpl`'s sqlite fallback. The checksum hunk is a consequence of hunk 3, not a fourth behavior change; no extra reconciliation needed.

Any other hunk → STOP and reconcile against spec §3 before committing; if genuinely new, report it in the PR rather than absorbing it silently.

- [ ] **Step 8: Commit — one commit, all four files**

```bash
git add apps/casdoor/base/ocirepository.yaml apps/casdoor/metadata.yaml \
        infrastructure/system-apps/casdoor.yaml apps/casdoor/overlays/librepod/patch-helmrelease.yaml
git commit -m "$(cat <<'EOF'
feat(casdoor): chart 3.106.0 -> 4.29.0, adopt native probes, drop postRender patch

Lockstep bump of all three pins (chart, catalog, bootstrap artifact pin).
Chart 4.23.0+ ships the probe fix natively with identical numbers, meeting
the deletion condition recorded in the postRenderers comment. No values
changes: envFrom, service.port, /data + /tmp mounts stay verbatim; the
dataSourceName env override keeps the NFS-safe journal mode.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

### Task 2: Delete the CI guard and its workflow step

**Files:**
- Delete: `scripts/test-casdoor-probe-patch.sh`
- Modify: `.github/workflows/validate-apps.yaml:107-112`

**Interfaces:**
- Consumes: Task 1's commit (the guard's no-postRender branch already demonstrated PASS in Task 1 Step 5).
- Produces: no `scripts/test-casdoor-probe-patch.sh`; a `validate-apps.yaml` whose `validate` job has exactly 3 steps (checkout, install-nix, build+lint+flux render) and no casdoor mention in `validate-apps.yaml`.

- [ ] **Step 1: Delete the guard script**

```bash
rm -f scripts/test-casdoor-probe-patch.sh
```

- [ ] **Step 2: Delete the workflow step**

Remove lines 107–112 of `.github/workflows/validate-apps.yaml` — the comment block plus the step:

```yaml
      # The casdoor probe postRender patch (issue #366) is silently ignored if a
      # chart bump stops it matching the rendered Deployment — only fresh
      # installs regress, with no other failing signal. Guard the invariant.
      - name: Casdoor probe patch guard
        if: matrix.app == 'casdoor'
        run: nix-shell shell.nix --run 'bash scripts/test-casdoor-probe-patch.sh'
```

Nothing else in the workflow changes, and no replacement step is added (CLAUDE.md: no long bash in workflow YAML — and Approach C rejected keeping a tripwire).

- [ ] **Step 3: Verify no dangling references**

```bash
# V1: functional references only. Scoped exclusion of docs/superpowers/ — the
# plan and spec prose name the script they delete, so an unscoped grep is
# unrunnable as written. (NB: gitignored-but-tracked files under docs/ are
# skipped by some grep implementations and not others — ugrep honors
# gitignore, GNU grep does not — so the exclusion must be explicit to behave
# the same across toolchains.) .superpowers/ is excluded too: the SDD scratch
# space quotes the deleted script's name in briefs/review packages, and GNU
# grep does not skip it on its own. *(execution-time correction)*
if grep -rn "test-casdoor-probe-patch" . --exclude-dir=.git --exclude-dir=docs --exclude-dir=.superpowers; then echo "FAIL: dangling reference"; exit 1; else echo "ok: no references"; fi
# V2: validate-apps.yaml only. Other workflows carry pre-existing, out-of-scope
# casdoor-sso-controller image CI; a directory-wide grep hits those.
grep -n "casdoor" .github/workflows/validate-apps.yaml || echo "ok: no casdoor-specific CI left in validate-apps.yaml"
yq '.jobs.validate.steps | length' .github/workflows/validate-apps.yaml   # 3
```

Expected: `ok: no references`; `ok: no casdoor-specific CI left in validate-apps.yaml`; `3`.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-casdoor-probe-patch.sh .github/workflows/validate-apps.yaml
git commit -m "$(cat <<'EOF'
chore(ci): delete the casdoor probe patch guard

Its failure mode (silent postRender-into-chart mismatch) dies with the
patch deleted in the previous commit; keeping it as a probe-default
tripwire was considered and rejected (design spec, Approach C).

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

### Task 3: Endpoint sweep, PR, and maintainer handoff

**Files:** none — evidence lands in the PR body; no repo changes.

**Interfaces:**
- Consumes: Task 1 + Task 2 commits; the renders at `/tmp/casdoor-upgrade/` (re-run Task 1 Steps 1 and 6 if cleared); spec §7's checklist.
- Produces: the existing open PR #389 (base `master`, head `factory8/x8luwu`) retitled `feat(casdoor): chart 3.106.0 → 4.29.0, drop postRender probe patch` with a full implementation body that closes #375 on merge, carrying the verification evidence and the maintainer handoff.

- [ ] **Step 1: Endpoint sweep, part 1 — collect the endpoints this repo actually calls**

*(execution-time correction:* the UI side originally swept only the onboarding admin service; the SSO sign-in service `ui/packages/server/src/auth/casdoor.service.ts` calls two OAuth endpoints as well, so the grep now covers both files with a slash/underscore-aware pattern. Final review caught the omission; both endpoints are verified in v4.29.0 — see part 2.)

```bash
grep -rhoE '"/api/[a-zA-Z-]+"' casdoor-sso-controller --include='*.go' | tr -d '"' | sort -u
grep -nhoE 'api/[a-zA-Z/_-]+' ui/packages/server/src/onboarding/casdoor-admin.service.ts \
  ui/packages/server/src/auth/casdoor.service.ts | sed 's/^[0-9]*://' | sort -u
```

Expected at plan-writing time (any extra endpoint that appears joins part 2 — that is the point of re-running):

- controller: `add-application`, `add-key`, `delete-application`, `delete-key`, `get-application`, `login`, `update-application`
- UI admin service: `get-organization`, `add-organization`, `get-group`, `add-group`, `get-user`, `update-user`, `add-user`, `set-password`, `login`
- UI auth service: `login/oauth/access_token`, `userinfo` (the output also shows `auth/callback` — the marketplace-ui redirect_uri embedded in the authorize URL, a UI-side path, not a casdoor call, so skip it in part 2. The browser-facing `/login/oauth/authorize` redirect has no `api/` prefix and is not an API call; the handoff's live sign-in check covers it.)

- [ ] **Step 2: Endpoint sweep, part 2 — verify each against casdoor v4.29.0 source**

The clone is untrusted data: only grep it, never execute anything from it.

```bash
git ls-remote --tags https://github.com/casdoor/casdoor 'refs/tags/v4.29.0'   # confirm the tag name
rm -rf /tmp/casdoor-4.29.0 && git clone --depth 1 --branch v4.29.0 https://github.com/casdoor/casdoor /tmp/casdoor-4.29.0
grep -rn "add-application" /tmp/casdoor-4.29.0/routers /tmp/casdoor-4.29.0/controllers | head -3   # repeat per endpoint from Step 1
grep -n "accessKey" /tmp/casdoor-4.29.0/routers/base.go | head -5                                # M2M auth transport
grep -rn 'api/health' /tmp/casdoor-4.29.0 --include='*.go' --include='*.csv' | head -5            # anonymous-200 evidence
```

Expected: every Step 1 endpoint matches a route registration under `routers/` (or a controller handler); `base.go` still reads `accessKey`/`accessSecret` from the query string (spec §3's M2M contract); the `/api/health` hits show the casbin policy allowing any subject and the no-DB handler. Any endpoint miss → STOP and report: spec §3 says all exist, so a miss is a spec deviation, not something to work around.

- [ ] **Step 3: Dev-cluster trial — best effort, NOT gating**

Spec §7's recorded call: recommended when reachable, static-only fallback is pre-authorized. If `~/.kube/librepod-dev.config` exists and the cluster answers (`kubectl --kubeconfig ~/.kube/librepod-dev.config get ns`), follow `docs/FLUX_WORKFLOW.md`'s dev procedure to deploy this PR's `pr-N` app artifact (publish-apps publishes it automatically on PR open) and observe: the casdoor HelmRelease upgrades to 4.29.0, the pod reaches Ready with restart count 0, casdoor-sso-controller stays healthy. Otherwise record in the PR that the trial was skipped and why. NB: dev's casdoor DB is already initialized — this exercises the upgrade path only, not the fresh-install (#366) path.

- [ ] **Step 4: Push and update the existing PR**

*Execution-time correction:* PR #389 (base `master`, head `factory8/x8luwu`) already exists — it carried the spec at plan-writing time. Do **not** create a duplicate PR; push the branch, then edit #389 in place with the implementation title and body.

```bash
git push -u origin HEAD
gh pr edit 389 \
  --title "feat(casdoor): chart 3.106.0 → 4.29.0, drop postRender probe patch" \
  --body-file /tmp/casdoor-upgrade/pr-body.md
```

(NB: `gh pr edit` needs a full-scope token; on a restricted token it fails — use `gh api -X PATCH repos/librepod/marketplace/pulls/389 -F body="$(cat /tmp/casdoor-upgrade/pr-body.md)"` instead.)

Write `/tmp/casdoor-upgrade/pr-body.md` with, in this order:

1. **What/why** — one paragraph from spec §1: chart 4.23.0+ ships the probe fix natively with identical numbers; the patch's recorded deletion condition is met; `Closes #375`.
2. **The change** — the three lockstep pins (naming `infrastructure/system-apps/casdoor.yaml` explicitly — the issue's checklist missed it), postRenderers deleted, guard script + CI step deleted, no values changes.
3. **Render evidence** — the Task 1 Step 7 diff summary (all four hunks: version labels + image tag, the probe fix, the dataSourceName pragma, and the derived `checksum/config` annotation), the probe values from Step 6, container name still `casdoor-helm-charts` on the docker-hub chart (the issue's "`casdoor`" expectation is true only of the ghcr chart — spec Approach B follow-up), resource names unchanged.
4. **Endpoint sweep** — the Step 1/2 results as a table (endpoint → where it is verified in v4.29.0), plus the `accessKey` transport check.
5. **Dev-cluster trial** — status per Step 3, or the recorded skip.
6. **Follow-ups** (spec §9, none blocking): move to the canonical ghcr chart; adopt `initData`/`initAdminPassword.existingSecret`; optional busy-timeout-only pragma hardening.
7. **Maintainer handoff — before rollout reaches production:** confirm a *pre-migration* `casdoor.db` backup exists (a nightly taken after the 4.x migration has a 4.x schema and cannot serve the revert runbook; take a one-off copy off the PVC if the last nightly is stale).
8. **Maintainer handoff — post-rollout checks** (spec §7): `/api/health` anonymous-200 (`kubectl -n casdoor port-forward deploy/casdoor 8000:80`, then `curl -i http://localhost:8000/api/health`); migration completed within the startup budget (pod Ready, restarts 0); casdoor-sso-controller healthy plus one SSOClient create/edit/delete round-trip and one real SSO sign-in; first fresh install after this change completes under native probes only (the #366 scenario).
9. **Rollout/rollback** — merge → publish-apps publishes `apps/casdoor:4.29.0` → a bootstrap major release rolls the system-app pin (automatic; a cluster with a pinned or suspended bootstrap needs the usual manual bump). Rollback = revert the commits and cut the release; beego migrations are additive and not un-run — the pre-migration PVC backup is the real recovery. Contingency if a migration exceeds the 5-minute budget: set `probe.startup.failureThreshold: 60` in the overlay values; never resurrect a postRender patch.
10. The attribution line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Do not merge the PR.

- [ ] **Step 5: Report — no commit; the deliverable is the open PR**

Summarize: the two commits, the evidence (diff whitelist, probe values, sweep table), the handoff items, and any deviations encountered (unexpected diff hunks, endpoint misses, skipped dev trial).
