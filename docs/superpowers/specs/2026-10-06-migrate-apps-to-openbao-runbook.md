# Post-merge runbook — migrate apps to OpenBao settings

> Plan: `docs/superpowers/plans/2026-10-06-migrate-apps-to-openbao.md` · Spec:
> `docs/superpowers/specs/2026-10-04-app-install-settings-design.md` · Task 22 scope per
> controller Ruling 17 (steps that need a merged/deployed world live here, not in-branch).
> Abstract env names only (`dev`, `prod`) per repo hygiene.

## 1. Merge order gate

- **PR 1 = Wave 0 + Wave 0.5** (plan Tasks 1–6, ending with the marketplace-ui **0.8.0**
  release) must merge **and deploy** (image published + `infrastructure/system-apps/marketplace-ui.yaml`
  `ref.tag: 0.8.0` landed on clusters) **before any app-wave PR merges**.
- Single-PR fallback (all waves in one PR) is accepted per Ruling 1: between catalog arrival
  (~5 min after merge) and the 0.8.0 rollout, an old marketplace-ui could install a migrated
  app and write no settings value. Window is brief and **self-healing** — see §4 — with one
  corner: a FRESH install of a generated-only app by a pre-0.8.0 UI writes an empty entry that
  the mirror cannot fill (fresh installs commit no secret.yaml), so its pods wait until a 0.8.0
  reinstall, not until the next mirror tick.
- The 0.8.0 features that make app waves safe: `generate` resolution, read-merge install,
  legacy Gogs secret mirror (DECISIONS_LOG rows 9–12).

## 2. Immediately after merge — artifacts

- **publish-apps ran for every touched app.** It diffs `HEAD~1` only, so a multi-commit push
  can be missed (memory: publish-apps multi-commit blind spot):

  ```bash
  gh run list --workflow=publish-apps.yaml --limit 30
  # missing app? force it:
  gh workflow run publish-apps.yaml -f apps=<name>
  ```

- **marketplace-ui 0.8.0 image published** (`gh run list --workflow=publish-marketplace-ui.yaml`)
  and the `system-apps` pin matches. Catalog CI (`publish-catalog.yaml`) regenerates from the
  migrated `metadata.yaml` — no manual step.
- **After the app-wave PR merges: the 0.8.0 image must be REPUBLISHED.** The PR-1 image is
  interim — it predates the ui fixes that ride the app-wave PR (client write path
  `<mount>/<app>`, one-click predicate). Its flaws are inert while PR 1 is alone on master (no
  catalog app has settings yet), but the final image must carry them. The workflow triggers on
  `ui/**` pushes to master and tags from `ui/package.json` (still 0.8.0), so the merge
  republishes automatically — verify it ran and the tag digest moved:
  `gh run list --workflow=publish-marketplace-ui.yaml --limit 3`; if missed,
  `gh workflow run publish-marketplace-ui.yaml`.
- Verify each republished tag carries the ExternalSecret: `flux pull artifact
  oci://ghcr.io/librepod/marketplace/apps/<name> --tag <pinned tag> -o /tmp/a && ls /tmp/a` shows
  `externalsecret.yaml` in the app base. (Stale-digest cache → `flux reconcile source oci <name>
  -n flux-system`, memory: stale OCI artifacts.)

## 3. Dev cluster (before prod)

1. **Resume the suspended `openbao` Kustomization AFTER artifacts republish** — the
   direct-applied policy/state on dev currently diverges from the branch (memory:
   project_openbao-sso-dev-cluster-state; parent/child suspend note). Resuming early would
   revert live policies to the pre-`read`-grant shape.
2. **Confirm marketplace-ui 0.8.0 rolled out.** The mirror logs at boot
   (`legacy secret mirror` entries in the pod log) — its presence is the 0.8.0 tell.
3. **Mirror drill** (plan Task 22 Step 3, simulates a pre-migration straggler):
   - Commit a legacy `apps/<any>/secret.yaml` into the dev user-apps Gogs repo (git as `flux`).
   - Restart the marketplace-ui pod (or wait ≤1 h for the hourly tick).
   - Assert the OpenBao entry appeared with those values
     (`bao kv get apps/<any>` / HTTP `/v1/apps/data/<any>` — natural key, no inner `apps/`
     segment; `-mount=apps apps/<any>` would double it).
   - Delete the file from the repo again (uninstall bridge also covers it, but leave dev clean).
4. **UI-path verification of the two wiring shapes** (merge-checklist item 3):
   - **renovate** (user-supplied token): uninstall → reinstall **through the install dialog**;
     assert the OpenBao entry `apps/renovate` carries the token and the pod is Running.
   - **vaultwarden** (generated-only): reinstall; the dialog opens with **no questions** (only
     the custom-env section — Ruling 15 keeps generated-only apps question-free), confirm
     Install; assert `apps/vaultwarden` has a 64-char `ADMIN_TOKEN` and the pod is Running.
   - Reinstall (not fresh install) is the point: read-merge must reuse, not regenerate (row 11).

## 4. Fleet rollout (per app wave)

- After each app artifact lands on a device, watch:

  ```bash
  kubectl get externalsecret -A          # every migrated app: Ready=True
  kubectl get pods -A | grep -v Running  # brief CreateContainerConfigError windows are expected
  ```

- **Brief `CreateContainerConfigError` windows are expected and self-heal**: the ExternalSecret
  arrives with the artifact before/while the mirror seeds the OpenBao entry; the next mirror
  tick (boot/hourly/uninstall) fills it and ESO syncs. Values never change under living data
  (plan's Rollout safety summary).
- **immich on prod** (Helm-wired, high-risk class): the entry is seeded from the live
  legacy values by the mirror. Before pods restart, verify byte-equality of the synced Secret's
  env against the old values (paranoid check: `kubectl diff` of the new `immich-settings` Secret
  vs the pre-migration secret env, or read both and compare). The `converge-db-password`
  container is the backstop, not the plan (same for litellm, remnawave; seafile and
  obsidian-livesync have NO converge — their preservation paths are the only protection).
- Prod per-device confirmation (plan Task 22 Step 4): marketplace-ui 0.8.0 deployed (system-apps
  pin), `openbao` policy grants `read` to `marketplace-ui`, installed instances reconcile with
  `ExternalSecret Ready=True` and pods stable.

## 5. CI coverage after merge

- **Tier 1 (browser, hermetic)** is the **required gate** for the fixture work
  (`.github/workflows/ui-e2e.yaml`, PRs touching `ui/**`): renovate fixture now carries a
  generated item (`E2E_FIXTURE_CACHE_KEY`) — dialog hides it, OpenBao entry holds 32-hex.
- **Tier 2 (k3d, advisory nightly + master push)** (`.github/workflows/ui-e2e-cluster.yaml`):
  the reconcile-lifecycle install spec now answers required dialog questions and asserts
  `<app>-settings` ExternalSecret Ready at Running (advisory: skipped while the pinned artifact
  predates the migration).
- **Recorded gap: server vitest suites run NOWHERE in CI** (`npm test` /
  `test:e2e` server configs have no workflow). Resolver/mirror regressions are caught only
  locally — file a CI job as follow-up.

## 6. Residual risks (accepted)

- **Older-bootstrap devices** (pre-openbao): list migrated apps fine but settings installs
  fail (503 / no OpenBao). Accepted, spec D9. The Gogs mirror stays as a safety net; deletable
  once no cluster runs a pre-0.8.0 marketplace-ui against a migrated catalog (row 12).
- **happy-server overlay placeholders** (`HANDY_MASTER_SECRET=change-me`, postgres password,
  S3 keys shipped in-git) — declared secrets were dead and removed in Task 13; the overlay
  `.env` hygiene issue is a separate LIVE-branch follow-up.
- **No server-suite CI job** (see §5).
