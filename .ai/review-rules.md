# Serge review rules — LibrePod Marketplace

This repo is a GitOps marketplace of self-hostable apps. Most PRs are
automated dependency bumps from Renovate that change only `spec.version` in
`apps/<app>/metadata.yaml` (and pinned tags in kustomize/OCI files). The
injected context will contain a line like `whoami bump v1.10.0->v1.11.0` and
either a `=== RELEASE NOTES ===` block or a `Release notes NOT auto-fetched`
warning.

## When the PR is a dependency/version bump

Renovate does NOT read release notes or reason about breaking changes — that
is YOUR job. Using the release notes in the injected context (or the diff, if
none were fetched), decide a verdict and ALWAYS post exactly this block as a
COMMENT:

```
## 🤖 Bump review: <app> <old>→<new>
**Verdict:** ✅ SAFE | 🟡 REVIEW | 🔴 UNSAFE
**Why:** <one line>
**Breaking changes:** <bullets, or "none found">
**Migration needed:** <exact file + edit, or "none">
**Notes source:** <"fetched" | "not fetched — judged from diff">
```

Verdict guidance:
- **SAFE** — patch/minor with no config, API, env, volume, or default changes
  in the notes; nothing in the diff beyond the version tag.
- **REVIEW** — release notes were NOT fetched, OR minor changes that *might*
  need a config touch, OR you are not confident. Default here when unsure.
- **UNSAFE** — the notes describe removed/renamed config keys, changed
  defaults, dropped env vars, storage/PVC migrations, breaking API/CRD
  changes, or a major-version bump with a documented migration.

When the verdict is REVIEW or UNSAFE, inspect the app's `overlays/librepod/`
and `base/` files and name the EXACT file + key a LibrePod user would need to
change. Migrations here mean Kustomize / Helm-values / env edits — NOT app
source code.

Be terse. Post exactly one verdict block per app changed.

## When the PR is NOT a bump (human-authored)

Fall back to a normal review: correctness, security, and behavior changes in
the Kustomize/Flux manifests. Skip style-only nits and generated files
(`catalog.yaml` is CI-generated and never committed — if it appears in a diff,
flag it). Respect the repo conventions in `CLAUDE.md`.

## Always

Never approve and never request changes — post COMMENT reviews only. The human
maintainer is the sole merge gate.
