# Fix #180 — First Install 500s on a Cold Cluster (user-apps Repo-Seeding Race)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Before editing any file, re-verify the claims in "Root Cause" against the live cluster — the two prior fixes (#176, #177) shipped on unverified hypotheses and failed. Do not repeat that.**

**Issue:** [#180](https://github.com/librepod/marketplace/issues/180) — on a cold/fresh cluster the first `POST /api/apps/:name/install` 500s (~3/4 of Tier 2 runs), after #176 + #177 both proved insufficient.

**Goal:** Make the first install on a cold cluster succeed deterministically, with a fix that is correct for **any** git backend (Gogs today; GitHub/GitLab if an operator swaps it), and guard it so it cannot silently regress.

**Decision headline:** This is a **GitOps ordering fix, not a server-code fix.** Sequence `marketplace-ui` behind the provider-neutral "user-apps repo is seeded" signal, and delete the Gogs-specific readiness hack that no longer gates anything.

---

## Root Cause (reproduced live on `librepod-dev`, gogs 0.14.3 / marketplace-ui 0.5.2, 2026-08-18)

The 500 is a **repo-seeding race, NOT a token race.** Two bootstrap tracks run in parallel with nothing ordering them:

| Track | Creates | Gated by |
|---|---|---|
| gogs `postStart` hook | the `flux` admin **user** | (inside the gogs pod) |
| `user-apps-source` Job (`bootstrap-ssh-key`) | the `flux/user-apps` **repo** + the seed commit (`kustomization.yaml`=`resources: []`, README) over SSH | `dependsOn: [system-configs, gogs]`, `wait:` **unset** |
| `marketplace-ui` | boots the installer, gets a token, serves `/install` | `dependsOn: [gogs, cert-manager, casdoor-sso-controller]` — **NOT `user-apps-source`** |

`marketplace-ui`'s `wait-for-gogs-user` initContainer waits only for the **flux user** (`GET /api/v1/users/flux/tokens` Basic→200), **never for the seeded repo.** So the server routinely becomes Ready while `flux/user-apps` is missing or empty.

**Proven at the HTTP layer** (probed live Gogs with a valid token — the two cold sub-states):
- **Repo exists but EMPTY** (Job created it, seed not pushed yet): `GET raw/master/kustomization.yaml` → **404** (→ `getInstalledAppNames()` catches → returns `[]` → app reads **`not_installed`**, the exact Tier 2 failure signature `Received: "not_installed"`); `PUT contents/apps/<x>/source.yaml` → **HTTP 500** `"Something went wrong…"` (Gogs cannot write a file to a commitless repo).
- **Repo MISSING**: every op → **404**, PUT included.

**Causal chain in `installed.service.ts` `install()`:** `ensureWritableToken()` ✅ (token/auth are fine) → `getInstalledAppNames()` 404→`[]` (no throw) → not "already installed" → **`createFile()` PUT → 500/404 → throws → HTTP 500.**

**Why #176/#177 were insufficient:** both were 100% token-focused (every unit test asserts token 403/retry). The token was never the problem. #177's ~10s retry only *reduced* the failure by accidentally giving the seed more time to land.

**Why Tier 1 never caught it:** Tier 1's hermetic harness has a `gogs-seed` service that creates the user + repo + empty `kustomization.yaml`, and `gogs-ready.mjs` polls until *"the seeded state is observable"* before any test runs. Production has no equivalent gate ahead of the installer.

### Provider-neutral framing (the key design driver)

Gogs is a **swappable** backend — `bootstrap-ssh-key.sh` itself states an operator can point Flux at GitHub/GitLab, making the Gogs Job a no-op. So the installer's true invariant is provider-agnostic:

> **`flux/user-apps` exists, has a commit on `master`, and is reconcilable — via whatever backend is configured.**

Flux already expresses exactly that: the **`user-apps` Kustomization reaching `Ready`** means Flux cloned a seeded repo and applied its content — identical semantics for Gogs, GitHub, or GitLab. That is the gate. (The `wait-for-gogs-user` initContainer, by contrast, polls a **Gogs-only** API and is meaningless/dead-weight on a swapped backend.)

### Verified facts this plan relies on (re-verify before editing)

1. **`dependsOn` targets Kustomizations only, not GitRepositories** (confirmed against the `kustomizations.kustomize.toolkit.fluxcd.io` CRD: *"references to Kustomization resources that must be ready"*). → gate on the **`user-apps` Kustomization**, not the `user-apps-source` GitRepository.
2. **No dependency cycle:** `user-apps` dependsOn `<none>`; adding `marketplace-ui → user-apps` is acyclic (full graph checked).
3. **`marketplace-ui.yaml` is one shared file** (`infrastructure/system-apps/marketplace-ui.yaml`) used by all three clusters (`librepod`, `librepod-dev`, `librepod-k3d`) — one edit fixes all.
4. **Removing `wait-for-gogs-user` is safe:** the server's `onModuleInit`→`ensureToken()` catches all errors and only warns (`gogs.service.ts`); `main.ts` `app.listen()` does not depend on Gogs. The server boots unseeded and lazily acquires the token on a later call. The initContainer's original "bootstraps once, never retries" premise was made obsolete by #176/#177.
5. **Auth is fine on 0.14.3.** Basic auth works for token-bootstrap + repo-metadata; `token <sha1>` works for raw/contents/PUT/DELETE. **Do NOT trust** the AUTH NOTE in `bootstrap-ssh-key.sh` claiming token auth is broken — it is false (live-verified) and must not shape any change here.

---

## Scope

**In scope (this plan):** GitOps ordering fix + delete redundant initContainer + regression guards (Tier 2 first-attempt assertion, Tier 2 failure log-capture) + scripted dev-cluster verification.

**Out of scope (already filed as follow-ups):**
- **Server 503 robustness (#181):** the marketplace-ui server hard-500s on any empty/missing-repo state, including a *mid-life* backend reset (dev-cluster history showed a window where the UI ran before the seed Job completed). Follow-up: map missing/empty-repo on install → **503 "provisioning, retry"** instead of 500. Provider-agnostic; valuable but not needed to fix cold boot.
- **Per-app Kustomization redesign (#182):** today all user apps live under the single `user-apps` Kustomization, so one broken app turns `user-apps` `Ready=False`. With this fix that could block the installer UI from (re)starting on a warm cluster. Redesign so each installed app is its own Kustomization. **Cross-ref:** when that lands, re-point marketplace-ui's dependency so it still means "repo seeded," NOT "all per-app Kustomizations healthy."

---

## Files

**Modified:**
- `apps/marketplace-ui/base/deployment.yaml` — remove the `wait-for-gogs-user` initContainer (and its now-unused `initContainers:` block if it's the only one; and the `gogs-auth` env refs the initContainer used, if unused elsewhere — verify).
- `infrastructure/system-apps/marketplace-ui.yaml` — add `user-apps` to `spec.dependsOn`.
- `.github/workflows/ui-e2e-cluster.yaml` — add on-failure log capture (marketplace-ui / gogs / Flux) + upload.
- `ui/packages/e2e/tests/cluster-level/reconcile-lifecycle.spec.ts` — assert install succeeds on the **first attempt** (defeat the flaky-retry mask).
- **Version bump (0.5.2 → 0.5.3):** because the base Deployment changed. Follow the repo's normal bump + `catalog.yaml`-regenerate flow (parent CLAUDE.md). **3-tag-bump rule:** the pin that actually deploys is the `ref.tag` in `infrastructure/system-apps/marketplace-ui.yaml` — bumping only `metadata.yaml` / the overlay will NOT move the cluster. Bump `metadata.yaml`, the overlay image tag, AND the `ref.tag`.

**Created:**
- `ui/packages/e2e/support/cold-boot-repro.sh` — the scripted dev-cluster reproduction/verification (Task 5). **Shipped/committed** (reusable for future Gogs-race regressions), alongside the other `support/` orchestrators.

---

### Task 1: Add the provider-neutral ordering gate

**Files:** Modify `infrastructure/system-apps/marketplace-ui.yaml`.

- [ ] Add `- name: user-apps` to `spec.dependsOn` (alongside the existing `gogs`, `cert-manager`, `casdoor-sso-controller`). Keep `wait: true` on `marketplace-ui`.
- [ ] Sanity: confirm no cycle (`user-apps` dependsOn nothing). Confirm `user-apps` and `marketplace-ui` are both reconciled by the same cluster path so the dependency resolves in-namespace (`flux-system`).

**Why this is the gate:** `user-apps` Ready ⇔ Flux cloned a seeded `flux/user-apps` and applied it — provider-neutral. On cold boot the seed is `resources: []`, so `user-apps` reaches Ready almost immediately; `marketplace-ui` then starts only after the repo is guaranteed writable.

**Acceptance:** `flux build`/`kustomize build` of `system-apps` renders `marketplace-ui` with the 4-item `dependsOn`. `kubeconform` clean.

---

### Task 2: Remove the redundant, backend-coupled initContainer

**Files:** Modify `apps/marketplace-ui/base/deployment.yaml`.

- [ ] Delete the entire `wait-for-gogs-user` initContainer (lines under `initContainers:` — the alpine wget-poll of `/api/v1/users/$GOGS_USERNAME/tokens`).
- [ ] If it is the only initContainer, remove the now-empty `initContainers:` key.
- [ ] Check whether the `GOGS_URL`/`GOGS_USERNAME`/`GOGS_TOKEN` env wiring it used is still needed by the main container (the main container has its own `GOGS_USERNAME`/`GOGS_TOKEN` from `gogs-auth` + `GOGS_URL` from the ConfigMap — so the initContainer's copies are removable with it). Do not remove env the main container relies on.
- [ ] Leave the server code (`gogs.service.ts`, `installed.service.ts`) UNCHANGED. (`ensureToken`/`ensureWritableToken` stay; they are harmless and the 503 improvement is a separate follow-up.)

**Rationale:** With Task 1, repo readiness is guaranteed provider-neutrally. The initContainer only polls a Gogs-specific endpoint, is redundant, and would waste up to 300s before its best-effort `exit 0` on a non-Gogs backend. Verified safe (see Root Cause fact #4).

**Acceptance:** `kustomize build apps/marketplace-ui/overlays/librepod` renders a Deployment with no `wait-for-gogs-user`. Server still boots in Tier 1 (hermetic) with the repo pre-seeded.

---

### Task 3: Regression guard — Tier 2 asserts FIRST-attempt install success

**Files:** Modify `ui/packages/e2e/tests/cluster-level/reconcile-lifecycle.spec.ts`.

**Problem:** `playwright.config.ts` sets `retries: process.env.CI ? 2 : 0`. A first-attempt install-500 gets retried; by retry time the seed has landed, so the run passes as *"1 flaky"* with a green (advisory) job. That is exactly how #176/#177 looked "mostly fixed." The guard must fail (or at least loudly surface) a **first-attempt** 500.

- [ ] In the `"install reconciles to Running"` test, capture the **direct** result of the install POST (or the immediate post-click status) and assert it did NOT 500 on the first attempt — e.g. drive the install via `request.post('/api/apps/:name/install')` and assert status `2xx` BEFORE the reconcile poll, OR add a dedicated assertion that fails the test body on a first-attempt server error rather than letting the UI's retry button paper over it.
- [ ] Keep the existing reconcile-to-`running` poll (that part is legitimately slow and retry-tolerant).
- [ ] Consider setting `retries: 0` for *this* spec via a project/annotation override so a first-attempt failure is not silently retried — but DO NOT globally disable retries for the genuinely-slow reconcile assertions. (Pick the least-invasive mechanism; document it inline.)

**Acceptance:** With the Task 1+2 fix in place, the assertion passes on attempt 1. To self-check the guard, temporarily revert Task 1 locally (Task 5's cold-boot repro) and confirm the assertion now FAILS on attempt 1 (not just flakes green).

---

### Task 4: Regression guard — capture diagnostics on Tier 2 failure

**Files:** Modify `.github/workflows/ui-e2e-cluster.yaml`.

- [ ] Add a step (`if: ${{ failure() }}`, before cluster teardown — mind that `run-tier2.sh` deletes the cluster; capture must run while it still exists, so either hook into the orchestrator's failure path or run the dump inside the test job before teardown) that collects:
  - `kubectl logs deploy/marketplace-ui -n marketplace-ui --all-containers --tail=-1` (+ `--previous` if restarted)
  - `kubectl describe pod -n marketplace-ui -l app.kubernetes.io/name=marketplace-ui`
  - `kubectl logs deploy/gogs -n gogs --all-containers --tail=-1` and the gogs `postStart`/bootstrap Job logs
  - `flux get kustomizations -A` + `flux get sources git -A` + `kubectl get gitrepository,kustomization -n flux-system`
  - the `flux/user-apps` repo state if reachable (raw `kustomization.yaml`)
- [ ] Upload as an artifact (`actions/upload-artifact`, retention ~7–14d), name e.g. `tier2-cluster-diagnostics`.

**Note on teardown ordering:** `run-tier2.sh` does `k3d delete` in a trap/teardown. The dump MUST run before that. Simplest: have the orchestrator, on test failure, dump to a known dir *before* deleting the cluster, and let the workflow upload that dir. Verify the mechanism end-to-end (a deliberately-failing dummy assertion) so we don't ship a capture step that runs after the cluster is already gone.

**Acceptance:** A forced failure produces a non-empty `tier2-cluster-diagnostics` artifact containing the marketplace-ui server log around the failure.

---

### Task 5: Prove the fix on the real `librepod-dev` cluster (scripted cold-boot)

**Files:** Create `ui/packages/e2e/support/cold-boot-repro.sh` (committed/shipped). This is the **explicit, repeatable** dev-cluster verification the issue demands ("fix it on a real cluster, not just k3d").

> Reach the dev cluster via `~/.kube/librepod-dev.config` (the repo's checked-in config has a stale IP). The dev cluster **syncs from OCI, not git** — there is no `GitRepository/librepod-apps`, so the git-branch override in `FLUX_WORKFLOW.md` does NOT work here. To test the fix you must **publish an OCI artifact** for `marketplace-ui` (image + apps manifest) at a test tag and point the cluster at it, OR merge to master and let the normal publish flow run, THEN run this repro.

The script must:
- [ ] **Snapshot** current state (so it can restore): the `user-apps` root `kustomization.yaml`, existing installed apps, gogs PVC identity.
- [ ] **Force a genuine cold boot of the repo track:**
  1. Scale down `marketplace-ui` and `gogs`.
  2. Wipe the gogs NFS folder contents (NFS server `127.0.0.1`, path `/exports/k3s/gogs/gogs-data`; reclaim is Retain so deleting the PVC alone does NOT clear data — see parent CLAUDE.md "PVC/PV Deletion with NFS Storage"). Use a temp root job `rm -rf /data/*` or clear the export directly on the node.
  3. Delete `Secret/user-apps-ssh-key` (in `gogs`, and its reflections in `flux-system`/`marketplace-ui`) and the Completed `Job/gogs-bootstrap-ssh-key`, so the seed Job re-runs.
  4. Scale gogs back up; let its postStart re-create the flux user and the seed Job re-create+seed the repo.
- [ ] **Reproduce the PRE-FIX failure** (run this BEFORE deploying the fix, to capture the baseline): as soon as `marketplace-ui` is Ready, immediately trigger an install and confirm it **500s** while the repo is still seeding, capturing the marketplace-ui server log line at the 500. (Because the API is behind SSO, drive the install from inside the cluster with a valid session, or via `mint-session.ts`-style auth — see `ui/packages/e2e/support/mint-session.ts`. Alternatively temporarily target the server pod directly if an auth-bypass seam exists for testing.)
- [ ] **Verify the POST-FIX behavior:** with Task 1+2 deployed (i.e. `marketplace-ui` now `dependsOn: user-apps`), repeat the cold boot. Confirm `marketplace-ui` does **not** become Ready until `user-apps` is Ready, and the first install **succeeds** (2xx, then reconciles to `running`). Repeat 3–5× to beat the ~3/4 failure rate the issue reported.
- [ ] **Restore/clean up:** remove any probe tokens/files left in `flux/user-apps` (note: gogs 0.14.3 token DELETE-by-id and contents DELETE returned 404 in probing — a full cold-boot wipe is the reliable cleaner). Leave the dev cluster healthy and re-bootstrapped.

**Acceptance:** A captured PRE-FIX transcript showing a first-attempt 500 with the server log, AND a POST-FIX transcript showing `marketplace-ui` gated behind `user-apps` Ready + first install succeeding, repeated with no failure.

---

### Task 6: Docs + comment corrections

> The two follow-up issues are already filed: **#181** (server 503 robustness) and **#182** (per-app Kustomizations). No need to re-create them — just ensure the PR body links them and that #180 is cross-referenced.

- [ ] Update `docs/DECISIONS_LOG.md` (and `ui/CLAUDE.md` if the initContainer removal changes documented behavior) with the provider-neutral gate decision and the deleted initContainer.
- [ ] Correct the false AUTH NOTE in `infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh` (token auth is NOT broken on 0.14.3 — live-verified: `token <sha1>` returns 200/201/204 on repos/contents/PUT/DELETE). Fix the comment so it stops misleading future work. (The Basic-auth-on-admin-endpoints code can stay; only the stated rationale is wrong.)
- [ ] (Optional) Correspondingly update `ui/CLAUDE.md`'s Gogs-auth note and the `⚠ GOGS_TOKEN` phrasing if they lean on the same false premise.

---

## Commit / PR hygiene

- Branch off `master`; do not reference concrete cluster hostnames in commit/PR text (use `dev`/`prod`) — parent CLAUDE.md.
- Version bump + `catalog.yaml` regenerate per the repo's generated-YAML flow; honor the 3-tag-bump rule (bump the `ref.tag` in `infrastructure/system-apps/marketplace-ui.yaml`, not just `metadata.yaml`/overlay) so the pin that actually deploys moves.
- This is a single logical fix: prefer one PR containing Tasks 1–4 (fix + guards), with Task 5 evidence pasted into the PR description and Task 6 issues linked.

## Definition of Done

- [ ] `marketplace-ui` renders with `dependsOn: [gogs, cert-manager, casdoor-sso-controller, user-apps]`; no `wait-for-gogs-user` initContainer.
- [ ] Tier 2 asserts first-attempt install success; a reverted-fix run makes that assertion fail (guard proven).
- [ ] Tier 2 failure produces a diagnostics artifact with the marketplace-ui server log.
- [ ] Cold-boot repro on the dev cluster: PRE-FIX 500 captured; POST-FIX first install succeeds, repeated with no failures.
- [ ] PR links follow-ups #181 + #182; false AUTH NOTE corrected.
