# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The **LibrePod device owner** — a non-technical self-hoster who wants apps
running without doing sysadmin work. They open this UI over their LAN or
WireGuard tailnet to browse the catalog and install/uninstall apps on their
own device. The core LibrePod premise this serves: *"I want to self-host apps,
but I don't want to be a system administrator."*

Single-admin: one owner per device, no login on the UI itself. Not multi-user;
no accounts or per-user state.

## Product Purpose

The **marketplace installer UI/API** — the consumer-facing control plane of
LibrePod. It lets the device owner browse the app catalog and install or
uninstall apps on their cluster with one click and zero manual configuration,
with SSO baked into the installed apps.

It exists to deliver LibrePod's promise — self-hosting without being a
sysadmin — by removing every infrastructure decision (Docker, env vars,
volumes, TLS, ingress). The installer renders pre-baked templates, commits
them, and lets FluxCD reconcile; the owner never touches YAML, kubectl, or the
cluster.

**Success:** a non-technical owner can get a self-hosted app installed and
reachable, and later remove it, entirely through this UI — and never know
Kubernetes is underneath.

## Positioning

LibrePod's differentiator against neighboring self-host app stores (CasaOS,
TrueCharts, raw Helm charts): every app ships as a fully-defaulted OCI artifact
deployed via GitOps, so the user makes **zero** configuration choices and gets
SSO out of the box. This installer is the one surface where that zero-config
promise is delivered — install is a single action that commits pre-rendered
manifests and lets reconciliation do the rest. A neighbor could not truthfully
claim "one click, zero config, SSO included, no admin knowledge" without the
same baked-defaults + GitOps architecture underneath.

## Operating Context

- **Runs in-cluster** on the LibrePod device. In production the NestJS server
  (port 3000) serves both the API (`/api/*`) and the built SPA as static files;
  the client calls relative `/api/*`. The owner reaches it locally or remotely
  over the WireGuard tailnet.
- **Git is the source of truth, not a database.** "Installed" is defined
  entirely by the on-cluster private Gogs repo (`flux/user-apps` root
  `kustomization.yaml` `resources:` list). The UI reads/writes that repo; it
  does **not** run kubectl. FluxCD reconciles asynchronously.
- **The catalog is CI-generated.** `catalog.yaml` is built from
  `apps/*/metadata.yaml` upstream; the UI consumes it, never edits it.
- **Status is eventually consistent.** Install/uninstall returns once files are
  committed; Flux reconciliation (`running` / `installing` / `error`) is
  surfaced as it progresses. If Gogs is unreachable, everything shows
  `not_installed` — intentional graceful degradation.
- **Workflows:** browse *Catalog* → open app → *Install App*; or open *My Apps*
  → open app → *Uninstall App* (destructive: removes the app **and its data**).
  Action outcomes surface as toasts.
- **Installed apps** get SSO out of the box (Casdoor) and are reached via
  Traefik `IngressRoute` on the device's `BASE_DOMAIN`; non-HTTP apps are
  reached over the tailnet.

## Capabilities and Constraints

**Capabilities**

- Browse the catalog (cards show icon, name, category, description, install
  status); app detail (version, source link, description, install/uninstall
  with live status); *My Apps* (installed apps only).
- One-click install / uninstall with async status: `not_installed` →
  `installing` → `running` (or `error`). Destructive uninstall is guarded by a
  confirmation dialog.

**Constraints — product truths future work must preserve**

- **No database.** The Gogs repo is the single source of truth for install
  state.
- **Installer never runs kubectl.** It commits manifests and relies on FluxCD;
  status is reconciled, never instant.
- **All app defaults are baked into catalog templates** (sourced from
  `metadata.yaml`). The installer only does `${VAR}` substitution
  (`BASE_DOMAIN` + generated secrets). There is no user-facing app
  configuration, by design.
- **Each app is self-contained** — its own namespace and templates.
  `Infrastructure`-category (system) apps are hidden from this catalog.
- **Single-admin, no auth** on the UI itself.
- **The catalog is CI-generated;** the UI must never assume it can edit it.

**Open / undecided (explicitly not yet decided)**

- No search, filtering, or category browsing exists yet — the catalog is a flat
  grid. *[undecided]*
- No version/upgrade management is surfaced in the UI. *[undecided]*
- Multi-user / accounts are out of scope for now (single-admin assumed) but may
  evolve. *[confirmed for now]*

## Brand Commitments

- **Name:** LibrePod. The wordmark is the identity — no logo asset is committed
  (the SVGs in `src/assets/` are scaffold leftovers).
- **Tagline (in-UI):** "Self-hosted apps, one click away."
- **Navigation terms:** "Catalog", "My Apps".
- **Voice:** plain, direct, reassuring, and honest about consequences.
  Existing copy: "Install App" / "Uninstall App", "Keep App" (cancel),
  "No apps available. Check back later.", "This will remove {app} and all its
  data from your server."
- **No color, typography, or visual identity system is committed yet** — brand
  is open beyond the name and voice.

## Evidence on Hand

- **Real, in-repo:** the UI surfaces and copy
  (`packages/client/src/pages/*`, `components/AppShell.tsx`); the CI-generated
  catalog (`marketplace/catalog.yaml`); the API + Git/Gogs/Flux mechanics
  (`packages/server`, summarized in `ui/CLAUDE.md`); the broader LibrePod
  architecture (`marketplace/CLAUDE.md`, root `CLAUDE.md`).
- **Design reference:** `marketplace/docs/marketplace-for-self-hosted-apps-design.md`
  §5 — authoritative design spec, **but the code diverges from it in places;
  code is truth.**
- **Absences future work must not fabricate:** no logo or identity asset; no
  screenshots or marketing imagery; no customer testimonials, usage data,
  pricing, or licensing claims; no real photography. Brand identity beyond the
  wordmark is undecided.

## Product Principles

1. **Zero-config by default.** The owner never makes an infrastructure
   decision; every default is baked in upstream.
2. **Git is truth.** Install state is whatever the Gogs repo says; the UI
   reflects reconciled reality, never invents it.
3. **One honest action.** Install and uninstall are each a single action with
   truthful, eventually-consistent status (`running` / `installing` / `error`),
   including graceful failure when backing services are down.
4. **Self-contained apps.** Each app brings its own namespace and defaults; the
   installer only renders and commits.
5. **Calm control plane.** This is an *Operate* surface for a non-technical
   owner — clarity, trust, and reassurance outrank expression or marketing.
