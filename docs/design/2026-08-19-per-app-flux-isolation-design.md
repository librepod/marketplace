# Design: Per-App Flux Isolation and a Provider-Neutral Git Write Layer

**Date:** 2026-08-19
**Status:** Approved (design phase); revised 2026-08-22 after design review
**Author:** Alex Sukhov (with Claude)
**Issue:** [#182](https://github.com/librepod/marketplace/issues/182) — cross-refs #180, #181, #169

## Revision — 2026-08-22 (post-review)

Five changes, each recorded inline below. Listed here so the delta is legible to
anyone who read the first draft.

1. **HTTP(S) is the shipped git transport; `ssh://` is deferred** (§3, §4).
   `GitRepository/user-apps-source` moves back to `http://…` + the existing
   `Secret/user-apps-source-auth`. Three reasons, all evidence-backed: the
   hermetic test tier can only reach Gogs over HTTP (F11), so the HTTP path was
   mandatory either way and SSH would have shipped as the *only untested*
   transport; SSH's original "no baked-in credential" rationale no longer holds
   (F12); and the trailing-dot FQDN production needs (F13) is available to HTTP
   and unreachable for SSH without re-keying `known_hosts`.
2. **The credential is mounted through an always-present placeholder Secret**
   (§4). A credential that has not been reflected yet must degrade the installer,
   never stop the pod from starting.
3. **The broken-app acceptance test breaks the app in the repo**, not with a live
   `kubectl patch` (Testing). Flux drift-corrects a patched field within one
   `user-apps` interval, so the first shape raced its own assertion.
4. **The `user-apps-source` health-check budget rises 5m → 15m** (§1). A cold-boot
   bootstrap Job routinely needs longer than 5m, so the new gate would report a
   health-check timeout on every cold boot.
5. **Two more consumers were added to the change surface** (Rollout):
   `.claude/skills/verify-app/` and `ui/packages/e2e/support/run-tier2.sh`, both of
   which describe or probe the repo shape and credentials this change replaces.

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
- The transport the installer ships with is the transport its **hermetic** test
  tier exercises. One path, covered — not two paths with one of them only ever
  reached by the slow cluster tier.
- A credential that is missing or not yet reflected **degrades** the installer; it
  never prevents the pod from starting.

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
- **An `ssh://` transport in the installer.** The scheme dispatch seam stays, but
  the SSH branch is not implemented in this change (see §3). Rationale in F11–F13;
  adding it later is additive and needs no redesign.
- **Slimming the bootstrap Job.** Once Flux clones over HTTP the Job's keypair
  provisioning has no consumer, but it is also `cold-boot-repro.sh`'s deterministic
  lever and the provisioning half of a future SSH transport. Removing it is its own
  change with its own cold-boot verification (see Deferred).
- **Rotating the static `flux` credential** committed in
  `apps/gogs/components/bootstrap-admin/secret.env` (F12). Pre-existing, orthogonal,
  and worth its own issue.

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
| F10 | The pluggable seam already exists: `GitRepository/user-apps-source` holds `spec.url`, `spec.ref.branch`, `spec.secretRef.name`; and `user-apps-ssh-key` (`identity`, `known_hosts`) is **already reflected into the `marketplace-ui` namespace** — just not mounted | Live inspection. `bootstrap-ssh-key.sh` annotates `reflection-auto-namespaces=flux-system,marketplace-ui` and comments *"Phase 1 only consumes the flux-system reflection"* — this was anticipated. **Partly superseded by F12–F15:** the seam is real, but the credential this change mounts is `user-apps-source-auth`, not the ssh key |
| F11 | Tier 1 e2e has **no cluster** (kubeconfig pinned to a closed port) and its Gogs exposes **only HTTP** on 43000, no port 22 | `projects/tier1.config.ts`, `support/kubeconfig.closed.yaml`, `docker-compose.e2e.yml` |
| F12 | SSH's original rationale — *"provider-agnostic, no baked-in credential"* (commit `2960086`, #50) — **no longer holds**: the `flux` account's password is a committed literal in `apps/gogs/components/bootstrap-admin/secret.env`, reflected into `flux-system` **and** into `marketplace-ui` (as `gogs-auth`). The ed25519 key guards a transport whose underlying account secret is in git | Read the file; `git show 2960086` for the rationale; live: `Secret/user-apps-source-auth` present in `flux-system` with `username`/`password`, `Secret/gogs-auth` present in `marketplace-ui` |
| F13 | **Open contradiction about the trailing-dot FQDN — must be resolved, not assumed.** `configmap.yaml`'s `GOGS_URL` carries `gogs.gogs.svc.cluster.local.` with a comment recording a real failure: a 4-dot name (`ndots:5`) is search-expanded first, and where the app zone is in the search list the expansion is rewritten to Traefik, so "every Gogs API call breaks and installs silently degrade to not_installed". The plan's first draft dismissed this using dev-cluster evidence that **cannot reproduce the condition**. Either the dot is unnecessary (then that comment is wrong and should be corrected) or it is necessary (then a dotless `ssh://` URL has the same exposure and SSH cannot take the dot without re-keying `known_hosts`) | Live, and deliberately incomplete: `coredns-custom` **does** carry the wildcard `rewrite stop { name regex (.*\.)?libre\.pod\. traefik.traefik.svc.cluster.local }` (plus two more zones); dev pods **do not** carry the app zone — `/etc/resolv.conf` in both `marketplace-ui` and `source-controller` reads `search <ns>.svc.cluster.local svc.cluster.local cluster.local`; and the dotless `ssh://` URL clones fine **on dev**. **Not verified: whether a production device's POD search list carries the app zone** (kubelet appends the node's search domains, and the existing comment says "every LibrePod device and the dev box" carry it — but the bootstrap Job also uses a dotless in-cluster URL and works, which points the other way). Confirm with `kubectl exec … cat /etc/resolv.conf` on a device before trusting either reading. Using the absolute form is the choice that is safe under **both** answers |
| F14 | Moving Flux back to HTTP is a **two-line manifest change with no new machinery**: that was the transport before #50 (`http://gogs.gogs.svc.cluster.local:80/flux/user-apps.git` + `secretRef: user-apps-source-auth`), the Secret is still generated and still reflected into `flux-system`, and `Service/gogs` still exposes both ports | `git show 2960086 -- infrastructure/user-apps-source/gitrepository.yaml`; live: the Secret exists in `flux-system`, `Service/gogs` shows `80/TCP,22/TCP` |
| F15 | `Secret/user-apps-source-auth`'s keys are exactly `username` and `password` — the two filenames the HTTP credential path already looks for in its mounted directory. No key mapping needed | Live inspection of the Secret's `data` keys |
| F16 | A live `kubectl patch` of a per-app `OCIRepository` is **reverted by drift correction** within one `user-apps` interval (1m), because that object is part of `user-apps`'s inventory and kustomize-controller re-applies on every reconcile | Reasoned from documented kustomize-controller behavior, **not** live-probed. The replacement test therefore asserts break-*stability* explicitly (§Testing), so a wrong assumption fails loudly instead of flaking |
| F17 | The cold-boot health-check budget is too small: `timeout: 5m` on all three `clusters/*/user-apps-source.yaml`, while the bootstrap Job alone waits **up to 300s** for Gogs to accept credentials *before* keygen, keyscan and up to five push retries | Read `bootstrap-ssh-key.sh` (`for i in $(seq 1 60); … sleep 5`) against `interval: 1h`/`retryInterval: 2m`/`timeout: 5m` in all three cluster files |
| F18 | **`apps/gogs/` needs no change for the transport flip.** Gogs' smart-HTTP git is already enabled and already grants the `flux` credential both read *and write*; it is also already the supplier of everything the HTTP path consumes (`base/service.yaml` publishes port 80; `components/bootstrap-admin/` generates `Secret/user-apps-source-auth` with the `username`/`password` keys a Flux `secretRef` expects, annotated `reflection-auto-namespaces: flux-system` — where source-controller reads it) | Live, from inside a pod against `gogs.gogs.svc.cluster.local(.):80`: `info/refs?service=git-upload-pack` + basic auth → `200 application/x-git-upload-pack-advertisement`; `service=git-receive-pack` → `200 application/x-git-receive-pack-advertisement` (**push** allowed); no credential → `401` (private repo still protected); dotless and trailing-dot hosts behave identically; the live `app.ini` has no `DISABLE_HTTP_GIT` (Gogs default `false`). `REQUIRE_SIGNIN_VIEW = true` and `EXTERNAL_URL = http://git.<zone>/` do not interfere — Gogs performs no Host validation, which is why a ClusterIP-name clone succeeds. Also probed and **ruled out**: `ENABLE_REVERSE_PROXY_AUTHENTICATION` does not extend to `/api/v1/*` (header-only requests return `403`, same as no header), so it is not a factor here |

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
  # 5m → 15m: this is now a *health-check* budget, not just an apply budget. The
  # GitRepository cannot go Ready until the bootstrap Job has seeded the repo, and
  # that Job alone waits up to 300s for Gogs to accept credentials before it even
  # starts working (F17). At 5m the gate reported a health-check timeout on every
  # cold boot and recovered on the next retryInterval — noise that looks exactly
  # like the failure this gate exists to catch.
  timeout: 15m
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

**What this buys, and what it does not.** It buys atomicity, real deletion, and
the end of a shared mutable file. It does **not** buy build isolation — F6/F7 show
the reverse: with the whole tree as the build input, one malformed YAML or one
duplicate resource ID fails the build for *every* app, where the old root file's
allow-list would have ignored anything it did not list. That residual coupling is
bounded in §8. **No user-facing text — least of all the seeded `README.md` — may
claim that one app's files cannot affect another's.** Health isolation is what
§1 delivers; build isolation is explicitly not on offer.

**`bootstrap-ssh-key.sh` must stop seeding `kustomization.yaml`** and seed only
`README.md`. Leaving it would seed an empty allow-list (`resources: []`) and
*nothing would ever deploy*. F5 confirms a README-only repo builds Ready, so the
gate still opens.

### 3. The git write layer

Two new units replacing `GogsService`'s REST writes:

**`GitClient`** — a thin wrapper over the `git` binary (`clone`, `fetch`,
`reset`, `add`, `rm`, `commit`, `push`). Transport is selected from the URL
scheme, and **only `http://` / `https://` is implemented in this change**: a
`0600` credential file consumed via `credential.helper`. An `ssh://` URL is
rejected at resolution time with a message naming the follow-up issue — a loud
"this build does not speak ssh" beats a mysterious auth failure.

Credentials are **never** interpolated into the remote URL — that leaks them
into `git remote -v`, the reflog, and error messages.

Why HTTP is the shipped transport rather than SSH:

- **Coverage.** Tier 1 is the only hermetic tier and its Gogs has no port 22
  (F11), so the HTTP path had to exist regardless. Shipping SSH as the default
  would make the *production* transport the one only the slow k3d tier ever
  touches, while every fast test exercises a path no cluster runs.
- **The security argument is already lost.** SSH was adopted for "no baked-in
  credential" (F12), but the `flux` account password is a committed literal
  reflected into two namespaces. The keypair buys ceremony, not secrecy — at a
  cost of ~80 lines of bootstrap shell (keygen, admin key registration plus the
  422 unique-title workaround from #57, `ssh-keyscan`) and `openssh-client` in
  the app image.
- **DNS.** Production needs the trailing-dot FQDN (F13). HTTP can use it freely;
  SSH cannot without re-keying `known_hosts` in both `ssh-keyscan` and the
  GitRepository URL, because host keys are bound to the exact name given.
- **The reversal costs one manifest edit** (F14), against a credential that
  already exists in exactly the right shape (F15).

What HTTP gives up, stated plainly: basic auth crosses the pod network in
plaintext, and key rotation is no longer decoupled from the account password.
Both are acceptable here — cluster-internal traffic on a single-node appliance,
and a password that is already public — but both become real the day F12 is
fixed. That is when in-cluster TLS (step-certificates is already on the cluster)
or the deferred SSH branch should be revisited.

`isomorphic-git` was rejected: the `git` CLI is one `apk add` (≈10MB) and gives
shallow clones, `credential.helper`, and semantics identical to what Flux does.
The production image adds **`git` only** — no `openssh-client`.

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

### 4. The remote, and how it is authenticated

`GitRepository/user-apps-source` moves back to HTTP, with the trailing-dot FQDN
(F13) and the credential that already exists (F14, F15):

```yaml
spec:
  # Trailing dot = absolute FQDN. Do NOT remove it: with ndots:5 a 4-dot name is
  # search-expanded first, and on a device whose pod search list carries the app
  # zone that expansion is rewritten to Traefik's ClusterIP by coredns-custom
  # (F13). The same hazard is why marketplace-ui's GOGS_URL carried this dot.
  url: http://gogs.gogs.svc.cluster.local.:80/flux/user-apps.git
  ref:
    branch: master
  secretRef:
    name: user-apps-source-auth
```

The installer then **discovers** that URL from the object Flux itself uses, so it
can never write to a repo Flux is not reading:

```
GET GitRepository/user-apps-source  →  spec.url, spec.ref.branch
credential                          →  mounted dir (default /etc/user-apps-git)
```

The discovered URL is used **verbatim**. No rewriting, no scheme translation, no
host normalisation — the whole point of discovery is that the two sides cannot
diverge, and the trailing dot now lives in the manifest where both sides read it.

Credential shape, validated when the remote is resolved:

- HTTP(S): files `username` + `password` in the mounted directory, or
  `USER_APPS_GIT_USERNAME` / `USER_APPS_GIT_PASSWORD`. `Secret/user-apps-source-auth`
  already has exactly those two keys (F15), so mounting it needs no key mapping.
- `ssh://`: rejected with a clear error (see §3). `Secret/user-apps-ssh-key` keeps
  being provisioned and reflected (F10) — it is the bootstrap Job's idempotency
  lever and the provisioning half of the deferred SSH branch — it is simply not
  mounted or read.

**The credential is mounted through an always-present placeholder.** The Secret in
this namespace is Reflector-populated, so it can be briefly absent — during a
rotation, or during `cold-boot-repro.sh`, which deletes it in all three
namespaces. A plain `secret:` volume would then fail to mount and the container
would never start: no `/api/health`, nothing to debug against, and a gate that
looks held when it is open. So the app declares its own empty
`secretGenerator` and lets Reflector fill it — exactly the pattern `gogs-auth`
already uses:

```yaml
secretGenerator:
- name: user-apps-git-auth
  options:
    disableNameSuffixHash: true
    annotations:
      reflector.v1.k8s.emberstack.com/reflects: "gogs/user-apps-source-auth"
```

With the placeholder empty the pod boots, reads degrade per §8, and the first
write fails loudly with "no username/password in …". That is the correct failure
ordering, and it retires the `gogs-auth` generator rather than leaving it orphaned.

Env overrides `USER_APPS_GIT_URL` and `USER_APPS_GIT_BRANCH` bypass discovery.
These are **required**, not conveniences: Tier 1 has no cluster to discover from
(F11). This mirrors the existing `SYSTEM_APPS_OVERRIDE` test seam. Because the
shipped transport is now the same one Tier 1 drives, that seam changes only *where*
the URL comes from — not which code path runs.

Reading the *secret* from `flux-system` was rejected: `secretRef.name` is
dynamic, so RBAC could not scope it by `resourceNames` and the service would
need `get secrets` across all of `flux-system` (which holds every app's config
secrets and the cosign key). Mounting the credential keeps the URL — the thing
that must never diverge — auto-followed, with no privilege escalation.

The resolved remote is cached for the process lifetime, so **repointing the
GitRepository at another provider also needs a pod restart** (`kubectl rollout
restart`). Worth stating because the acceptance criterion says "no code change" —
that is true, and it is not the same as "no restart".

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
| Credential Secret empty (not yet reflected, or mid-rotation) | **Pod starts** (placeholder volume, §4). Reads return `[]`; the first write fails loudly with `no username/password in …`. Self-heals once Reflector fills it — the resolved remote is cached only on success |
| `GitRepository.spec.url` is `ssh://` (operator override) | Resolution throws a named "ssh transport not implemented in this release" error. Reads degrade to `[]`, writes fail loudly. Deliberate: far better than silently committing to a repo the installer cannot reach |
| GitRepository goes NotReady later (git down) | `user-apps-source` notices at its next reconcile and can block a `marketplace-ui` re-apply. Accepted: the installer genuinely requires its repo, and this is far narrower than app health. Note the reconcile is `interval: 1h`, so detection is slow by design — which is the *right* bias for a gate that must not flap |

The stale-read row is a deliberate **change** from today's "Gogs unreachable →
everything `not_installed`". Serving a stale-but-true list beats falsely
reporting nothing installed; write paths always fetch fresh and fail loudly. The
existing graceful-degradation test is updated accordingly rather than dropped.

## Testing

**Unit** — `GitClient` against a local bare repo (real git, no network);
`UserAppsRepoService` install/uninstall commit shapes; migration against an
old-shape fixture that includes an orphan; URL/credential discovery, the `ssh://`
rejection, and the missing-credential error; the extended RBAC guard.

Two fidelity rules for these fixtures, because the defaults quietly lie:

- Address the fixture origin as **`file://<path>`**, not a bare path. `git clone
  --depth 1 /some/path` *ignores* `--depth` for local clones, so a bare path makes
  every unit test exercise a full clone and leaves the shallow behaviours the
  design depends on — `fetch --depth 1` updating `refs/remotes/origin/<branch>`,
  and pushing from a shallow clone — completely uncovered.
- `fetchAndReset` needs a test that a **new upstream commit is observed**, not only
  that local mess is discarded. A refspec bug that never advances
  `refs/remotes/origin/<branch>` passes the discard test and produces permanently
  stale reads in production.

**Tier 1** (hermetic, real Gogs over HTTP with `USER_APPS_GIT_URL`) — install
commits `apps/<name>/` and nothing else; uninstall removes the directory
(previously impossible, F8); a repo seeded in the *old* shape migrates on boot.
Now that HTTP is the shipped transport, Tier 1 covers the **production** code
path; the override changes only where the URL comes from.

**Tier 2** (k3d, real Flux) — the acceptance test for #182: one app degrades
alone while `user-apps`, `user-apps-source` **and** `marketplace-ui` stay `Ready`
and the UI still serves. Plus the existing install→`running` and uninstall
lifecycle tests.

The break must be **declarative — committed to the repo, not patched onto the
live object.** A `kubectl patch` of the app's `OCIRepository` is reverted by drift
correction within one `user-apps` interval (F16), so the first draft of this test
raced its own assertion. Installing the app normally and then rewriting its
`source.yaml` in the repo makes the broken state the *desired* state, so Flux
enforces it instead of healing it — and it exercises the new "presence in the repo
IS the declaration" contract at the same time. The spec also asserts the break
**survives two `user-apps` reconciles**, so if F16 is wrong in either direction the
test says so instead of flaking.

**`cold-boot-repro.sh`** — the gate object changes from `user-apps` to
`user-apps-source`; the `GATE=HELD`/`GATE=OPEN` detection reads
`marketplace-ui`'s live `dependsOn`, so it needs the new name. Its
delete-Secret-and-Job lever is unaffected: the Job's idempotency guard still keys
on `Secret/user-apps-ssh-key`, which this change keeps provisioning.

**`run-tier2.sh` diagnostics** — `dump_diagnostics()` probes the repo through the
server pod using `GOGS_URL` / `GOGS_USERNAME` / `GOGS_TOKEN` and fetches
`raw/master/kustomization.yaml`. All three env vars are deleted by this change and
that file no longer exists, so the probe would silently return nothing exactly when
it is needed. It has to be reworked onto the git working copy.

## Rollout

1. Manifest + server changes in one PR (per the approved single-change scope).
   The manifest half is now five things, not three: the layer split (§1), the
   `timeout: 15m` bump in all three `clusters/*/user-apps-source.yaml`, the
   GitRepository transport flip (§4), the placeholder credential Secret (§4), and
   the seed-content change (§2).
2. Version bump in **four** places — `apps/marketplace-ui/metadata.yaml`
   `spec.version`, the overlay's `newTag`, `infrastructure/system-apps/marketplace-ui.yaml`
   `ref.tag`, and `ui/package.json` (without the last one the image does not
   publish — see #184). `0.5.3` → `0.6.0`: new env, new RBAC, new volume, and a
   repo-layout migration.
3. Do **not** regenerate `catalog.yaml` locally; CI regenerates both copies.
4. `DECISIONS_LOG.md` gets **two** rows for this work, since a future reader may
   want to reverse one without the other. **Row 7 (the HTTP transport) already
   landed** — it was recorded when the decision was taken, not when it ships. Row 8
   (the layer split + generic git client) is appended at release, and row 6 —
   #180's `dependsOn: user-apps` gate — is marked **Superseded by row 8** (the log
   numbers decisions, not issues).
5. Verify on the dev cluster with `cold-boot-repro.sh` plus a deliberate
   broken-app install.

Three consumers document or probe what this change replaces and all three must
move with it:

- `docs/user-guide.md` §3.3 — the manual flow should create `apps/<name>/` (it
  says a top-level directory), push to `master` (it says `main`), and no longer
  mention any root-file edit.
- `.claude/skills/verify-app/` — `SKILL.md` still instructs "update the root
  `kustomization.yaml`" (:187) and "remove from root kustomization.yaml" (:292),
  and `references/troubleshooting.md` still diagnoses a missing root entry (:129)
  and a stale `user-apps-source-auth` (:109). After this change step :187 is not
  merely stale — `migrateLayout()` would *undo* it.
- `ui/packages/e2e/support/run-tier2.sh` — the diagnostics probe (see Testing).

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
      no code change (a pod restart is expected — see §4).
- [ ] The installer's shipped transport is exercised by **Tier 1**, and no
      unexercised transport ships: `git grep` finds no `GIT_SSH_COMMAND` and the
      runtime image has no `openssh-client`.
- [ ] The pod starts and `/api/health` answers with the credential Secret **empty**;
      the first write then fails with a message naming the missing credential.
- [ ] The broken-app test's break survives two `user-apps` reconciles (no drift
      correction race, F16).
- [ ] Tier 1 and Tier 2 green, including the new broken-app isolation test.

## Deferred (not blocking)

- **#181** — install returns a retryable 503 instead of 500 on a missing/empty
  repo. Still worth doing; the gate no longer depends on it.
- **#169** — `marketplace.io/*` → `librepod.org/*` label migration (breaking).
- The existing ClusterRole grants `create/update/patch/delete` on Flux objects
  the server only ever reads. Unrelated cleanup; worth its own issue.
- **`ssh://` transport in the installer** — `GitRemoteService.sshAuth()`, the
  `known_hosts` contract, the 0600 identity copy (Secret volumes mount
  world-readable and `ssh` rejects such a key), and `openssh-client` in the image.
  Additive; the scheme dispatch and the loud rejection are already in place. Do it
  when a user needs a provider that requires SSH, and give it a hermetic test tier
  first — that is the whole reason it is not in this change.
- **Slim the bootstrap Job, then stop serving SSH from Gogs** — one follow-up, two
  halves that must move in that order. Once the Job's seed push uses HTTP, keygen,
  admin key registration (with the #57 unique-title workaround) and `ssh-keyscan`
  have no consumer (~80 lines); only *then* can `apps/gogs/base/app.ini` drop
  `DISABLE_SSH` / `START_SSH_SERVER` / `SSH_PORT` / `SSH_LISTEN_PORT` and
  `apps/gogs/base/service.yaml` drop its port-22 entry. Worth more than tidiness:
  the seed push is the only remaining reason Gogs runs an SSH daemon at all, so
  this removes a listener rather than just dead config. Blocked on: giving
  `cold-boot-repro.sh` a new idempotency lever, since it currently deletes
  `Secret/user-apps-ssh-key` to force a reseed, and on re-running the full
  cold-boot verification. **Not** blocked on anything in `apps/gogs` for the flip
  itself — see F18.
- **Rotate the committed `flux` credential** (F12). Until then, treat the
  plaintext-basic-auth trade-off in §3 as the deliberate choice it is; after it,
  revisit in-cluster TLS or SSH.
