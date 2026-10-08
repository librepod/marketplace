# App install settings — design

**Status:** design approved in brainstorming; written spec awaiting review
**Date:** 2026-10-04
**Branch:** `feat/marketplace-ui-improve-app-install-ux`
**Depends on:** the OpenBao system-app story (separate, in progress)

## 1. Goal

LibrePod is a consumer device for non-tech-savvy users. LibrePod deploys every app with tuned,
stable defaults, so installing an app normally needs no input. Some apps, though, cannot work
until the user supplies something (e.g. renovate needs an access token). This feature lets:

- an app **ask the user a few install-time questions** (masked when sensitive), and
- a **tech-savvy user add free-form environment variables** (key/value) at install time,

while the UI never mentions ConfigMaps, Secrets, Flux, OpenBao or namespaces. All answers are
stored in **OpenBao**, and apps stay self-contained in their own namespace.

## 2. Scope

**In scope:** a `settings` block in `metadata.yaml`; installer + API changes in marketplace-ui;
an install dialog; the platform glue between OpenBao and apps (External Secrets as a system
app, a ClusterSecretStore, two OpenBao policies); two pilot apps (renovate, open-webui).

**Out of scope (future work):**
- Running OpenBao itself (auto-unseal, KV mount, Kubernetes auth) — the OpenBao story.
- Migrating today's Gogs-stored generated secrets (`secrets[].generate`) to OpenBao, and
  generated values in `settings` — a follow-up story.
- Editing or viewing settings after install.
- "Deep uninstall" that wipes an app's OpenBao entry and NFS data.
- Replacing `templates` in `metadata.yaml` with declarative fields.
- Per-namespace isolation of OpenBao entries.
- Protecting devices on older bootstrap versions from catalog changes (see D9).

## 3. Background: how install works today

1. "Install App" sends `POST /api/apps/:name/install` with **no body**
   (`ui/packages/client/src/hooks/useInstallApp.ts`).
2. `InstalledService.install()` fills `${VAR}`s from only `BASE_DOMAIN` and one random hex value
   per `secrets[].generate` (`ui/packages/server/src/installed/installed.service.ts`), by regex
   text replacement over the catalog templates.
3. The installer commits `apps/<name>/{source,release,secret?,kustomization}.yaml` to the
   user-apps Gogs repo in one commit; uninstall deletes `apps/<name>/`.
4. `Kustomization/user-apps` applies the repo verbatim; each app's `marketplace-<app>`
   Kustomization (in `flux-system`) builds the app's OCI overlay with `postBuild` substitution.

Findings that shape this design:
- `spec.params` is dead data: declared in many apps, read by nothing.
- Flux `${VAR}` substitution is unsafe for user-typed text: kustomize strips quotes, so every
  substituted value becomes a bare YAML scalar (`8080` → int, `on` → bool, `a: b` → invalid
  YAML). User values must never pass through it.
- renovate is not installable from the UI today (its required token has nowhere to come from,
  and its `secret.yaml` is never applied). open-webui declares `OLLAMA_ENABLED`, but nothing
  passes it to the chart.

## 4. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `settings` holds only an app's **install questions** — not a mirror of its configuration. LibrePod defaults stay in the app's `.env` / chart values and are never shown | Users must not need to touch tuned defaults; avoids maintaining every variable in `metadata.yaml` |
| D2 | **Every answer and custom variable is stored in OpenBao**, one KV v2 entry `apps/<app>` per app | One store and one code path; no secrets in git |
| D3 | Each opted-in app ships an **`ExternalSecret <app>-settings`** in its own base; workloads read the resulting Secret via `envFrom` (Kustomize) or `valuesFrom` (Helm) | The app's own Kustomization creates the namespace, so there is no ordering problem and no extra Flux object |
| D4 | `sensitive` controls **UI masking only** | Storage is the same for every value |
| D5 | **Custom variables may override LibrePod defaults** (the settings Secret comes last in `envFrom`); apps opt in with `allowCustom` (default `false`) | An advanced user who sets a variable expects it to take effect |
| D6 | **One owner per variable:** a variable is either a LibrePod default (`.env`) or an install question (`settings`), never both | No default is duplicated, so nothing drifts |
| D7 | **Uninstall leaves the OpenBao entry** (like NFS data) in place | A reinstall stays consistent with data that survived; a future deep uninstall wipes both |
| D8 | **Legacy apps install exactly as today**, with no dialog; apps move to `settings` one by one | No migration in this spec |
| D9 | **Accept** that a device on an older bootstrap can list a migrated app and fail to install it | No crucial customer devices yet; catalog versioning is not worth it now |
| D10 | Enterprise edition swaps the **ClusterSecretStore backend** (Vault, AWS Secrets Manager, …) | One cluster object; no per-app change |

## 5. Design

### 5.1 `metadata.yaml` `settings` contract

```yaml
spec:
  settings:
    allowCustom: true            # default false; set only when custom vars reach the app
    items:                       # the app's install questions
      - name: RENOVATE_TOKEN     # env var name, ^[A-Z_][A-Z0-9_]*$
        label: "Access token"    # optional; fallback = humanized name
        description: "Personal access token for your Git platform"
        sensitive: true          # masked input
        required: true
      - name: RENOVATE_GITHUB_COM_TOKEN
        label: "GitHub.com token"
        sensitive: true          # optional question; left empty → not written
```

Item fields: `name` (required), `label`, `description`, `type` (`string | boolean | number`,
default `string`), `options` (fixed choices → dropdown), `default` (pre-fills the answer),
`required`, `sensitive`.

- `items` may be empty (an app that only allows custom variables).
- `BASE_DOMAIN` (and any future platform-provided value) is **reserved**: never a question or a
  custom variable name. It keeps flowing through the release template's `postBuild.substitute`.
- `settings` may coexist with the legacy `params` / `secrets` / `templates.secret`; the two
  mechanisms are independent. (`params` stays ignored, as today.)
- `scripts/generate-catalog.sh` must pass `settings` through to `catalog.yaml`, and
  `@librepod/shared` gains the types.

### 5.2 Storage and delivery

**OpenBao entry:** KV v2, key `apps/<app>` under the KV mount the ClusterSecretStore points at.
Data is a flat map of string values: answered questions plus custom variables. Booleans are
stored as `"true"`/`"false"`, numbers as decimal strings.

**App side** (per-app opt-in, shipped in the app's base):

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: renovate-settings
spec:
  secretStoreRef: {kind: ClusterSecretStore, name: openbao}
  target: {name: renovate-settings}
  dataFrom:
    - extract: {key: apps/renovate}
```

- **Kustomize apps:** `envFrom: [<app> ConfigMap, <app>-settings Secret]`. The settings Secret
  comes last and wins, so custom variables can override `.env` defaults. The Secret reference is
  **non-optional**, so pods wait until ESO has synced it. Explicit `env:` entries win over both,
  so an app with `allowCustom` keeps its defaults in the `.env` ConfigMap, not inline `env:`.
- **Helm apps:** the HelmRelease uses `valuesFrom` (`kind: Secret`, `name: <app>-settings`,
  `valuesKey: <NAME>`, `targetPath: <chart.path>`) and must **not** also set that path in inline
  `values` (Flux merges inline `values` last, so they would win). A question wired through
  `valuesFrom` must always have an answer (`required` or a `default`), so the key always exists
  and `optional: true` is never needed. Custom variables only if the chart has an
  `extraEnvFrom`-style value.
- The ExternalSecret is applied by the app's own `marketplace-<app>` Kustomization, which also
  creates the namespace. App status keeps coming from that Kustomization, unchanged.
- Uninstall prunes the app's Kustomization → the namespace, ExternalSecret and synced Secret go
  with it. The OpenBao entry stays (D7).

### 5.3 Installer and API

`POST /api/apps/:name/install`, optional JSON body:

```json
{ "settings": { "RENOVATE_TOKEN": "…" },
  "custom":   [ { "name": "HTTP_PROXY", "value": "…" } ] }
```

An empty body means "all defaults" — valid for apps with no `settings` and for apps whose
questions are all optional or have defaults, so the current client and e2e keep working.

**Flow:**
1. Validate (below). Failure → `400 { message, errors: [{ name, message }] }`.
2. For apps with `settings`: resolve each question (user input → `default` → omitted when
   optional and empty), add custom variables, and **write the whole entry** to OpenBao (a new
   KV v2 version; earlier versions remain as history). The entry is written even when empty,
   so the app's ExternalSecret always finds it. OpenBao unreachable, sealed or refusing auth →
   `503` with a plain message; details go to the server log.
3. Commit the Gogs files exactly as today. No settings data goes into Gogs.
4. If step 3 fails, the OpenBao entry stays; the next install overwrites it.

Apps without `settings` skip step 2 and never touch OpenBao.

**Validation** runs **on the server only** (`@librepod/shared` is type-only — runtime code there
breaks the server build). The dialog shows the server's per-field errors; no client-side copy
of the rules to drift. Error `name`s: the question's name, `custom.<index>` for a custom
variable (index into the submitted `custom` list), or `settings` / `custom` for whole-request
problems.
- Unknown keys in `settings` → error. `custom` present while `allowCustom` is false → error.
- `required` questions non-empty; `options` membership; `boolean` is `true`/`false`; `number`
  parses as a finite number.
- Custom names match `^[A-Za-z_][A-Za-z0-9_]*$`, are unique, and don't collide with a question
  name or a reserved name.
- Limits: names ≤ 128 chars, each value ≤ 16 KiB, all names + values ≤ 64 KiB in total,
  ≤ 50 custom variables. Keeps the request under Nest's default 100 KB JSON body limit and the
  synced Secret far below Kubernetes' 1 MiB. Otherwise any text, including multi-line.
- A request body sent to an app **without** `settings` is ignored (backward compatible).

**OpenBao client** (server): plain HTTP (`fetch`), no SDK. Logs in with Kubernetes auth using
the pod's ServiceAccount token, caches the client token until shortly before its lease expires
(re-logs in once on a `403`), and writes `<mount>/data/apps/<app>`. Env (via marketplace-ui's
ConfigMap): `OPENBAO_ADDR` (unset ⇒ every settings install returns `503`), `OPENBAO_AUTH_MOUNT`
(default `kubernetes`), `OPENBAO_AUTH_ROLE` (default `marketplace-ui`), `OPENBAO_KV_MOUNT`
(default `secret`), `OPENBAO_SA_TOKEN_PATH` (default the in-pod ServiceAccount token path).
`OPENBAO_TOKEN` is a **test seam only** (a static token that skips the Kubernetes login, for
Tier 1's dev-mode OpenBao) — never set it in cluster manifests.

### 5.4 Install dialog

- App **without** `settings` → one-click **Install App**, exactly as today.
- App **with** `settings` → **Install App** opens a dialog, pre-filled with defaults, so a user
  with nothing to change just clicks **Install**.

```
┌ Install Renovate ───────────────────────────────┐
│ Access token                                    │
│ [•••••••••••••••••••••••••••••••••••••]  (eye)  │
│ Personal access token for your Git platform     │
│                                                 │
│ GitHub.com token (optional)                     │
│ [                                     ]  (eye)  │
│ Used to fetch changelogs when …                 │
│                                                 │
│ ▸ Custom environment variables                  │
│                           [Cancel]  [Install]   │
└─────────────────────────────────────────────────┘
  expanded:
│ ▾ Custom environment variables                  │
│   For advanced users. Adds variables or         │
│   overrides built-in ones — may break the app.  │
│   [NAME         ] [••••••••••]  (eye)  (remove) │
│   [+ Add variable]                              │
```

- Input per question type: text; `sensitive` → masked with a show/hide toggle; `boolean` →
  switch; `options` → dropdown; `number` → numeric field.
- Required questions first; optional ones are labelled "(optional)" rather than marked with
  asterisks.
- The custom-variables section appears only when `allowCustom` is true and starts collapsed.
  Values are masked with show/hide; there is no per-row "sensitive" checkbox.
- Validation runs on the server when **Install** is clicked; `400` errors appear under their
  field (matched by `name`).
- Errors not tied to a field (e.g. `503`) appear **inside the dialog**, which stays open with
  every input kept, so nobody retypes a token. Plain wording, e.g. "Couldn't save the settings
  right now. Try again in a minute."
- On success the dialog closes; the existing "Install started" toast and status polling are
  unchanged.
- A reinstall starts from defaults (stored values are not read back).
- New UI components: shadcn `dialog` and `switch` (on `@base-ui/react`); native `<select>`,
  `<details>` and `<label>` for the rest. Plain React state, no form library.
- `useInstallApp` sends the body. One-click installs keep today's error toast; dialog installs
  show errors in the dialog instead (no toast).

### 5.5 Platform pieces

Assumes the OpenBao story delivers: OpenBao running as a system app with **auto-unseal**, a KV
v2 mount, and the Kubernetes auth method enabled.

- **External Secrets becomes a system app:** `infrastructure/system-apps/external-secrets.yaml`
  (OCIRepository + Kustomization, like the other system apps), listed in that folder's
  `kustomization.yaml`. Today `apps/external-secrets` exists only as a catalog app.
- **`ClusterSecretStore openbao`** (provider `vault`, KV v2, Kubernetes auth), in a
  Kustomization that depends on External Secrets (CRDs must exist) and on OpenBao.
- **Two OpenBao policies/roles**, kept wherever the OpenBao story keeps OpenBao configuration:
  - External Secrets' ServiceAccount: **read** `apps/*`.
  - marketplace-ui's ServiceAccount: **create/update** `apps/*` (no delete, per D7).
- marketplace-ui gets **no** `dependsOn` on OpenBao: apps without settings keep installing even
  when OpenBao is down.
- Accepted limitation: any namespace's ExternalSecret can read any `apps/*` entry through the
  ClusterSecretStore. Acceptable while only Flux applies curated manifests.

## 6. Rollout

Order matters: the catalog reaches every cluster about 5 minutes after merge, while
marketplace-ui and the platform are pinned per bootstrap version.

1. **Prerequisite:** the OpenBao story is merged and deployed.
2. **Platform** (§5.5): External Secrets system app, ClusterSecretStore, OpenBao policies.
3. **marketplace-ui** (§5.1–5.4), supporting both old and new metadata shapes. Release with the
   usual three bumps: product version in `ui/package.json` → `apps/marketplace-ui/metadata.yaml`
   version + overlay tag → `infrastructure/system-apps/marketplace-ui.yaml` `ref.tag`.
4. **Pilots, only after step 3 is deployed:**
   - **renovate** — questions `RENOVATE_TOKEN` (required, sensitive) and
     `RENOVATE_GITHUB_COM_TOKEN` (optional, sensitive); `allowCustom: true`; add the
     ExternalSecret; CronJob `envFrom: [renovate ConfigMap, renovate-settings Secret]`; remove
     `base/secret.yaml`, `params`, `secrets`, `templates.secret` and the `substituteFrom`.
     `LOG_LEVEL` stays a LibrePod default in `renovate.env`. This also fixes renovate's broken
     install.
   - **open-webui** (Helm) — question `OLLAMA_ENABLED` (`boolean`, `default: false`); add the
     ExternalSecret; HelmRelease `valuesFrom` key `OLLAMA_ENABLED` → `targetPath:
     ollama.enabled`; remove `ollama.enabled` from inline `values`; `allowCustom` only if the
     chart has an `extraEnvFrom`-style value.
5. **Docs:** the `librepod-app` skill documents the `settings` contract, the ExternalSecret +
   `envFrom`/`valuesFrom` wiring, the one-owner rule, keeping defaults in the `.env` ConfigMap,
   and that manual kubectl verification must seed `apps/<app>` in OpenBao first. Add rows to
   `docs/DECISIONS_LOG.md` for D2 (settings in OpenBao) and D7 (uninstall keeps data).

## 7. Testing

- **Server unit:** answer resolution and every validation rule, OpenBao client against
  mocked HTTP (login, token reuse, write, sealed/unreachable → `503`), OpenBao write happens
  before the Gogs commit, apps without `settings` never call OpenBao, legacy apps unchanged.
- **Client:** the dialog renders each input type, validation errors show inline, server errors
  keep the dialog open with inputs intact, apps without `settings` stay one-click.
- **Tier 1 e2e:** add an OpenBao dev-mode container; install an app with answers and a custom
  variable → assert the OpenBao entry and the Gogs files.
- **Tier 2 (k3d, real Flux):** with OpenBao + External Secrets in the bootstrap, install a pilot
  → the pod receives the answer, and a custom variable overrides a `.env` default.
- **Dev cluster:** `verify-app` on both pilots.

## 8. Risks and items to verify during implementation

- HelmRelease `valuesFrom` + `targetPath` typing: does `"false"` arrive in the chart as a
  boolean? (The open-webui pilot proves this.)
- External Secrets `dataFrom.extract` on an entry with empty data: does it produce an empty
  Secret? If not, the installer needs another way to guarantee the Secret exists.
- Pods with a non-optional Secret reference start once ESO syncs it (expected:
  `CreateContainerConfigError`, then start on retry).
- marketplace-ui Kubernetes-auth login and the ClusterSecretStore against the real OpenBao.
- OpenBao sealed → every install with settings returns `503`. Relies on auto-unseal from the
  OpenBao story.
- Older-bootstrap devices can list migrated apps and fail to install them (accepted, D9).

## 9. Rejected alternatives

- **Settings as ConfigMap/Secret files in the user-apps Gogs repo**, applied by a second per-app
  Flux Kustomization. Needed a namespace-not-found retry on first install and a status-label
  workaround, and kept secrets in git as plaintext.
- **Settings objects in `flux-system` + `postBuild.substituteFrom`.** `${VAR}` substitution
  corrupts user text (see §3), and apps would not be self-contained.
- **Only sensitive values in OpenBao, the rest in a git ConfigMap.** Two stores, and it brings
  back the namespace-ordering problem.
- **Listing every app variable in `metadata.yaml`** with an "Advanced" area. Duplicates `.env`,
  drifts, and invites users to change tuned defaults.
- **Add-only custom variables** (`.env` wins). Confusing: a user sets a variable and nothing
  happens.
- **Deleting the OpenBao entry on uninstall.** Reinstall would pair surviving NFS data with new
  values.
- **A versioned catalog stream** for old-bootstrap devices. Not needed while there are no
  crucial customer devices (D9).

## 10. Side findings (separate follow-ups)

- open-webui commits `WEBUI_ADMIN_PASSWORD: "123"` in its HelmRelease.
- On uninstall → reinstall, Gogs-generated secrets are regenerated while NFS data survives
  (e.g. an old database with a new password). D7 avoids this for settings; the Gogs-secrets
  migration story should do the same for generated secrets.
