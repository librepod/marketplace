---
name: LibrePod Marketplace
description: Dark-first, monochrome Operate surface for one-click self-hosted app installs.
colors:
  background: "oklch(0.145 0 0)"
  foreground: "oklch(0.985 0 0)"
  card: "oklch(0.205 0 0)"
  card-foreground: "oklch(0.985 0 0)"
  popover: "oklch(0.205 0 0)"
  popover-foreground: "oklch(0.985 0 0)"
  primary: "oklch(0.922 0 0)"
  primary-foreground: "oklch(0.205 0 0)"
  secondary: "oklch(0.269 0 0)"
  secondary-foreground: "oklch(0.985 0 0)"
  muted: "oklch(0.269 0 0)"
  muted-foreground: "oklch(0.708 0 0)"
  accent: "oklch(0.269 0 0)"
  accent-foreground: "oklch(0.985 0 0)"
  border: "oklch(1 0 0 / 10%)"
  input: "oklch(1 0 0 / 15%)"
  ring: "oklch(0.556 0 0)"
  destructive: "oklch(0.704 0.191 22.216)"
  destructive-foreground: "oklch(0.985 0 0)"
  status-running: "#22c55e"
  status-installing: "#facc15"
  status-error: "#ef4444"
typography:
  display:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.33
  title:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  "2xl": "18px"
  "4xl": "26px"
  full: "9999px"
spacing:
  page-x: "2rem"
  card-pad: "1rem"
  panel-pad: "2rem"
  grid-gap: "1.5rem"
  section: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0.625rem"
  button-primary-hover:
    backgroundColor: "color-mix(in oklch, {colors.primary} 80%, transparent)"
  button-destructive:
    backgroundColor: "color-mix(in oklch, {colors.destructive} 10%, transparent)"
    textColor: "{colors.destructive}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0.625rem"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0.625rem"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.xl}"
    padding: "1rem"
  badge-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.4xl}"
    height: "1.25rem"
    padding: "0.5rem"
  status-badge:
    backgroundColor: "color-mix(in oklch, {colors.background} 80%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.full}"
    height: "1.25rem"
    padding: "0.5rem"
  filter-chip:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.full}"
    height: "1.5rem"
    padding: "0.25rem 0.75rem"
  filter-chip-active:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    rounded: "{rounded.full}"
    height: "1.5rem"
    padding: "0.25rem 0.75rem"
  search-input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.25rem 0.75rem"
---

# Design System: LibrePod Marketplace

## Overview

**Creative North Star: "The Honest Workbench"**

This is a workbench, not a showroom. The LibrePod Marketplace is the surface a
non-technical owner opens to install and remove apps on their own device, and
every element here earns its place by doing work — nothing is here to impress.
The result is a dark, flat, near-monochrome surface: plain surfaces, honest
verbs ("Install App", "Keep App"), and a single red that states danger plainly.
The mood is calm and restrained first, technical-but-gentle second, and honest
in its voice throughout. Restraint is the design.

Depth and color are both spendthrift here, and that is the point. Surfaces sit
flat at rest, separated by hairline rings rather than dropped shadows; a card
only lifts and casts a shadow in the moment it is being touched. Color is rarer
still: the entire neutral palette is pure achromatic grayscale, and saturated
color appears in exactly two roles — a muted red for danger, and the
green/yellow/red dots that report whether an app is running, installing, or
erroring. When color does appear, it is a signal the owner must read, never
decoration.

The product ships dark (decision D-02 forces the `.dark` class before mount to
avoid a flash), so the dark tokens below are the operational defaults; the
light-mode tokens exist in the theme but are vestigial — new work must look
right in dark first. Density is compact and app-tight (14px body, 32px default
button height, a 280px-min card grid): this is a tool the owner uses, read at a
glance, not a page they browse.

**Key Characteristics:**
- Dark-first, near-monochrome Operate surface; light mode is vestigial.
- Pure achromatic neutrals; saturated color reserved for danger + live status only.
- Flat at rest; rings, shadows, and lift appear only as a response to state.
- Single typeface (Geist); weight and size carry hierarchy, not a second face.
- Compact, honest controls; plain verbs; one red for consequence.

## Colors

The palette is a disciplined grayscale canvas punctuated by semantic color —
neutral everywhere, with red for danger and traffic-light dots for status.

### Primary
- **Workbench White** (`oklch(0.922 0 0)`): The inverted primary — a near-white
  fill with dark text. Used for the primary call to action ("Install App") and
  the active state of a filter chip, where maximum contrast against the dark
  canvas is the whole point. In dark mode the primary button reads as a light
  switch: the brightest object on the screen.

### Secondary / Tertiary (omitted)
The project has a single accent expressed through the primary above. There is no
committed secondary or tertiary brand hue — do not invent one.

### Neutral
- **Bare Workbench** (`oklch(0.145 0 0)`): Page `--background`. The near-black
  canvas everything sits on.
- **Raised Surface** (`oklch(0.205 0 0)`): `--card` and `--popover`. The one step
  up from the canvas used for cards, the detail panel, popovers, and dialogs.
- **Trough** (`oklch(0.269 0 0)`): `--secondary`, `--accent`, and `--muted` all
  share this value — the secondary surface tier for muted footers, hover washes,
  and secondary badges.
- **Ink** (`oklch(0.985 0 0)`): `--foreground`. Near-white primary text.
- **Quiet Ink** (`oklch(0.708 0 0)`): `--muted-foreground`. Secondary text,
  inactive nav, meta, and descriptions.
- **Hairline** (`oklch(1 0 0 / 10%)`): `--border`. White at 10% — the only divider.
- **Input Hairline** (`oklch(1 0 0 / 15%)`): `--input`. Slightly stronger than
  border, reserved for field edges.
- **Ring** (`oklch(0.556 0 0)`): `--ring`. Mid-gray used for focus rings.

### Semantic (the only saturated color)
- **Plain Danger** (`oklch(0.704 0.191 22.216)`): `--destructive`. A muted,
  honest red — used for destructive buttons and the error state. Never bright,
  never decorative.
- **Danger Ink** (`oklch(0.985 0 0)`): `--destructive-foreground`. Near-white text
  on the solid-red uninstall action. It is defined in the theme, so the
  destructive *button* variant (a soft tint) and the uninstall dialog's *action*
  (solid) are two intentional treatments of the same red: the tint whispers the
  available danger; the solid confirms the committed one.
- **Running** (`#22c55e`), **Installing** (`#facc15`), **Error** (`#ef4444`): the
  status-dot triplet. Tailwind's green-500 / yellow-400 / red-500, used only as
  the small 8px dot inside `StatusBadge`. These are the sole saturated hues the
  owner sees, and each one means a specific operational state.

### Named Rules
**The Signal-Only Rule.** Neutral surfaces are pure achromatic (`oklch` chroma
`0`). Saturated color appears in exactly two roles: `destructive` for danger or
removal, and the status dots for live reconciliation state. Color is never used
for branding, accent, or decoration. If a new surface wants color, ask what
signal it carries — if none, it stays gray.

**The Dark-First Rule.** Design and evaluate every surface in dark mode first;
the light tokens are vestigial and the product ships dark (D-02). A screen that
only works in light is not done.

## Typography

**Display / Body / Label Font:** Geist Variable (`@fontsource-variable/geist`),
with a `system-ui, sans-serif` fallback. `--font-sans` and `--font-heading` are
both Geist, so headings and body share one face.

**Character:** A single neutral grotesque — quiet, legible, and unfussy. Geist's
evenness lets weight and size do all the hierarchical work, which is exactly the
workbench temperament: no display flourish, no decorative pairing.

> Note: `main.tsx` imports `@fontsource/inter`, but Inter is never assigned to a
> theme token and is not the rendered face. Treat Inter as an orphan import; the
> committed typeface is Geist alone.

### Hierarchy
- **Display** (Geist, 600, `1.875rem` / 30px, line-height 1.2, tracking
  `-0.025em`): The app-detail page title. The largest type in the product; set
  with `tracking-tight` so a long app name holds its line.
- **Headline** (Geist, 600, `1.5rem` / 24px, line-height 1.33): The LibrePod
  wordmark in the header — the identity, one step down from the detail title.
- **Title** (Geist, 600, `1.25rem` / 20px, line-height 1.3): Catalog card titles
  (`text-xl font-semibold`) and the centered section headings on the empty /
  error / no-match / not-found surfaces — one weight and size for every
  secondary heading.
- **Body** (Geist, 400, `0.875rem` / 14px, line-height 1.625): The workhorse —
  descriptions, nav, button labels, meta, dialog body. Set `leading-relaxed`
  (1.625) for running description text.
- **Label** (Geist, 500, `0.75rem` / 12px): Badges, status labels, filter chips,
  and the smallest meta. Uppercase is not used.

The three heading steps (30 / 24 / 20) are deliberately spaced so the detail
title outranks the wordmark outranks a card title — each is perceptibly larger
than the one below it, and the whole ladder rests on the 14px body.

### Named Rules
**The One-Face Rule.** One typeface (Geist) for everything. Hierarchy comes from
size and weight alone — never from introducing a second family, a display serif,
or a monospace accent. If two pieces of text must be distinguished, change their
size or weight, not their face.

## Layout

A single centered column with a fixed page gutter and a self-filling card grid.

- **Container:** `mx-auto max-w-screen-xl px-6 md:px-8` — capped at 1280px with a
  24px (`1.5rem`) horizontal gutter on small screens that opens to 32px (`2rem`)
  from the `md` breakpoint up. Everything lives inside this rail.
- **Header rhythm:** `pt-8 pb-6` (32px top, 24px bottom); nav sits `mt-5` with
  `gap-6` (24px) between links; a `Separator` sits `mb-6`; the main region gets
  `pb-12`.
- **Catalog / My Apps grid:** `display: grid; grid-template-columns:
  repeat(auto-fill, minmax(280px, 1fr)); gap: 24px`. Cards are never narrower
  than 280px and fill the row; the grid is the only responsive mechanism and it
  has a single behavior (auto-fill).
- **App detail:** a centered `max-w-2xl` panel with `p-6 md:p-8` internal padding.
- **Card internals:** `p-4` (16px); vertical rhythm via `mt-2/3/4` steps.
- **Density:** compact by design — 14px body, 32px default controls, 24px grid
  gaps. This is a control surface read at a glance.
- **Navigation:** top-nav only (`Catalog`, `My Apps` as `NavLink`s). The theme
  defines `sidebar-*` tokens, but there is no sidebar in this product — treat
  those tokens (and the `chart-*` tokens) as unused scaffold, not an invitation
  to build a sidebar dashboard or charts.

## Elevation & Depth

This system is flat by default. Depth is a response to state, never a resting
property. At rest, surfaces are separated by hairline rings and dividers; shadows
appear only in the instant a surface is being interacted with or elevated.

- Cards and dialogs wear a **1px ring at 10% foreground opacity**
  (`ring-1 ring-foreground/10`) at rest — a hairline edge, not a border and not a
  shadow.
- The catalog card is the only place a real shadow appears: on hover it gains
  `shadow-md` together with a 2px lift (`hover:-translate-y-0.5`), over a
  `transition-all duration-150`.
- `StatusBadge` carries a faint `shadow-sm` so the floating status pill reads as
  sitting just above the card.
- Buttons stay flat; their depth cue is a 1px press (`active:translate-y-px`) and
  a focus ring (`focus-visible:ring-3 ring-ring/70`).
- The dialog scrim is `bg-black/10` with `backdrop-blur-xs` — the only use of
  blur in the product, and only to dim the page behind a modal.

### Shadow Vocabulary
- **Hover-lift** (`box-shadow` Tailwind `shadow-md`, paired with
  `translate-y: -0.125rem`): the catalog card on hover. Use only for a clickable
  surface the user is actively engaging.
- **Status float** (`shadow-sm`): the floating `StatusBadge` pill.

### Named Rules
**The Depth-Is-State Rule.** Surfaces are flat at rest. Rings, shadows, and
lift may appear only as a response to state — hover, press, focus, or modal
elevation. A resting shadow is a bug.

**The Visible-Focus Rule.** Every interactive surface shows a `ring-ring` focus
ring on keyboard focus (`:focus-visible`) — catalog cards (`ring-2`), buttons and
badges (`ring-3`), the search field, the clear-search button, and the filter
chips (`ring-2`). Color and underline never carry the focus signal alone; the
ring is the signal, and it is present on every focusable element.

## Shapes

Modest, honest corners. The base radius is `--radius: 0.625rem` (10px), with a
multiplier scale (`sm` 6px, `md` 8px, `lg` 10px, `xl` 14px, `2xl` 18px, `3xl`
22px, `4xl` 26px). In practice the product uses a narrow band of that scale:

- **Surfaces** use soft rectangles, not pills: cards, the detail panel, and
  dialogs `rounded-xl` (14px); buttons `rounded-lg` (10px); icons and skeletons
  `rounded-md` (8px).
- **Tags and status** go fully round: the category `Badge` is `rounded-4xl`
  (26px — effectively a pill), filter chips and `StatusBadge` are `rounded-full`.

### Named Rules
**The Honest-Corner Rule.** Modest radii (8–14px) for working surfaces; reserve
the fully-rounded pill (`rounded-4xl` / `rounded-full`) for tags, filter chips,
and status — small, secondary labels that need to read as discrete chips, not
containers.

## Components

### Buttons
Compact, confident tools. `rounded-lg` (10px), `text-sm font-medium`, default
height `h-8` (32px) with `gap-1.5` and `px-2.5`; sizes run `xs` (24px) → `lg`
(36px). Focus ring `focus-visible:ring-3 ring-ring/70`; press feedback
`active:translate-y-px`. Any `<svg>` child without an explicit size class is
auto-sized to `size-4` (16px) by the button's base styles, so icons sit at a
consistent 16px without per-call sizing.
- **Primary:** `bg-primary text-primary-foreground` — the inverted near-white
  CTA. Use for the single forward action on a screen ("Install App"). The
  running-state **Open** button is this variant rendered as an anchor
  (`render={<a href target="_blank">}`) linking to `https://{name}.{BASE_DOMAIN}`,
  with an `ExternalLink` icon and an sr-only "opens in a new tab" note.
- **Outline:** `border-border bg-background`, washes to `bg-muted` on
  hover/expanded. The secondary/cancel/recovery control ("Try again", "Clear
  filters", "Keep App").
- **Secondary / Ghost:** muted-background tints for low-emphasis actions.
- **Destructive:** a **soft tint** — `bg-destructive/10 text-destructive`,
  deepening to `/20` on hover (and `/20 → /30` in dark). The uninstall
  *trigger*. Danger that whispers, not shouts.
- **Link:** `text-primary underline-offset-4 hover:underline`.

> Two treatments of one red (intentional): the destructive *button* variant is a
> soft tint; the uninstall dialog's **action** is a solid red
> (`bg-destructive text-destructive-foreground`). `--destructive-foreground`
> (`oklch(0.985 0 0)`, near-white) is defined, so the solid action's text is
> correct. The tint signals available danger; the solid confirms the committed
> one.

### Badges
Small pill labels. `rounded-4xl` (26px), `h-5`, `text-xs font-medium`, `px-2`.
The **secondary** variant (`bg-secondary text-secondary-foreground`) carries the
app category on every card and the detail page. Variants mirror the button set
(primary, secondary, destructive-tint, outline, ghost, link).

### StatusBadge (signature component)
The one place operational color enters the UI. A `rounded-full` pill
(`bg-background/80`, `shadow-sm`, `text-xs`, `role="status"`) containing an 8px
(`h-2 w-2`) `rounded-full` dot whose color is the signal: **Running** → green-500,
**Installing** → yellow-400, **Error** → red-500. It floats top-right on a card
and inline on the detail page. Everything else around it stays gray so the dot
can do its job.

### Cards / AppCard
The catalog unit, and a real `<Link>` (keyboard-operable: focusable, Enter
activates, announced as a link). `rounded-xl` (14px), `bg-card`, `text-sm`,
separated from the canvas by `ring-1 ring-foreground/10` (a hairline ring, not a
border). Internal padding `p-4`. The clickable `AppCard` adds
`hover:-translate-y-0.5 hover:shadow-md` over `transition-all duration-150` — the
lift is the affordance — and `focus-visible:ring-2 ring-ring/70`. Layout: 48px
`AppIcon`, then title (`text-xl font-semibold leading-tight`) beside a secondary
category `Badge`, then a two-line description (`line-clamp-2`) in
`text-muted-foreground`. When installed, a `StatusBadge` floats top-right.

### AppIcon
`rounded-md` (8px), `object-contain`, fixed at 48px (card) or 80px (detail); the
`<img>` carries `alt={name}`. On image error it falls back to a neutral tile
(`rounded-md bg-muted text-muted-foreground`, the app's initial) — on-system
grayscale, not a foreign slate.

### CatalogToolbar (filtering)
The catalog's filter surface, rendered above the grid only when data is present.
`mb-6 flex-col gap-3`. It carries two controls, both single-purpose:
- **Search field:** the one text input in the product. `h-9`, `rounded-md`,
  `border-input`, a leading `Search` icon (`pl-9`), and a trailing clear-`X`
  button (`pr-9`) that appears only when there is a query. `type="text"` (not
  `search`) so the app owns the clear affordance and avoids WebKit's native
  button. Typing updates the `q` URL param with `replace` (no per-keystroke
  history entries).
- **Category chips:** single-select pills (`role="group"`) led by an **All** chip.
  See Filter chips below. Selecting a category updates the `category` URL param
  with `push` (shareable, back-button-friendly). Filtering is a pure client-side
  view over the cached catalog.

### Filter chips
The category selector — `rounded-full border px-3 py-1 text-xs font-medium`,
`aria-pressed` for state. **Active** = `border-transparent bg-foreground
text-background` (it mirrors the primary button — the selected filter is the
brightest object in the row). **Inactive** = `border-border text-muted-foreground`
with `hover:border-foreground/30 hover:text-foreground`. Both states carry the
system focus ring (`focus-visible:ring-2 ring-ring/70`).

### App detail action row
`mt-8 flex flex-wrap items-center gap-3`. The single forward action is decided by
`installedStatus`: `not_installed` → primary **Install App**; `installing` →
disabled **Installing…** with a spinner; `running` → primary **Open {app}**
(anchor) + destructive **Uninstall App** (trigger); `error` → destructive
**Uninstall App**. Above the row, a **View project** link (`text-sm underline
text-muted-foreground`, `ExternalLink` at `size-3`) appears only when the app's
`sourceUrl` is an `https?://` URL — `oci://` sources hide it.

### AlertDialog
The destructive-uninstall confirmation. Centered (`fixed top-1/2 left-1/2`),
`rounded-xl`, `bg-popover`, `ring-1 ring-foreground/10`, `p-4`, `max-w-xs` (→
`sm:max-w-sm`). Opens with a 100ms `fade-in-0 zoom-in-95`; the scrim is
`bg-black/10 backdrop-blur-xs`. Header is centered; the footer is a
`bg-muted/50` bar with a `border-top` holding a `Keep App` outline cancel and the
solid-red `Uninstall App` action (see the two-treatments note under Buttons).

### Skeleton
`animate-pulse rounded-md bg-muted`. The catalog **AppCardSkeleton** mirrors the
real card exactly — `rounded-xl bg-card p-4 ring-1 ring-foreground/10` at a fixed
200px height — so loading→loaded is calm. The detail **DetailSkeleton** mirrors
the resolved panel (same `rounded-xl` + ring + `p-6 md:p-8`), and uses a real
static `Separator` for its divider so that line does not pulse while the
placeholders do.

### Separator
`bg-border`, horizontal `h-px`. The divider under the header, around detail
sections, and (static) inside the detail skeleton.

### Empty / Error / No-match / Not-found states
A single quiet family. All share `mt-12 flex flex-col items-center gap-3
text-center`, a `text-xl font-semibold` heading (the Title step), and a
`text-sm text-muted-foreground` line. Errors lead with a `text-destructive`
`AlertCircle` and an outline **Try again**. Copy is honest and plain, and names
the recovery:
- **Error** (`ErrorBlock`): "Couldn't reach your device" — *We couldn't reach
  your device to load this. Check that it's online, then try again.* — **Try again**.
- **Empty catalog** (`EmptyState`): "No apps available" — *We couldn't find any
  apps to install. If this is unexpected, your device may be offline.* — **Try again**.
- **No filter matches** (`NoMatchesState`): "No apps found" — names the active
  query or category — **Clear filters**.
- **My Apps empty**: "No apps installed yet" — *Browse the Catalog to install
  apps.* (Catalog is an in-app link).
- **Not found** (`NotFoundPage`): "App not found" / "Page not found" — *This app
  doesn't exist in the catalog.* — a **← Back to catalog** link.

## Do's and Don'ts

### Do:
- **Do** design and evaluate every surface in **dark mode first** — the product
  ships dark (D-02); light tokens are vestigial.
- **Do** keep neutral surfaces pure achromatic; let **saturated color carry a
  signal only** (destructive danger, or a status dot). See The Signal-Only Rule.
- **Do** keep surfaces **flat at rest**; introduce rings, shadows, and lift only
  as a response to hover, press, focus, or modal elevation. See The
  Depth-Is-State Rule.
- **Do** give **every interactive surface a visible focus ring** on keyboard
  focus — cards, buttons, the search field, the clear button, and filter chips.
  See The Visible-Focus Rule.
- **Do** build hierarchy with **size and weight within the single Geist face**,
  not a second typeface. See The One-Face Rule.
- **Do** use **modest radii (8–14px)** for working surfaces and reserve the full
  pill for tags, filter chips, and status. See The Honest-Corner Rule.
- **Do** write **plain, honest verbs** that state consequence ("Install App",
  "Uninstall App", "Keep App", "Try again") — the copy is part of the design.
- **Do** keep the catalog's empty / error / no-match / not-found surfaces on one
  shared rhythm (`mt-12 flex-col gap-3`, Title heading, muted body, one
  recovery control) so the "nothing to show" moments read as one family.

### Don't:
- **Don't** apply saturated brand or decorative color to general UI surfaces.
  Color is a signal medium, not an accent.
- **Don't** use gradients, glassmorphism, or decorative blur. The only blur in
  the product is the dialog scrim (`backdrop-blur-xs` behind `bg-black/10`).
- **Don't** design light-mode-first, or assume a light canvas. Evaluate in dark
  before anything else.
- **Don't** introduce a second typeface, a display serif, or a monospace accent
  to "add personality" — restraint is the personality.
- **Don't** let an interactive element rely on color or underline alone to show
  focus — the `ring-ring` focus ring is required everywhere.
