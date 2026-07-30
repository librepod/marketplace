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
  status-running: "#22c55e"
  status-installing: "#facc15"
  status-error: "#ef4444"
typography:
  display:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.2
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
  fill with dark text. Used only for the primary call to action ("Install App"),
  where maximum contrast against the dark canvas is the whole point. In dark mode
  the primary button reads as a light switch: the brightest object on the screen.

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
- **Display** (Geist, 600, `1.75rem` / 28px, line-height 1.2): The wordmark
  ("LibrePod") and the app-detail page title. The largest type in the product.
- **Title** (Geist, 600, `1.25rem` / 20px, line-height ~1.3): Catalog card titles
  (`text-xl font-semibold`). The `CardTitle` primitive is a smaller variant at
  `1rem` / 16px, 500, set in `font-heading`.
- **Body** (Geist, 400, `0.875rem` / 14px, line-height 1.625): The workhorse —
  descriptions, nav, button labels, meta, dialog body. Set `leading-relaxed`
  (1.625) for running description text.
- **Label** (Geist, 500, `0.75rem` / 12px): Badges, status labels, and the
  smallest meta. Uppercase is not used.

### Named Rules
**The One-Face Rule.** One typeface (Geist) for everything. Hierarchy comes from
size and weight alone — never from introducing a second family, a display serif,
or a monospace accent. If two pieces of text must be distinguished, change their
size or weight, not their face.

## Layout

A single centered column with a fixed page gutter and a self-filling card grid.

- **Container:** `mx-auto max-w-screen-xl px-8` — capped at 1280px with a 32px
  (`2rem`) horizontal gutter. Everything lives inside this rail.
- **Header rhythm:** `pt-10 pb-6` (40px top, 24px bottom); nav sits `mt-5` with
  `gap-6` (24px) between links; a `Separator` sits `mb-6`; the main region gets
  `pb-12`.
- **Catalog / My Apps grid:** `display: grid; grid-template-columns:
  repeat(auto-fill, minmax(280px, 1fr)); gap: 24px`. Cards are never narrower
  than 280px and fill the row; the grid is the only responsive mechanism and it
  has a single behavior (auto-fill).
- **App detail:** a centered `max-w-2xl` panel with `p-8` (32px) internal padding.
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
  a focus ring (`focus-visible:ring-3 ring-ring/50`).
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

## Shapes

Modest, honest corners. The base radius is `--radius: 0.625rem` (10px), with a
multiplier scale (`sm` 6px, `md` 8px, `lg` 10px, `xl` 14px, `2xl` 18px, `3xl`
22px, `4xl` 26px). In practice the product uses a narrow band of that scale:

- **Surfaces** use soft rectangles, not pills: cards and dialogs `rounded-xl`
  (14px), buttons and the detail panel `rounded-lg` (10px), icons and skeletons
  `rounded-md` (8px).
- **Tags and status** go fully round: category `Badge` is `rounded-4xl` (26px —
  effectively a pill), and `StatusBadge` is `rounded-full`.

### Named Rules
**The Honest-Corner Rule.** Modest radii (8–14px) for working surfaces; reserve
the fully-rounded pill (`rounded-4xl` / `rounded-full`) for tags and status —
small, secondary labels that need to read as discrete chips, not containers.

## Components

### Buttons
Compact, confident tools. `rounded-lg` (10px), `text-sm font-medium`, default
height `h-8` (32px) with `px-2.5`; sizes run `xs` (24px) → `lg` (36px). Focus
ring `focus-visible:ring-3 ring-ring/50`; press feedback `active:translate-y-px`.
- **Primary:** `bg-primary text-primary-foreground` — the inverted near-white
  CTA. Use for the single forward action on a screen ("Install App").
- **Outline:** `border-border bg-background`, washes to `bg-muted` on
  hover/expanded. The secondary/cancel button ("Retry Loading").
- **Secondary / Ghost:** muted-background tints for low-emphasis actions.
- **Destructive:** a **soft tint** — `bg-destructive/10 text-destructive`,
  deepening to `/20` on hover. Danger that whispers, not shouts.
- **Link:** `text-primary underline-offset-4 hover:underline`.

> Tension to preserve (or resolve deliberately): the `destructive` *button
> variant* is a soft tint, but the uninstall dialog's **action** button is
> overridden to a **solid** red (`bg-destructive text-destructive-foreground`).
> Note `--destructive-foreground` is **not defined** in the theme, so that solid
> action's text color currently falls back to inherited foreground. A future
> pass should either define `--destructive-foreground` or pick one destructive
> treatment (tint vs. solid) and apply it consistently.

### Badges
Small pill labels. `rounded-4xl` (26px), `h-5`, `text-xs font-medium`, `px-2`.
The **secondary** variant (`bg-secondary text-secondary-foreground`) carries the
app category on every card and the detail page. Variants mirror the button set
(primary, secondary, destructive-tint, outline, ghost, link).

### StatusBadge (signature component)
The one place operational color enters the UI. A `rounded-full` pill
(`bg-background/80`, `shadow-sm`, `text-xs`) containing an 8px (`h-2 w-2`)
`rounded-full` dot whose color is the signal: **Running** → green-500,
**Installing** → yellow-400, **Error** → red-500. It floats top-right on a card
and inline on the detail page. Everything else around it stays gray so the dot
can do its job.

### Cards / AppCard
The catalog unit. `rounded-xl` (14px), `bg-card`, `text-sm`, separated from the
canvas by `ring-1 ring-foreground/10` (a hairline ring, not a border). Internal
padding `p-4`. The clickable `AppCard` adds `hover:-translate-y-0.5
hover:shadow-md` over `transition-all duration-150` — the lift is the affordance.
Layout: 48px `AppIcon`, then title (`text-xl font-semibold`) beside a secondary
category `Badge`, then a two-line description in `text-muted-foreground`.

### AppIcon
`rounded-md` (8px), `object-contain`, fixed at 48px (card) or 80px (detail). On
image error it falls back to a slate tile (`bg-slate-200 dark:bg-slate-700`,
`text-slate-700 dark:text-slate-200`) bearing the app's initial — a cool-gray
fallback that is the one small inconsistency with the warm-neutral theme.

### AlertDialog
The destructive-uninstall confirmation. Centered (`fixed top-1/2 left-1/2`),
`rounded-xl`, `bg-popover`, `ring-1 ring-foreground/10`, `p-4`, `max-w-xs` (→
`sm:max-w-sm`). Opens with a 100ms `fade-in-0 zoom-in-95`; the scrim is
`bg-black/10 backdrop-blur-xs`. Header is centered; the footer is a
`bg-muted/50` bar with a `border-top` holding a `Keep App` outline cancel and the
solid-red `Uninstall App` action (see the Buttons tension note above).

### Skeleton
`rounded-md bg-muted animate-pulse`. Card skeletons are `rounded-lg border
border-border bg-card p-4` at a fixed 200px height, mimicking the real card's
shape so loading→loaded is calm.

### Separator
`bg-border`, horizontal `h-px`. The divider under the header and around detail
sections.

### Empty / Error / Not-found states
Centered, quiet. `mt-12 text-center`, an `text-xl font-semibold` heading and a
`text-sm text-muted-foreground` line. Errors lead with a `text-destructive`
`AlertCircle` and an outline **Retry Loading** button. Copy is honest and plain
("No apps available", "Failed to load apps", "App not found").

## Do's and Don'ts

### Do:
- **Do** design and evaluate every surface in **dark mode first** — the product
  ships dark (D-02); light tokens are vestigial.
- **Do** keep neutral surfaces pure achromatic; let **saturated color carry a
  signal only** (destructive danger, or a status dot). See The Signal-Only Rule.
- **Do** keep surfaces **flat at rest**; introduce rings, shadows, and lift only
  as a response to hover, press, focus, or modal elevation. See The
  Depth-Is-State Rule.
- **Do** build hierarchy with **size and weight within the single Geist face**,
  not a second typeface. See The One-Face Rule.
- **Do** use **modest radii (8–14px)** for working surfaces and reserve the full
  pill for tags and status. See The Honest-Corner Rule.
- **Do** write **plain, honest verbs** that state consequence ("Install App",
  "Uninstall App", "Keep App") — the copy is part of the design.

### Don't:
- **Don't** apply saturated brand or decorative color to general UI surfaces.
  Color is a signal medium, not an accent.
- **Don't** use gradients, glassmorphism, or decorative blur. The only blur in
  the product is the dialog scrim (`backdrop-blur-xs` behind `bg-black/10`).
- **Don't** design light-mode-first, or assume a light canvas. Evaluate in dark
  before anything else.
- **Don't** introduce a second typeface, a display serif, or a monospace accent
  to "add personality" — restraint is the personality.
