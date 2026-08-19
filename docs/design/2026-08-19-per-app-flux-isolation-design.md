# Design: Per-App Flux Isolation and a Provider-Neutral Git Write Layer

**Date:** 2026-08-19
**Status:** Approved (design phase)
**Author:** Alex Sukhov (with Claude)
**Issue:** [#182](https://github.com/librepod/marketplace/issues/182) — cross-refs #180, #181, #169

## Problem

Issue #182 asks that each installed user app become "its own Flux
Kustomization". Research showed the premise is off by one layer: **every app
already has its own Kustomization.** All 29 apps with `spec.templates` render
the identical shape into `flux-system` — `OCIRepository/marketplace-<app>` plus
`Kustomization/marketplace-<app>` (its own OCI source, `wait: true`, labelled
`marketplace.io/app=<app>`) plus an optional `Secret`. The shared `user-apps`
Kustomization is not the apps' reconciler; it is an *aggregate that applies
their declarations*.

The hazard #182 describes is nonetheless real, and decomposes into two
distinct couplings:

1. **Health coupling.** `user-apps.spec.wait: true` makes Flux health-check
   every object it applies — including the per-app `Kustomization` CRs. One
   unhealthy app turns the shared aggregate `Ready=False`. Because #180 gates
   `marketplace-ui` on `user-apps`, a single broken app can block re-applying
   the installer UI — the very tool needed to remove it.

2. **Build coupling.** The aggregate is one `kustomize build` over one shared
   root `kustomization.yaml` listing every app directory. Malformed content in
   one app breaks the build for all of them, and every install/uninstall is a
   read-modify-write of that single shared file.

Separately, the write layer is Gogs-specific. The `flux/user-apps` repo is
meant to be pluggable — a user should be able to point it at GitHub or GitLab
and have installs keep working — but `GogsService` talks to the Gogs REST API,
whose limitations shape (and break) the install flow.

## Goals

- A broken app fails **in isolation**. No shared Flux object goes `Ready=False`
  because of one app's health.
- `marketplace-ui`'s startup gate keeps #180's cold-boot guarantee while
  depending on **neither** user-app health nor user-app content.
- Remove the shared mutable root `kustomization.yaml`: installs and uninstalls
  touch only their own app's files.
- All git operations go through a **generic git client**, so pointing
  `user-apps` at GitHub/GitLab works with no code change.
- Install and uninstall become **atomic** — one commit each.

## Non-Goals

- Adding a second, git-sourced Kustomization per app. Rejected: it would double
  the Kustomization count, make the `marketplace.io/app` label selector
  ambiguous (`FluxStatusService` takes `items[0]`), and introduce a two-level
  cascading prune on uninstall. Build isolation is not worth that price — the
  residual exposure is bounded in §8.
- Migrating `marketplace.io/*` labels to `librepod.org/*` (#169 — breaking,
  separate).
- Changing any app's `metadata.yaml` `templates:` block, or `catalog.yaml`
  (which is CI-generated).

## Key facts discovered during design

Each fact below was verified, not assumed. The verification method is recorded
so none of this has to be re-litigated.

| # | Fact | How verified |
|---|------|--------------|
| F1 | Every app with templates renders `OCIRepository` + `Kustomization` (+ optional `Secret`) — apps are already independently reconciled | Enumerated all 29 `apps/*/metadata.yaml`; confirmed live (`marketplace-baikal`, own OCI source, `wait: true`, `marketplace.io/app=baikal`) |
| F2 | `wait: true` health-checks **all** applied resources and **ignores** `spec.healthChecks`; so `wait: false` + explicit `healthChecks` gives a *selective* assessment | Kustomization CRD schema description, read from the cluster: *"Wait instructs the controller to check the health of all the reconciled resources. When enabled, the HealthChecks are ignored."* Live `user-apps` carries `Healthy: "Health check passed in 28.3ms"` |
| F3 | `spec.timeout` defaults to `spec.interval` — `user-apps` (interval 1m) burns up to 1m per reconcile while an app is unhealthy | Same CRD schema: *"Defaults to 'Interval' duration."* |
| F4 | Flux auto-generates a `kustomization.yaml` when `spec.path` contains none. The scan is **recursive**, and it **honors** a nested `apps/<app>/kustomization.yaml` rather than bypassing it | `flux build kustomization --dry-run` (v2.9.3, same version as the cluster) against a fixture repo: both app dirs picked up; a probe file present in the dir but absent from its `resources:` list was **excluded** |
| F5 | A path containing no manifests at all (fresh repo, only `README.md`) builds clean and empty | Same harness, exit 0, empty output — so the gate still opens on a zero-app cluster |
| F6 | Auto-generation **decodes every YAML file in the tree**. One malformed file fails generation for every app | Same harness: `✗ failed to generate kustomization.yaml: … MalformedYAMLError` |
| F7 | Duplicate resource IDs across two app dirs fail the whole build | Same harness: `may not add resource with an already registered id` |
| F8 | **Gogs 0.14.3's contents API has no DELETE route** — GET and PUT only | Live probe: three `DELETE` request shapes all returned HTML `404` (unrouted), while `PUT` to the same path returned `201`. **This corrects the `AUTH NOTE` in `bootstrap-ssh-key.sh`, which wrongly claims `DELETE → 204 OK`** |
| F9 | `git clone` / `rm` / `commit` / `push` over HTTP basic auth works against the on-cluster Gogs with the existing `gogs-auth` credentials | Live: used it to delete the probe artifacts F8 created, since the API could not |
| F10 | The pluggable seam already exists: `GitRepository/user-apps-source` holds `spec.url`, `spec.ref.branch`, `spec.secretRef.name`; and `user-apps-ssh-key` (`identity`, `known_hosts`) is **already reflected into the `marketplace-ui` namespace** — just not mounted | Live inspection. `bootstrap-ssh-key.sh` annotates `reflection-auto-namespaces=flux-system,marketplace-ui` and comments *"Phase 1 only consumes the flux-system reflection"* — this was anticipated |
| F11 | Tier 1 e2e has **no cluster** (kubeconfig pinned to a closed port) and its Gogs exposes **only HTTP** on 43000, no port 22 | `projects/tier1.config.ts`, `support/kubeconfig.closed.yaml`, `docker-compose.e2e.yml` |

F6 is the pivotal trade-off: dropping the root `kustomization.yaml` removes a
shared mutable file, but that file was also acting as an **allow-list**. Once
gone, the whole tree is the build input — so orphaned directories left behind by
past uninstalls would come back to life, and a half-written app directory
becomes immediately visible to Flux. Both are addressed below (migration, and
atomic commits).

## Design

### 1. Three Flux layers, three distinct meanings

| Object | `Ready` means | health config |
|---|---|---|
| `user-apps-source` (Kustomization, from bootstrap OCI) | **the git source is seeded and clonable** | `wait: false` + `healthChecks: [GitRepository/user-apps-source]` |
| `user-apps` (Kustomization, from git) | the app declarations built and applied | `wait: false` |
| `marketplace-<app>` (Kustomization, from the app's OCI) | **that app is healthy** | `wait: true` — unchanged |

In all three `clusters/*/user-apps-source.yaml` (identical but for
`BASE_DOMAIN`):

```yaml
spec:
  dependsOn:
    - name: system-configs
    - name: gogs
  wait: false
  healthChecks:
    - apiVersion: source.toolkit.fluxcd.io/v1
      kind: GitRepository
      name: user-apps-source
      namespace: flux-system
```

In `infrastructure/user-apps-source/user-apps.yaml`: `wait: true` → `wait:
false`.

In `infrastructure/system-apps/marketplace-ui.yaml`: `dependsOn` gains
`user-apps-source` and loses `user-apps`.

No cycle: `user-apps-source` dependsOn `system-configs` + `gogs`, and the health
check is evaluated *after* apply, so the seed Job it applies is free to be what
makes the GitRepository Ready. The parent `system-apps` Kustomization does not
health-check (`wait` unset), so a blocked `marketplace-ui` cannot fail it.

After this change **nothing in the platform depends on user-app health.**

### 2. Repo layout — no shared root file

The root `kustomization.yaml` is removed; Flux auto-generates one from
`spec.path: ./` (F4, F5).

```
flux/user-apps
├── README.md
└── apps/
    └── vaultwarden/
        ├── kustomization.yaml   # still honored (F4) — no template changes
        ├── source.yaml
        ├── release.yaml
        └── secret.yaml
```

- Install = one commit adding `apps/<name>/`.
- Uninstall = one commit removing `apps/<name>/`.
- "Pitfall 3" write ordering disappears: atomicity comes from the commit, not
  from sequencing writes.

**`bootstrap-ssh-key.sh` must stop seeding `kustomization.yaml`** and seed only
`README.md`. Leaving it would seed an empty allow-list (`resources: []`) and
*nothing would ever deploy*. F5 confirms a README-only repo builds Ready, so the
gate still opens.

### 3. The git write layer

Two new units replacing `GogsService`'s REST writes:

**`GitClient`** — a thin wrapper over the `git` binary (`clone`, `fetch`,
`reset`, `add`, `rm`, `commit`, `push`). Transport comes from the URL scheme:

- `ssh://` → `GIT_SSH_COMMAND="ssh -i <identity> -o IdentitiesOnly=yes -o UserKnownHostsFile=<known_hosts>"`
- `https://` / `http://` → a `0600` credential file via `credential.helper`

Credentials are **never** interpolated into the remote URL — that leaks them
into `git remote -v`, the reflog, and error messages.

`isomorphic-git` was rejected: it has no SSH transport, and SSH is what Flux
already uses for this repo. The production image therefore adds `git` and
`openssh-client` to `node:22-alpine` (≈20MB).

**`UserAppsRepoService`** — replaces `GogsService`; provider-neutral, so the
Gogs-specific name goes with it. Surface:

| method | behavior |
|---|---|
| `listInstalledApps()` | directory names under `apps/` in the working copy |
| `writeApp(name, files)` | write files, `git add apps/<name>`, commit, push |
| `removeApp(name)` | `git rm -r apps/<name>`, commit, push |
| `migrateLayout()` | see §5 |

**Working copy.** One persistent shallow clone in an `emptyDir`. Before every
operation: `fetch --depth 1 && reset --hard origin/<branch>`. On any git error:
`rm -rf` and re-clone. A push rejected as non-fast-forward is retried once after
a re-fetch (covers a human editing the repo concurrently). The existing
`async-mutex` in `InstalledService` continues to serialize writes in-process.

Reads refresh the working copy when it is older than 10s, so `enrich()` does not
fetch once per request.

This retires the entire Gogs REST/token surface — `ensureToken`,
`ensureWritableToken`, the token bootstrap, and the endpoint-specific auth
matrix that produced #58, #176 and #177.

### 4. Discovery and credentials

The remote is discovered from the object Flux itself uses, so the installer can
never write to a repo Flux is not reading:

```
GET GitRepository/user-apps-source  →  spec.url, spec.ref.branch
credential                          →  mounted dir (default /etc/user-apps-git)
```

Credential shapes, selected by URL scheme and validated at startup:

- SSH: `identity` (+ optional `known_hosts`) — satisfied by the already-reflected
  `user-apps-ssh-key` (F10); needs only a volume + volumeMount.
- HTTP(S): `username` + `password` files, or `USER_APPS_GIT_USERNAME` /
  `USER_APPS_GIT_PASSWORD`.

Env overrides `USER_APPS_GIT_URL` and `USER_APPS_GIT_BRANCH` bypass discovery.
These are **required**, not conveniences: Tier 1 has no cluster to discover from
and no SSH transport (F11). This mirrors the existing `SYSTEM_APPS_OVERRIDE`
test seam.

Reading the *secret* from `flux-system` was rejected: `secretRef.name` is
dynamic, so RBAC could not scope it by `resourceNames` and the service would
need `get secrets` across all of `flux-system` (which holds every app's config
secrets and the cosign key). Mounting the credential keeps the URL — the thing
that must never diverge — auto-followed, with no privilege escalation.

### 5. Migration — mandatory, one atomic commit

On an existing cluster the old root `kustomization.yaml` is an allow-list. If it
survives the upgrade, **new installs are applied to nothing.** So, in order:

1. Read the root `kustomization.yaml`. Absent → no-op (idempotent).
2. `orphans` = directories under `apps/` **not** listed in `resources[]` →
   `git rm -r` each. These are already not deployed (F6 would otherwise
   resurrect them). Safe: a git deletion is a commit, so history keeps the
   content.
3. Delete the root `kustomization.yaml`.
4. One commit, one push.

Order matters: orphans first. Deleting the root file first would briefly make
every orphan live. Because it is a single commit, there is no half-migrated
state visible to Flux.

Migration is attempted at startup and re-attempted before the first write. It
**must not throw and wedge the container** when git is unreachable at boot —
that is exactly the #176 failure mode (a one-shot bootstrap that fails leaves
the container broken for its whole lifetime). Log and self-heal lazily.

### 6. Unchanged

`FluxStatusService`, the `marketplace.io/app` label, and all 29 `metadata.yaml`
`templates:` blocks — because Flux honors the nested `apps/<app>/kustomization.yaml`
(F4), and because no second per-app Kustomization is introduced, so the label
selector still matches exactly one object per app.

### 7. RBAC delta

```yaml
- apiGroups: ['source.toolkit.fluxcd.io']
  resources: ['gitrepositories']
  verbs: ['get', 'list', 'watch']
```

Guarded by adding a row to the `READS` table in `rbac-manifest.spec.ts`, which
exists precisely to catch this class of silent omission — the launch-tile
regression where a missing `list` grant was swallowed by the service and every
app's tile quietly fell back to a computed URL. No secret access.

### 8. Failure modes and degradation

| Condition | Behavior |
|---|---|
| git unreachable, working copy present | Reads serve the **stale** working copy |
| git unreachable, no working copy (cold start) | Reads return `[]` → all apps `not_installed` (today's contract) |
| git unreachable, write attempted | Write throws before mutating anything; install fails cleanly |
| One app unhealthy | Only `marketplace-<app>` goes `Ready=False`. `user-apps`, `user-apps-source`, `marketplace-ui` unaffected |
| One app's YAML malformed | `user-apps` `Ready=False` (F6) — but `user-apps-source` and `marketplace-ui` stay Ready, so the UI is reachable to uninstall it |
| GitRepository goes NotReady later (git down) | `user-apps-source` notices at its next reconcile and can block a `marketplace-ui` re-apply. Accepted: the installer genuinely requires its repo, and this is far narrower than app health |

The stale-read row is a deliberate **change** from today's "Gogs unreachable →
everything `not_installed`". Serving a stale-but-true list beats falsely
reporting nothing installed; write paths always fetch fresh and fail loudly. The
existing graceful-degradation test is updated accordingly rather than dropped.

## Testing

**Unit** — `GitClient` against a local bare repo (real git, no network);
`UserAppsRepoService` install/uninstall commit shapes; migration against an
old-shape fixture that includes an orphan; URL/credential discovery and the
startup validation error; the extended RBAC guard.

**Tier 1** (hermetic, real Gogs over HTTP with `USER_APPS_GIT_URL`) — install
commits `apps/<name>/` and nothing else; uninstall removes the directory
(previously impossible, F8); a repo seeded in the *old* shape migrates on boot.

**Tier 2** (k3d, real Flux) — the acceptance test for #182: install an app
pinned to a nonexistent OCI tag, then assert `marketplace-<broken>` reaches
`Ready=False` while `user-apps`, `user-apps-source` **and** `marketplace-ui` all
stay `Ready` and the UI still serves. Plus the existing install→`running` and
uninstall lifecycle tests.

**`cold-boot-repro.sh`** — the gate object changes from `user-apps` to
`user-apps-source`; the `GATE=HELD`/`GATE=OPEN` detection reads
`marketplace-ui`'s live `dependsOn`, so it needs the new name.

## Rollout

1. Manifest + server changes in one PR (per the approved single-change scope).
2. Version bump in **four** places — `apps/marketplace-ui/metadata.yaml`
   `spec.version`, the overlay's `newTag`, `infrastructure/system-apps/marketplace-ui.yaml`
   `ref.tag`, and `ui/package.json` (without the last one the image does not
   publish — see #184). `0.5.3` → `0.6.0`: new env, new RBAC, new volume, and a
   repo-layout migration.
3. Do **not** regenerate `catalog.yaml` locally; CI regenerates both copies.
4. Append a `DECISIONS_LOG.md` row (the log is append-only) recording the layer
   split and the move to a generic git client, and mark row 6 — #180's
   `dependsOn: user-apps` gate — as superseded by this change.
5. Verify on the dev cluster with `cold-boot-repro.sh` plus a deliberate
   broken-app install.

`docs/user-guide.md` §3.3 needs a small correction: the manual flow should
create `apps/<name>/` (it currently says a top-level directory), push to
`master` (it says `main`), and no longer mentions any root-file edit.

## Acceptance criteria

- [ ] Each installed app reconciles as its own Flux Kustomization, and a single
      broken app turns **no** shared object `Ready=False`.
- [ ] `marketplace-ui`'s gate depends on neither user-app health nor user-app
      content, while still holding #180's cold-boot guarantee
      (`cold-boot-repro.sh` green).
- [ ] Install and uninstall are each a single commit; uninstall actually removes
      the app's files.
- [ ] No shared root `kustomization.yaml` exists in a freshly seeded repo, and
      an existing repo migrates automatically and idempotently.
- [ ] Repointing `GitRepository/user-apps-source` at another provider requires
      no code change.
- [ ] Tier 1 and Tier 2 green, including the new broken-app isolation test.

## Deferred (not blocking)

- **#181** — install returns a retryable 503 instead of 500 on a missing/empty
  repo. Still worth doing; the gate no longer depends on it.
- **#169** — `marketplace.io/*` → `librepod.org/*` label migration (breaking).
- The existing ClusterRole grants `create/update/patch/delete` on Flux objects
  the server only ever reads. Unrelated cleanup; worth its own issue.
