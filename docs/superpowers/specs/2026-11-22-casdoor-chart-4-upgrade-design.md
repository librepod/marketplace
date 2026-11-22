# Casdoor chart 3.106.0 → 4.29.0, drop the postRender probe patch — Design

**Status:** design written and builder-checked (unattended session — decisions made from issue #375 and the repo, marked as calls in §10); awaiting review
**Date:** 2026-11-22
**Issue:** #375 (fixes #366's and #273's workaround, not the bugs themselves)
**Scope:** `apps/casdoor`, `scripts/test-casdoor-probe-patch.sh`, `.github/workflows/validate-apps.yaml`, `infrastructure/system-apps/casdoor.yaml`

## 1. Intent

Casdoor 3.106.0 runs behind a postRender kustomize patch that grafts the
upstream probe fix (`/api/health` + startup probe) onto the chart, because no
released chart carried it. Chart 4.23.0+ ships that fix natively with
numerically identical defaults. Upgrade the pin to 4.29.0 (latest), delete the
patch and the CI guard that watched it, and let the chart's own probes do the
job. The patch's own comment — *"DELETE this whole postRenderers block when
the pinned chart ships it natively"* — is the recorded deletion condition, and
it is met.

Why now: every day the patch stays, a Renovate chart bump can silently
invalidate it (postRender patches that stop matching are ignored, not errors),
and the #366 first-install DB corruption it prevents only bites fresh installs
— the quietest possible failure. The fix being native removes the whole risk
class.

## 2. Goals

- Chart pin 3.106.0 → 4.29.0 everywhere it is pinned, in one commit
  (lockstep: since the chart moved in-repo, chart version == casdoor app
  version).
- The rendered Deployment's probes come from the chart's `probe:` defaults,
  with no values override and no postRenderers block: `startupProbe` /
  `livenessProbe` / `readinessProbe` on `/api/health`, port `http`, 10s
  period / 5s timeout, startup failureThreshold 30 (5-min first-start
  budget), liveness+readiness failureThreshold 3.
- `scripts/test-casdoor-probe-patch.sh` and its `validate-apps.yaml` step are
  gone (the guard existed to catch silent patch-into-chart mismatches; with no
  patch there is nothing to mismatch).
- Everything else about the deployment renders byte-identically to today:
  `envFrom` (casdoor-env ConfigMap), `service.port: 80`, the `/data` + `/tmp`
  session-persistence mounts, Deployment/PVC/IngressRoute names.
- casdoor-sso-controller keeps working against casdoor 4.x without code
  changes.

## Non-goals

- Adopting chart 4.x's new `initData` (declarative init via Secret) or
  `initAdminPassword.existingSecret` — issue #375 names both as separate
  follow-ups.
- Moving the chart source OCI repository (see Approach B).
- Touching casdoor-sso-controller or marketplace-ui code.
- Tuning probe numbers away from the chart defaults.

## Anti-goals

- Regressing #366 (first-start init kill) or #273 (1s-timeout warmup kill).
  The probe configuration is the most incident-prone part of this deployment;
  any change that weakens the startup budget fails this design even if CI is
  green.
- A values file that duplicates chart defaults "for safety" (see Approach D).

## 3. Established facts (verified against the repo and upstream, 2026-11-22)

Do not re-derive these; the render evidence used the overlay's exact values
(`kustomize build apps/casdoor/overlays/librepod` → HelmRelease values →
`helm template`).

**Chart 4.29.0, pulled from the pinned repo
`oci://registry-1.docker.io/casbin/casdoor-helm-charts`:**

- `version` == `appVersion` == 4.29.0 (lockstep holds); image renders
  `casbin/casdoor:4.29.0`.
- Native probe defaults are exactly the patch's numbers (values.yaml
  `probe:`): path `/api/health`, startup 0/10/5/30, liveness 0/10/5/3,
  readiness 0/10/5/3, all on port `http`. **No values override needed.**
- Full 3.106.0-vs-4.29.0 render diff with our values contains only: version
  labels and image tag, the probe fix itself, and `dataSourceName` in the
  rendered app.conf gaining `&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)`
  (irrelevant to us — our env override wins, see §5).
- Resource names unchanged: Deployment `casdoor`, Service `casdoor`,
  ConfigMap `casdoor-config`, ServiceAccount `casdoor`. **Container name
  stays `casdoor-helm-charts`** (`.Chart.Name`; the docker-hub chart kept
  that name when the chart moved in-repo).
- The chart is dual-published. `oci://ghcr.io/casdoor/helm-charts/casdoor`
  4.29.0 is byte-identical except `Chart.yaml name: casdoor` → container name
  `casdoor`. Upstream's README: the docker-hub repo "still receives every
  release". Resource names stay the same across the two.
- Values keys we rely on all still render: `envFrom` (`- type: configmap` /
  `name:` — now a dedicated `casdoor.envFrom` helper, distinct from the
  trim-buggy `envFromConfigmap` helper we never used), `service.port`,
  `extraVolumeMounts`, `extraVolumes`.
- Audit item from #375: the issue's checklist says "4.x renders the container
  as `casdoor`" — that is true only of the ghcr-published chart. On the
  pinned docker-hub chart the container is still `casdoor-helm-charts`.
  Either way the audit is clean: after this change no patch in `apps/casdoor`
  targets a container name at all (the probe patch is the only one, and it is
  deleted; `patch-storage-class.yaml` targets the PVC, `ingressroute.yaml`
  the Service).

**Casdoor app 4.x (verified in casdoor/casdoor master source, the 4.x line):**

- Every endpoint this repo's components call still exists (sweep:
  casdoor-sso-controller's client/session packages + marketplace-ui's
  `casdoor-admin.service.ts`): `/api/login`,
  `/api/get|add|update|delete-application`, `/api/add-key`,
  `/api/delete-key` (casdoor-sso-controller), `/api/get-user`,
  `/api/add-user`, `/api/update-user`, `/api/get-organization`,
  `/api/add-organization`, `/api/update-organization`, `/api/set-password`,
  `/api/get-group`, `/api/add-group` (marketplace-ui onboarding,
  `admins`-group provisioning), `/api/health`. The implementation PR re-runs
  this sweep (`grep` the two codebases for `/api/` literals, check each
  against the chart-pinned casdoor's router) rather than trusting this list.
- `/api/health` stays anonymous-200: the handler is `c.ResponseOk()` (no DB
  query) and the built-in casbin policy `p, *, *, GET, /api/health, *, *`
  allows any subject.
- M2M auth transport unchanged: `routers/base.go` still reads
  `accessKey`/`accessSecret` from the query string (`getUsernameByKeyPair`:
  lookup by key, verbatim secret compare, `state == Active`, optional
  expiry) — the exact contract casdoor-sso-controller's bootstrap mints
  (Active, no expiry, client-supplied secret).
- `/api/delete-application` still requires the full application object as the
  body and answers `Affected`/`Unaffected` — the 3.x contract the controller
  code and its silent-no-op guard were written against.
- app.conf env override still works: `conf.GetConfigString` checks
  `os.LookupEnv(key)` before app.conf, so the casdoor-env ConfigMap
  (`dataSourceName`, `runmode`) keeps working.

**Rollout mechanics (this repo):**

- There are **three** lockstep pins, not the two in #375's checklist:
  `apps/casdoor/base/ocirepository.yaml` `ref.tag` (chart),
  `apps/casdoor/metadata.yaml` `spec.version` (catalog), and
  `infrastructure/system-apps/casdoor.yaml` `tag` (the bootstrap's pin of the
  published artifact `ghcr.io/librepod/marketplace/apps/casdoor`). Without
  the third, live clusters keep deploying artifact 3.106.0 and never adopt
  the fix.
- Merge to master: `publish-apps.yaml` publishes the app artifact at the new
  version; `bootstrap-next-version.sh` classifies the system-app pin change
  3.106.0 → 4.29.0 as `[major]` and a marketplace-bootstrap major release
  rolls the pin out. No manual release step beyond the merge.

## 4. Approaches

**A. Lockstep bump on the pinned (docker-hub) OCI repo + delete patch and
guard — chosen.** Bump the three pins in one commit; delete the
`postRenderers` block; delete the guard script and its CI step; no values
changes. Smallest possible diff and blast radius for a 3→4 major that also
runs a SQLite schema migration on first start. Upstream explicitly maintains
the docker-hub mirror ("still receives every release"), and Renovate's
`depName=registry-1.docker.io/casbin/casdoor-helm-charts` wiring keeps
working unchanged.

**B. Same bump, but also move to the canonical ghcr chart
(`oci://ghcr.io/casdoor/helm-charts/casdoor`).** Matches #375's
container-name expectation (`casdoor`), sits on upstream's canonical home,
and sheds the legacy mirror. Rejected **for this change**: it is scope beyond
the issue (which names only the tag bump), and stacking a registry move on a
major app upgrade multiplies what one revert must undo. The charts are
byte-identical except the chart name, so the move is provably a render no-op
and makes a clean standalone follow-up (ocirepository `spec.url`, the
Renovate `depName` comment in metadata.yaml; container name changes
`casdoor-helm-charts` → `casdoor`, which matters to nothing after this
design removes the last container-targeted patch).

**C. Keep the CI guard as a chart-native probe tripwire.** The script already
handles the no-postRender state (it asserts the chart itself renders the
probe invariant), so it would keep guarding future Renovate bumps against an
upstream probe-default regression. Rejected: #375 explicitly kills it, its
reason to exist (silent patch mismatch) dies with the patch, and the residual
tripwire value is thin — a probe-default regression would break every fresh
upstream install loudly, and the chart carries its own helm-unittest
snapshots for the deployment. The cost is permanent: a network-dependent OCI
chart pull on every casdoor-manifest PR.

**D. Additionally pin `probe:` values to today's numbers.** Would freeze the
incident-critical configuration against any future upstream default change.
Rejected: it duplicates the chart defaults we just verified, drifts from the
"chart's maintained defaults" stance recorded in `base/helmrelease.yaml`, and
buys protection only against upstream voluntarily weakening its own fix. If
that ever happens, one values override (`probe.startup.failureThreshold`
etc.) restores it without a patch. Residual risk accepted and recorded here.

**E. Defer (stay on 3.106.0 + patch).** Rejected — the recorded deletion
condition is met; keeping the patch preserves exactly the silent-mismatch
risk class this issue exists to retire.

## 5. The change

1. `apps/casdoor/base/ocirepository.yaml` — `ref.tag` `"3.106.0"` →
   `"4.29.0"`.
2. `apps/casdoor/metadata.yaml` — `spec.version` `"3.106.0"` → `"4.29.0"`.
   The Renovate comment line stays as-is (same depName under Approach A).
3. `infrastructure/system-apps/casdoor.yaml` — artifact `tag` `"3.106.0"` →
   `"4.29.0"` (third lockstep member; see §3).
4. `apps/casdoor/overlays/librepod/patch-helmrelease.yaml` — delete the whole
   `postRenderers` block and its probe-history comment. Keep everything
   above it: the file is also the overlay's values patch (`envFrom`,
   `service.port: 80`, the `/data` + `/tmp` mounts with their session-
   persistence rationale). Refresh the comment that cites the
   `envFromConfigmap` trim bug as "(casdoor-helm-charts 3.106.0)" — the bug
   is still present in 4.x but we use `envFrom`, so keep the NB, drop the
   version anchor. Remove the commented-out `init-data` mount/volume
   remnants (superseded by chart 4.x `initData`, a declared non-goal here).
5. Delete `scripts/test-casdoor-probe-patch.sh` (its `test-*.sh` does not
   exist — the guard is invoked directly by the workflow, not via a test
   script pattern; nothing else references it).
6. `.github/workflows/validate-apps.yaml` — delete the "Casdoor probe patch
   guard" step (the `if: matrix.app == 'casdoor'` run block and its
   comment). Nothing else in the workflow changes.

No values changes. No controller or UI code changes (§3 verified the
contracts; re-verification after deploy is observational, §7).

**Deliberately kept as-is:** the `dataSourceName` env override
(`file:/data/casdoor.db?cache=shared`) does **not** adopt the chart's new
`busy_timeout`/WAL pragmas — WAL relies on shared-memory mmap and is unsafe
on NFS, and `/data` is the nfs-client PVC. The DELETE rollback journal it
keeps is the NFS-safe choice.

## 6. Rollout and rollback

**Rollout** (automatic after merge): publish-apps publishes artifact
`marketplace/apps/casdoor:4.29.0` → bootstrap release (major) updates the
system-app pin → on each cluster the casdoor Kustomization pulls the new
artifact → the HelmRelease upgrades in place (RetryOnFailure) → the 4.29.0
pod starts, beego orm migrates the SQLite schema on `/data`, and the native
startup probe holds liveness off for up to 5 minutes — precisely the
scenario the upstream fix's values comment names ("can take minutes on the
first start (database migration)").

Reach assumptions, recorded (out-of-band wiring, flagged in the handoff):
the in-repo k3d cluster tracks the bootstrap artifact's `ref: latest`
(`clusters/librepod-k3d/bootstrap/flux-instance.yaml`); the production
clusters' bootstrap sync is generated by `flux bootstrap` on the device and
lives out-of-band. If any real cluster pins a bootstrap version or has
reconciliation suspended, it needs the usual manual pin bump — the same
step every bootstrap release already implies. A merge that lands between
the app artifact publish and the bootstrap cut is self-healing: the
OCIRepository retry re-pulls once both exist, and Flux keeps serving the
last artifact meanwhile (no downtime window).

**Before the rollout reaches production:** confirm a *pre-migration*
casdoor.db backup exists (the nightly borgmatic run scales casdoor to 0 and
copies the DB — a nightly taken **after** the 4.x migration captures a
4.x-schema DB and cannot serve the revert runbook below). If the last
nightly is stale, take a one-off copy of `casdoor.db` off the PVC first.

**Rollback:** revert the commit (pins return to 3.106.0, patch and guard
return with it) and cut the resulting bootstrap release. Caveat: beego orm
migrations are additive and are not un-run; if 4.x already migrated the
schema, a downgraded 3.106.0 may misread it. The real recovery for a bad
migration is the pre-migration PVC backup (casdoor.db on `casdoor-data`),
same as #366's recovery runbook. Expected migration size is small
(single-org, handful of applications), so this is a contingency, not a
plan.

**Contingency if migration exceeds the 5-minute startup budget** (container
restarts mid-migration on a slow NFS volume): set
`probe.startup.failureThreshold: 60` in the overlay values — the chart
exposes every timing natively; do not resurrect a postRender patch.

## 7. Verification

Static (done while writing this design; redo in the implementation PR):

- Render the overlay, extract `spec.values`, `helm template` chart 4.29.0
  with them; diff against the same render on 3.106.0 — expect only the
  changes listed in §3. `kustomize build` + kubeconform + `flux build` as CI
  runs them.
- Assert the rendered probes match §2's numbers and the container list is
  unchanged (one container, `casdoor-helm-charts`, image `casbin/casdoor:4.29.0`).
- Re-run the endpoint sweep of §3 against the pinned chart's casdoor.

Dev-cluster trial (recommended pre-merge, repo norm per
`docs/FLUX_WORKFLOW.md` — the PR's `:pr-N` bootstrap artifact deploys to
`librepod-dev`): the upgrade-in-place path — SQLite migration under the
native startup budget, controller bootstrap and reconcile clean, SSO
sign-in round-trip. NB it does **not** cover the fresh-install (#366) path:
dev's casdoor DB is already initialized, so that scenario needs a wiped
casdoor PVC or a fresh k3d bootstrap. If no dev cluster is reachable from
the session, say so in the PR and fall back to static + the handoff list —
recommended, not gating (my call; #375's own checklist asks only for the
render and live re-checks).

Post-rollout (the "re-verify" items from #375) — a maintainer checklist
handed off in the PR, not implementer-run steps: production kubeconfigs are
off-limits to agent sessions per the repo's skills, so the implementer's
part ends at merge plus this list:

- `/api/health` answers 200 anonymously on 4.29.0 (e.g.
  `kubectl -n casdoor port-forward deploy/casdoor 8000:80` then
  `curl -i http://localhost:8000/api/health`).
- The 3→4 SQLite migration completed within the startup budget (pod `Ready`,
  restart count 0).
- casdoor-sso-controller: no crashloops after the casdoor upgrade; an
  `SSOClient` reconcile round-trip (create/edit/delete one) succeeds; a real
  SSO sign-in through an existing app works. Static contract verification is
  in §3; this is the belt to its braces.
- First fresh install after this change (new cluster / marketplace canary):
  casdoor first-start init completes with the native probes only — the exact
  #366 scenario.

**Completion criterion for #375:** the three pins bumped in one commit,
patch and guard deleted, the static render verification in the PR, and the
checklist above handed off. The live items close with the maintainer's
thumbs-up on the rollout.

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| SQLite 3→4 migration slow on NFS, startup budget exceeded | low (small DB; additive migrations) | §6 contingency (values override), PVC backup |
| An admin-API contract changed in 4.x beyond what §3 could verify statically | low (routes, auth transport, and the two version-sensitive semantics all checked at source) | §7 post-deploy controller checks; revert + backup if broken |
| Future Renovate chart bump weakens probe defaults silently | low | Accepted (Approach D rejected); restore via `probe:` values if ever observed |
| Upstream stops mirroring to docker-hub | low (stated as maintained) | Approach B becomes the fix; it is a render no-op today |

## 9. Follow-ups (each its own issue/PR, none block this one)

1. Move the chart pin to the canonical `oci://ghcr.io/casdoor/helm-charts/casdoor`
   (Approach B; container name becomes `casdoor`; update Renovate depName).
2. Adopt chart `initData` / `initAdminPassword.existingSecret` (named in #375).
3. Optionally add `_pragma=busy_timeout(5000)` (busy-timeout only, **not**
   WAL) to the `dataSourceName` env override as NFS lock-contention
   hardening — independent of this upgrade.

## 10. Decision log (unattended session; all mine to overrule)

| Decision | Call | Why |
|---|---|---|
| Approach | A over B | #375 asks for a pin bump, not a registry move; don't stack a repo move on a major upgrade; B is a verified no-op follow-up |
| Third lockstep pin included | yes | Repo mechanics (§3): without it live clusters never get the fix; the issue's checklist missed it |
| CI guard deleted, not repurposed | yes | #375 explicit; its failure mode dies with the patch (Approach C) |
| No `probe:` values override | yes | Defaults are the fix itself; avoid duplicating upstream (Approach D) |
| Keep `dataSourceName` without WAL pragmas | yes | WAL is unsafe on NFS; `/data` is NFS |
| Controller code untouched | yes | Contracts verified at source (§3); live re-check in §7 |
| Pre-migration DB backup before rollout | required step | A nightly taken after migration is 4.x-schema and useless to the revert runbook |
| Dev-cluster trial before merge | recommended, not gating | Repo norm (FLUX_WORKFLOW.md) when reachable; #375's checklist doesn't demand it |
| Post-rollout checks | maintainer handoff, not implementer-run | Production kubeconfigs are off-limits to agent sessions per repo skills |
| Bootstrap reach of real clusters | assumed to follow releases; flagged | Wiring is out-of-band (flux bootstrap); pinned/suspended clusters need the usual manual bump |
