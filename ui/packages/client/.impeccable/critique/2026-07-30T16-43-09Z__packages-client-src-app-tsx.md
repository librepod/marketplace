---
target: packages/client/src/App.tsx
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-07-30T16-43-09Z
slug: packages-client-src-app-tsx
---
# LibrePod Marketplace — Design Critique

> Method: dual-agent (A: holistic design review · B: detector + browser scan). No live browser overlay — no browser automation available this session; deterministic detector scan completed. Source-level + token-level review.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | No query polls; page on `installing` never advances without refocus; success toast titled "Installed" while still deploying |
| 2 | Match System / Real World | 3 | "View source" links to `oci://`/`git://` — developer jargon to the non-technical owner |
| 3 | User Control and Freedom | 3 | Back link hardcoded `to="/"` — My Apps→detail→back dumps on Catalog; no undo for data deletion |
| 4 | Consistency and Standards | 3 | `AppCard` is a clickable `<div>`; uninstall trigger nests `<Button>` in `<AlertDialogTrigger>`; skeleton `rounded-lg` ≠ card `rounded-xl` |
| 5 | Error Prevention | 2 | No catch-all 404 route; misleading "check your connection" copy misdiagnoses a device-side failure |
| 6 | Recognition Rather Than Recall | 3 | No search/filter/category grouping — finding a known app is pure scanning |
| 7 | Flexibility and Efficiency | 2 | Catalog is mouse-only — cards not focusable; no search/shortcuts/batch |
| 8 | Aesthetic and Minimalist Design | 4 | Signal-only color and flat surfaces honored in code; detector confirms live surface mechanically clean |
| 9 | Error Recovery | 2 | Error states blame the connection and offer only "Uninstall" — no diagnosis/retry/guidance |
| 10 | Help and Documentation | 1 | Zero in-app help/tooltips/onboarding for an explicitly non-technical audience |
| **Total** | | **25 / 40** | **Acceptable** — solid foundation, significant friction for the target owner |

## Design Specificity Verdict

Verdict: Disciplined but not yet distinctive. The rules are specific to LibrePod; the rendered surface is category-interchangeable.

The system is authored for this product ("The Honest Workbench," Signal-Only, Depth-Is-State, One-Face Geist, Honest-Corner) and obeys its tokens (chroma-0 neutrals; saturated color only in `--destructive` and status dots; flat `ring-1 ring-foreground/10`). But the result reads as a generic dark app store (CasaOS/TrueNAS/Nextcloud/shadcn dark admin) — not LibrePod. Reasons: (1) no committed visual identity, wordmark is plain text; (2) nothing device-specific in the chrome (no device name, online chip, reconciliation timestamp) despite driving one physical device; (3) signature `StatusBadge` uses generic traffic-light dots. Character lives in DESIGN.md, not the pixels; honest copy is the one authorship signal.

Deterministic scan: 4 advisory findings, all in `design-system-font-size` (3) and `design-system-radius` (1). 3 of 4 in dead scaffold (`App.tsx`/`App.css`, unmounted — `main.tsx` loads `./router`). 1 real: `button.tsx:26` `text-[0.8rem]` on `sm` button. Every live component passed clean — positive signal that tokens are obeyed. No browser overlay (no automation available).

## Cognitive Load

Checklist: fails **grouping** (flat grid, no category grouping despite a `category` field) and the **unbounded card-list choice** (no search/filter/sort — the catalog is an unstructured >4-option scan that worsens as it grows). Other 6 pass. Biggest load risk: the unfiltered catalog as it grows.

## Emotional Journey

Journey A (browse→install→running): peak toast "Installed" is dishonest (app still deploying); the wait (yellow dot, no progress/ETA/reassurance) is a valley with no companion and no polling; the true peak (app goes live) is silent and unreachable — no "Open app," no way to reach the app. The emotional high point of the product is a non-event.

Journey B (My Apps→uninstall): the confirm dialog is the best moment — names the specific app and states consequence plainly; reassurance present at the stake. Solid-red action relies on undefined `--destructive-foreground` (white by inheritance). Single-click confirm for irreversible data loss is slightly light for a non-technical owner (no type-the-name gate).

Peak-end: negative peak (install error/wait) unhandled; positive peak (app goes live) missing; uninstall confirm well-handled.

## What's Working

1. Destructive-uninstall copy interpolates the actual app name and states consequence plainly — the product voice principle delivered at the highest-stakes moment.
2. Signal-Only color honored in code (chroma-0 neutrals; saturation only in destructive + status dots) — restraint that creates the promised calm; detector confirms the live surface is clean.
3. State coverage complete and tonally consistent (loading/empty/error/not-found/async) in the same muted composition — loading→loaded is calm.

## Priority Issues

[P0] No "Open app" — promise stops at "running". Why: PRODUCT.md success = "installed and reachable"; `BASE_DOMAIN` referenced nowhere in client; no launch action on a running app; also the missing positive peak. Fix: primary "Open {app}" to `https://{name}.{BASE_DOMAIN}` (tailnet for non-HTTP) when running; demote Uninstall. Command: /impeccable clarify.

[P0] Catalog mouse-only; nested buttons. Why: `AppCard.tsx:12` `<Card onClick>` no role/tabindex/keydown — keyboard/SR users can't browse; `AppDetailPage.tsx:144-156` nests `<Button>` in `<AlertDialogTrigger>` without render — invalid DOM. Fix: card as router `<Link>` (or role=button+tabIndex+Enter/Space) with focus-visible ring; trigger via `render={<Button variant="destructive">…</Button>}`. Command: /impeccable harden.

[P1] Async status stale; peak toast dishonest. Why: no `refetchInterval` — `installing` won't advance without refocus; "Installed" toast fires while still deploying. Fix: poll `["apps",name]` while installing; retitle toast "Install started / being deployed", reserve "Installed" for running. Command: /impeccable animate.

[P1] Error states dishonest + dead ends. Why: "Check your connection" misdiagnoses a device-side failure; `error` status offers only Uninstall; error toast persists with no action. Fix: device-honest copy; add Retry install + plain-language diagnosis; toast retry action. Command: /impeccable clarify.

[P2] Findability + icon fragility. Why: flat grid, no search/filter/grouping (cognitive-load failures); icons are remote URLs with some `icon: ""`, failing over LAN/tailnet to a cool `slate` fallback (the one neutral-theme breach). Fix: category filter/search; bundle/serve icons locally; warm-neutral fallback. Command: /impeccable distill.

## Persona Red Flags

Sam (accessibility): cannot browse by keyboard (Tab skips the catalog); nested buttons invalid DOM; faint `--ring` (`oklch(0.556 0 0)` @50% on near-black); icon fallback swaps `<img alt>` for unlabelled `<div>`.

Jordan (non-technical first-timer — the target): goal unreachable (no Open app); toast "Installed" vs page "Installing…"; "View source" is `oci://` jargon; device-down error blames the connection; empty catalog says "Check back later" with no explanation.

Alex (power user): no status polling; back link hardcoded to `/` (My-Apps→detail→back lands on Catalog); no raw-state view (no logs/Flux condition for `error`); no batch/version management.

## Minor Observations

- Dead scaffold ships: `App.tsx`/`App.css` (unmounted Vite template) + orphan `import "@fontsource/inter"` in `main.tsx` (DESIGN.md flags). 3 of 4 detector findings live here; biggest cleanup.
- `sonner.tsx` reads `next-themes` `useTheme()` ("system", no ThemeProvider) — toasts may render light inside forced-dark app.
- Skeleton mismatch: `AppCardSkeleton` `rounded-lg` + fixed 200px vs real `rounded-xl` variable-height card — loading→loaded pop.
- Two different empty states: `CatalogPage` uses `<EmptyState/>`; `MyAppsPage` inlines its own.
- `--destructive-foreground` referenced but undefined — solid-red action white by inheritance.
- AppShell nav active state (`text-foreground` vs `text-muted-foreground`) near-invisible.
- `MyAppsPage` empty-state uses raw `<a href="/">` — full reload, not router `<Link>`.
- `button.tsx:26` `text-[0.8rem]` on `sm` button — off type ramp; snap to `text-xs`/`text-sm`.
- Good: `StatusBadge` dots not color-only (label present) — accessible.

## Questions to Consider

1. If success is "installed and reachable," why does the UI end at "running"? Is "Open {app}" the primary post-install action?
2. This is a control plane for one specific device — where is the device? Would a "Your device · online · reconciled 2m ago" chip make it read as a control plane?
3. Over a LAN/tailnet where image CDNs may be unreachable, what is the "calm workbench" when icons silently become gray tiles? Should icons be a locally-served, offline-reliable primitive?
