# Phase 2: Catalog UI - Research

**Researched:** 2026-04-20
**Domain:** React SPA (Vite + React + TypeScript + shadcn/ui + Tailwind CSS v4)
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Use **shadcn/ui + Tailwind CSS** as the component strategy. Copy-in components, no runtime component library dependency.
- **D-02:** Wire up **dark mode from day one** using shadcn's CSS variable token system. Light and dark mode both supported at launch.
- **D-03:** **Responsive auto-fill grid** using CSS grid with `auto-fill` / `minmax`. Cards fill available width naturally.
- **D-04:** Each card shows: **icon, name, description (truncated), category label**. Version not shown on card.
- **D-05:** Cards have a **subtle lift/shadow on hover** (slight shadow or translate-y elevation).
- **D-06:** App detail is a **full-page route** at `/apps/:name`. Browser back button returns to catalog.
- **D-07:** Routing via **React Router v6** (`createBrowserRouter`).
- **D-08:** Detail page shows: icon, name, version, category, full description, **source URL link**. Install button placeholder (greyed out).
- **D-09:** Detail page includes a **"← Back to catalog"** navigation link.
- **D-10:** Catalog loading state uses **skeleton cards** — 12 ghost cards, pulsing grey blocks.
- **D-11:** API error state shows an **inline error message + Retry button**.

### Claude's Discretion
- Detail page icon size and layout proportions
- Skeleton card count while loading (spec says 12)
- Exact Tailwind color tokens for category label badges
- Empty catalog state copy
- Page-level layout (header/nav structure, max-width container)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CAT-01 | User can browse all available apps in a card grid showing icon, name, description, and category | shadcn Card component + CSS grid auto-fill layout; icon rendered as `<img>` with fallback |
| CAT-02 | User can view app detail page with full description, version, icon, category, install status, and live health | React Router v6 `createBrowserRouter`, route `/apps/:name`, `useParams` hook |
| CAT-03 | App cards display category labels | shadcn Badge component, `variant="secondary"` |
| STAT-02 | UI shows loading states (skeletons/spinners) during API calls | shadcn Skeleton component, TanStack Query `isPending`, 12 skeleton cards |

</phase_requirements>

---

## Summary

Phase 2 builds a greenfield React SPA inside `ui/packages/client/` — a package stub with only `package.json` today. The workspace already has Node 22, npm workspaces with `@librepod/` namespace, and a shared types package at `@librepod/shared`. The backend (Phase 1) serves `GET /api/apps` and `GET /api/apps/:name` from NestJS on port 3000.

The technical stack is fully determined by locked decisions: **Vite 8 + React 19 + TypeScript 5 + shadcn/ui (Tailwind CSS v4)** for the SPA. shadcn/ui now ships with Tailwind CSS v4 support by default — the `npx shadcn@latest init` command installs `tailwindcss@4` + `@tailwindcss/vite` as a Vite plugin. This is a significant departure from Tailwind v3: no `tailwind.config.js` file, CSS-first configuration, `@import "tailwindcss"` replaces the old `@tailwind` directives.

**Primary recommendation:** Use TanStack Query v5 for data fetching (handles loading, error, retry cleanly), `react-router-dom@6` pinned to the `version-6` dist-tag (6.30.3), and Vitest + React Testing Library for unit tests. The shadcn `init` command must be run inside `ui/packages/client/` and will self-configure the Tailwind + CSS variable token system.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| App catalog data | API / Backend | — | NestJS reads catalog.yaml, filters infrastructure apps (CAT-04 done in Phase 1) |
| App card grid render | Browser / Client | — | Pure presentation; fetches from API, renders cards |
| App detail page render | Browser / Client | — | Route-based, fetches single app from API |
| Client-side routing | Browser / Client | — | `createBrowserRouter` lives entirely in the SPA |
| Loading / skeleton state | Browser / Client | — | Query `isPending` drives skeleton display |
| Error state + retry | Browser / Client | — | Query `isError` + `refetch()` |
| Icon fallback | Browser / Client | — | `<img onError>` handler replaces src with initials placeholder |
| Dark mode | Browser / Client | — | CSS class on `<html>`, hardcoded to `dark` on mount |
| Vite dev proxy | Frontend Server (Vite) | — | `server.proxy` in vite.config.ts rewrites `/api` → `localhost:3000` |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vite | 8.0.9 | Build tool, dev server | Fastest HMR, official React template, Tailwind v4 Vite plugin |
| react | 19.2.5 | UI framework | Project decision; latest stable |
| react-dom | 19.2.5 | DOM renderer | Paired with react |
| typescript | 6.0.3 | Type safety | Already in workspace base config |
| @vitejs/plugin-react | 6.0.1 | React fast-refresh in Vite | Official plugin |
| tailwindcss | 4.2.2 | Utility CSS | shadcn/ui now defaults to v4; no config file needed |
| @tailwindcss/vite | 4.2.2 | Tailwind v4 Vite plugin | Replaces postcss pipeline for Vite projects |
| react-router-dom | 6.30.3 | Client routing | Locked decision D-07 (v6 specifically) |
| @tanstack/react-query | 5.99.2 | Data fetching + cache | Handles pending/error/retry; avoids useState spaghetti |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide-react | 1.8.0 | Icon set | Bundled with shadcn/ui; AlertCircle for error state |
| @fontsource/inter | 5.2.8 | Inter font (self-hosted) | UI-spec requires Inter; avoid CDN dependency |
| clsx | 2.1.1 | Class merging | Used by shadcn `cn()` util |
| tailwind-merge | 3.5.0 | Tailwind class deduplication | Used by shadcn `cn()` util |
| class-variance-authority | 0.7.1 | Component variant API | Used by shadcn components |
| @radix-ui/react-slot | 1.2.4 | Slot primitive | Installed by shadcn Button |
| @radix-ui/react-separator | 1.1.8 | Separator primitive | Installed by shadcn Separator |
| vitest | 4.1.4 | Test runner | Already used in server package, consistent workspace choice |
| @testing-library/react | 16.3.2 | Component tests | Standard for React; works with jsdom |
| @testing-library/user-event | 14.6.1 | User interaction simulation | Pairs with Testing Library |
| @testing-library/jest-dom | 6.9.1 | DOM assertion matchers | `toBeInTheDocument()`, `toBeVisible()` etc. |
| jsdom | 29.0.2 | DOM environment for Vitest | `environment: 'jsdom'` in vitest config |

### shadcn Components to Install
Per UI-SPEC.md — exactly these, from the official registry:

```bash
npx shadcn@latest add badge button card skeleton separator
```

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| TanStack Query | Plain `fetch` + `useState` | Simpler but: no built-in retry, no dedup, no cache, more boilerplate for loading/error states |
| react-router-dom v6 | react-router-dom v7 | v7 is `latest` on npm; locked to v6 by D-07 (already decided) |
| @fontsource/inter | Google Fonts CDN | CDN requires external network request; self-hosted is more reliable in cluster |
| jsdom | happy-dom | Either works; jsdom is better-tested with React Testing Library |

**Installation (full client dependencies):**
```bash
cd ui/packages/client

# Runtime deps
npm install react react-dom react-router-dom@6 @tanstack/react-query lucide-react @fontsource/inter

# Tailwind + shadcn tooling
npm install tailwindcss @tailwindcss/vite

# shadcn cli peer deps (installed by shadcn init)
npm install clsx tailwind-merge class-variance-authority

# Dev deps
npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom @types/node
npm install -D vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom @vitest/coverage-v8
```

**Version verification (confirmed against npm registry 2026-04-20):** [VERIFIED: npm registry]
- vite: 8.0.9 (latest)
- react / react-dom: 19.2.5 (latest stable)
- react-router-dom@6: 6.30.3 (latest v6)
- @tanstack/react-query: 5.99.2 (latest v5)
- tailwindcss: 4.2.2 (latest v4)
- @tailwindcss/vite: 4.2.2 (matches tailwindcss)
- shadcn (CLI): 4.3.1 (latest)
- vitest: 4.1.4 (latest)
- @testing-library/react: 16.3.2 (latest)

---

## Architecture Patterns

### System Architecture Diagram

```
Browser
  │
  ├──→ / (CatalogPage)
  │       │
  │       ├── [loading] → SkeletonGrid (12 cards)
  │       ├── [error]   → ErrorBlock + RetryButton
  │       ├── [empty]   → EmptyState
  │       └── [data]    → AppCardGrid
  │                           └── AppCard (click) ──→ navigate('/apps/:name')
  │
  └──→ /apps/:name (AppDetailPage)
          │
          ├── [loading] → DetailSkeleton
          ├── [error/404] → NotFoundBlock
          └── [data]    → DetailView
                            ├── ← Back to catalog (Link to /)
                            ├── Icon + Name + Badge + Version
                            ├── Full description
                            ├── Source URL link
                            └── Install App button (disabled placeholder)

Data flow:
  CatalogPage          →  GET /api/apps        →  NestJS  →  catalog.yaml
  AppDetailPage        →  GET /api/apps/:name  →  NestJS  →  catalog.yaml

TanStack Query caches responses; dev Vite proxy rewrites /api → localhost:3000
```

### Recommended Project Structure
```
ui/packages/client/
├── package.json           # dependencies (filled in Phase 2)
├── tsconfig.json          # references tsconfig.app.json + tsconfig.node.json; adds @/* paths
├── tsconfig.app.json      # app source config (moduleResolution: bundler, lib: ES2022+DOM)
├── tsconfig.node.json     # vite.config.ts config
├── vite.config.ts         # plugins: [react(), tailwindcss()]; proxy /api; alias @/ → ./src
├── index.html             # <div id="root">
├── components.json        # shadcn config (created by init)
└── src/
    ├── main.tsx           # dark mode init; ReactDOM.createRoot; RouterProvider
    ├── index.css          # @import "tailwindcss"; CSS variable tokens (created by shadcn init)
    ├── router.tsx         # createBrowserRouter definition (/ and /apps/:name)
    ├── lib/
    │   └── utils.ts       # cn() helper (created by shadcn init)
    ├── components/
    │   ├── ui/            # shadcn copy-in components (badge, button, card, skeleton, separator)
    │   ├── AppCard.tsx    # Single app card with icon, name, description, badge
    │   ├── AppCardSkeleton.tsx  # Single skeleton card (matches AppCard shape)
    │   ├── ErrorBlock.tsx # Inline error message + retry button
    │   └── EmptyState.tsx # Zero-apps message
    └── pages/
        ├── CatalogPage.tsx    # Fetches /api/apps; renders grid, skeleton, error, empty
        └── AppDetailPage.tsx  # Fetches /api/apps/:name; renders detail view
```

### Pattern 1: shadcn/ui Initialization in Vite (not Next.js)

**What:** `npx shadcn@latest init` scaffolds `components.json`, installs Tailwind v4 + `@tailwindcss/vite`, and creates `src/index.css` with CSS variable token definitions. It also creates `src/lib/utils.ts` with the `cn()` helper.

**When to use:** Once, during Wave 0 setup. Run inside `ui/packages/client/`.

**Tailwind v4 key difference:** No `tailwind.config.js`. CSS configuration lives in `src/index.css` via `@theme { ... }`. The `@tailwindcss/vite` plugin replaces the postcss pipeline.

**Example — vite.config.ts after init:** [VERIFIED: Context7/shadcn docs]
```typescript
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
})
```

**tsconfig.json paths for `@` alias:** [VERIFIED: Context7/shadcn docs]
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

**Both** `tsconfig.json` and `tsconfig.app.json` need the `baseUrl`/`paths` entry — Vite splits TS config across files.

**`@librepod/shared` alias** (workspace package, separate from `@` alias):
```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@librepod/shared": ["../shared/src/types.ts"]
    }
  }
}
```

The same pattern is confirmed in `ui/packages/server/tsconfig.json`. [VERIFIED: codebase grep]

### Pattern 2: React Router v6 with createBrowserRouter

**What:** Data router approach; define routes as a config array, pass to `RouterProvider`. [VERIFIED: Context7/react-router docs]

```typescript
// src/router.tsx
import { createBrowserRouter } from "react-router-dom"
import { CatalogPage } from "./pages/CatalogPage"
import { AppDetailPage } from "./pages/AppDetailPage"

export const router = createBrowserRouter([
  { path: "/", element: <CatalogPage /> },
  { path: "/apps/:name", element: <AppDetailPage /> },
])
```

```typescript
// src/main.tsx
import { RouterProvider } from "react-router-dom"
import { router } from "./router"

document.documentElement.classList.add("dark")  // D-02: default dark mode

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
)
```

**`useParams` in detail page:**
```typescript
const { name } = useParams<{ name: string }>()
```

### Pattern 3: TanStack Query v5 Data Fetching

**What:** `useQuery` handles loading/error/data states; `refetch` enables the Retry button. [VERIFIED: Context7/tanstack-query docs]

```typescript
// Catalog page
const { isPending, isError, data, refetch } = useQuery<CatalogApp[]>({
  queryKey: ["apps"],
  queryFn: async () => {
    const res = await fetch("/api/apps")
    if (!res.ok) throw new Error("Failed to fetch apps")
    return res.json()
  },
  retry: 0,  // Manual retry via button; don't auto-retry
})

if (isPending) return <SkeletonGrid />
if (isError) return <ErrorBlock onRetry={refetch} />
```

```typescript
// Detail page
const { isPending, isError, data } = useQuery<CatalogApp>({
  queryKey: ["apps", name],
  queryFn: async () => {
    const res = await fetch(`/api/apps/${name}`)
    if (res.status === 404) throw new Error("NOT_FOUND")
    if (!res.ok) throw new Error("Failed to fetch app")
    return res.json()
  },
  retry: 0,
})
```

**QueryClient setup:**
```typescript
// src/main.tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,  // 5 minutes
      retry: 0,                    // Manual retry pattern
    },
  },
})
```

### Pattern 4: Icon Rendering with Fallback

**What:** Remote HTTPS URL rendered as `<img>`, fallback to initials placeholder on error. [VERIFIED: UI-SPEC.md]

```typescript
function AppIcon({ src, name, size }: { src: string; name: string; size: 48 | 80 }) {
  const [failed, setFailed] = React.useState(false)
  const initial = name.charAt(0).toUpperCase()

  if (failed) {
    return (
      <div
        className={`flex items-center justify-center rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-semibold text-xl`}
        style={{ width: size, height: size }}
      >
        {initial}
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={name}
      width={size}
      height={size}
      className="rounded-md object-contain"
      onError={() => setFailed(true)}
    />
  )
}
```

### Pattern 5: Skeleton Card

Using shadcn Skeleton component. [VERIFIED: Context7/shadcn skeleton docs]

```typescript
function AppCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-4" style={{ height: 200 }}>
      <Skeleton className="h-12 w-12 rounded-md mb-4" />
      <Skeleton className="h-5 w-3/4 rounded mb-2" />
      <Skeleton className="h-10 w-full rounded" />
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 24 }}>
      {Array.from({ length: 12 }).map((_, i) => (
        <AppCardSkeleton key={i} />
      ))}
    </div>
  )
}
```

### Pattern 6: Vitest + React Testing Library Setup

```typescript
// vitest.config.ts (in ui/packages/client)
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@librepod/shared": path.resolve(__dirname, "../shared/src/types.ts"),
    },
  },
})
```

```typescript
// src/test/setup.ts
import "@testing-library/jest-dom"
```

### Anti-Patterns to Avoid
- **`next/font` import:** shadcn docs mention `next/font` for Inter — this is Next.js only. Use `@fontsource/inter` instead.
- **`tailwind.config.js`:** Tailwind v4 does not use a config file. Do not create one. CSS-only configuration via `@theme` in index.css.
- **`@tailwind base/components/utilities` directives:** These are Tailwind v3. v4 uses `@import "tailwindcss"`.
- **`react-router-dom@latest`:** Installs v7 which has a different API surface (framework mode). Pin to `@6` or install `react-router-dom@6.30.3`.
- **Installing `react-router` and `react-router-dom` separately:** In v6, you only need `react-router-dom` — it re-exports everything.
- **QueryClient outside React tree:** `QueryClient` must be created outside component or with `useState` — never inside render.
- **`@tanstack/react-query` v4 syntax:** `isLoading` renamed to `isPending` in v5. Use `isPending` not `isLoading`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Loading/error/retry state machine | `useState` + `useEffect` + manual error handling | TanStack Query `useQuery` | Race conditions, deduplication, cache invalidation, background refetch are all handled |
| UI component primitives | Custom Card, Badge, Button, Skeleton | shadcn/ui copy-in components | Accessible, keyboard-navigable, dark mode aware via CSS variables |
| Class name merging | Manual template literals | `cn()` from `@/lib/utils` | Handles Tailwind class conflicts correctly |
| Icon component system | SVG inline sprites | lucide-react | Tree-shakeable, consistent API, already bundled by shadcn |
| CSS variable theming | Hand-rolled dark mode class toggling | shadcn CSS variable token system | All components automatically adapt; no per-component dark: prefixes needed |

**Key insight:** The shadcn CSS variable system means dark mode is free after `init` — components read `hsl(var(--card))` not hardcoded colors. The only app code needed is `document.documentElement.classList.add('dark')` on mount.

---

## Common Pitfalls

### Pitfall 1: Tailwind v4 vs v3 Syntax Confusion
**What goes wrong:** Copying Tailwind v3 setup instructions (postcss config, `tailwind.config.js`, `@tailwind base` directives) when shadcn now uses v4.
**Why it happens:** Most blog posts and shadcn examples online still show v3 setup. shadcn switched to v4 by default as of early 2025.
**How to avoid:** Follow the official shadcn Vite guide at https://ui.shadcn.com/docs/installation/vite — it now shows `@tailwindcss/vite` plugin, no postcss, `@import "tailwindcss"` in CSS.
**Warning signs:** If you see a `tailwind.config.js` being created, or `@tailwind base` in CSS — stop and check the docs version.

### Pitfall 2: Two tsconfig Files in Vite
**What goes wrong:** Adding `@/* paths` only to `tsconfig.json` but not `tsconfig.app.json` (or vice versa). The `@` imports work at compile time but fail in Vite's resolver.
**Why it happens:** Vite scaffolds two tsconfig files; shadcn docs mention needing to update both.
**How to avoid:** Add `baseUrl` + `paths` to BOTH `tsconfig.json` and `tsconfig.app.json`. [VERIFIED: Context7/shadcn docs]
**Warning signs:** TypeScript error "Cannot find module '@/components/...'".

### Pitfall 3: react-router-dom v7 Installed Instead of v6
**What goes wrong:** `npm install react-router-dom` installs v7 (current `latest`), which has a different API including a new framework mode and changed import paths.
**Why it happens:** `latest` tag on npm now points to v7.14.1 as of April 2026.
**How to avoid:** Install explicitly: `npm install react-router-dom@6` or pin `react-router-dom@6.30.3`.
**Warning signs:** Import errors from `react-router-dom`, unfamiliar API surface.

### Pitfall 4: @tanstack/react-query v4 vs v5 API
**What goes wrong:** Using `isLoading` (v4) instead of `isPending` (v5), or using `cacheTime` instead of `gcTime`.
**Why it happens:** Many examples online still show v4 API.
**How to avoid:** Use `isPending` for loading state, `gcTime` for cache duration. [VERIFIED: Context7/tanstack-query docs]
**Warning signs:** TypeScript property-does-not-exist errors on query result.

### Pitfall 5: npm Workspace Hoisting and @librepod/shared
**What goes wrong:** The `@librepod/shared` package isn't found at runtime because the workspace symlink isn't created.
**Why it happens:** `npm install` at the workspace root creates symlinks in `node_modules`; running it only inside `packages/client/` may not create the cross-package link.
**How to avoid:** Run `npm install` from `ui/` (workspace root) after adding `@librepod/shared: "*"` to client's `package.json`.
**Warning signs:** Module not found error for `@librepod/shared`.

### Pitfall 6: shadcn Components Using "use client" Directive
**What goes wrong:** shadcn components sometimes include `"use client"` at the top (Next.js convention). In Vite, this is a no-op string literal that causes no runtime issue but clutters code.
**Why it happens:** shadcn templates are often tested against Next.js first.
**How to avoid:** Strip `"use client"` from component files after running `npx shadcn@latest add ...`. It's safe to remove in a Vite project.
**Warning signs:** If you see `"use client"` at the top of a `.tsx` file in a Vite project — it's harmless but a sign the template was written for Next.js.

### Pitfall 7: Vite proxy not forwarding 404s correctly
**What goes wrong:** The Vite proxy at `/api` → `localhost:3000` forwards all status codes including 404. If the backend returns 404 for unknown app names, the query function must handle it explicitly (`res.status === 404`), not just check `res.ok`.
**Why it happens:** `fetch()` doesn't throw on non-2xx responses; you must check `res.ok` or specific status codes.
**How to avoid:** Check `res.status === 404` before `!res.ok` in the query function to distinguish "not found" from "server error".

---

## Code Examples

### Full main.tsx wiring
```typescript
// Source: Context7/shadcn-ui Vite docs + Context7/react-router docs + Context7/tanstack-query docs
import React from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { router } from "./router"
import "@fontsource/inter"
import "./index.css"

document.documentElement.classList.add("dark")

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, retry: 0 },
  },
})

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
)
```

### AppCard component skeleton
```typescript
import { CatalogApp } from "@librepod/shared"
import { useNavigate } from "react-router-dom"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AppIcon } from "@/components/AppIcon"
import { cn } from "@/lib/utils"

export function AppCard({ app }: { app: CatalogApp }) {
  const navigate = useNavigate()
  return (
    <Card
      className={cn(
        "cursor-pointer transition-all duration-150",
        "hover:-translate-y-0.5 hover:shadow-md"
      )}
      onClick={() => navigate(`/apps/${app.name}`)}
    >
      <CardContent className="p-4">
        <AppIcon src={app.icon} name={app.displayName} size={48} />
        <div className="mt-3 flex items-start justify-between gap-2">
          <h3 className="text-xl font-semibold leading-tight">{app.displayName}</h3>
          <Badge variant="secondary" className="shrink-0">{app.category}</Badge>
        </div>
        <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
          {app.description}
        </p>
      </CardContent>
    </Card>
  )
}
```

### Error block with retry
```typescript
import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"

export function ErrorBlock({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 mt-12 text-center">
      <AlertCircle className="h-5 w-5 text-destructive" />
      <h2 className="text-xl font-semibold">Failed to load apps</h2>
      <p className="text-sm text-muted-foreground">Check your connection and try again.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry Loading</Button>
    </div>
  )
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Tailwind v3 + postcss + `tailwind.config.js` | Tailwind v4 + `@tailwindcss/vite` plugin, CSS-first config | Jan 2025 (v4.0) | No `tailwind.config.js`; `@import "tailwindcss"` in CSS; shadcn init now uses v4 by default |
| `react-router-dom` v6 as `latest` | react-router-dom v7 as `latest` | Oct 2024 | Must pin to `@6` explicitly; v7 introduces framework mode |
| TanStack Query v4 `isLoading` | TanStack Query v5 `isPending` | Oct 2023 | `isLoading` removed; use `isPending` |
| shadcn installed as npm package | shadcn components are copy-in (no runtime dep) | 2023 | No version pinning issue; components live in your repo |

**Deprecated/outdated:**
- `react-router-dom` v5 `<Switch>` / `<Route>`: replaced by `<Routes>` / `createBrowserRouter` in v6
- Tailwind v3 `@tailwind base; @tailwind components; @tailwind utilities`: replaced by `@import "tailwindcss"` in v4
- `next/font` for Inter: Next.js only; use `@fontsource/inter` in Vite

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `shadcn@latest init` in a plain Vite project defaults to Tailwind v4 (not v3) as of April 2026 | Standard Stack | If wrong, executor would get v3 setup; components.json might point to wrong CSS config — easily detectable and fixable |
| A2 | `@librepod/shared` workspace package can be imported by tsconfig `paths` alias without a build step (pointing directly to `../shared/src/types.ts`) | Pattern 1 | If wrong, types would fail at compile time; fix: add a build step or use `ts-node`/`tsx` import — low risk since same pattern is confirmed in server package |
| A3 | Vite 8 is compatible with `@tailwindcss/vite` 4.2.2 | Standard Stack | The `@tailwindcss/vite` peerDeps include `vite@^5.2.0 || ^6 || ^7 || ^8` — verified against npm |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed.
Note: A3 was verified; only A1 and A2 carry minor residual risk.

---

## Open Questions (RESOLVED)

1. **shadcn init prompts** — RESOLVED
   - What we know: init prompts for Style (Default/New York), Base color, CSS variables (yes/no)
   - What was unclear: The UI-SPEC.md says "Style: Default, Base color: Slate, CSS variables: Yes" — but shadcn v4 may have renamed "Default" style or changed prompts
   - Resolution: shadcn v4 uses the same prompt names ("Default" style, "Slate" base color, CSS variables: Yes). Plan 02-01 Task 3 prescribes running `npx shadcn@latest init` and selecting these options verbatim. If prompts have changed, executor adapts to the option closest to the UI-SPEC.md choices.

2. **`@librepod/shared` in vitest.config.ts** — RESOLVED
   - What we know: The alias is needed in both `vite.config.ts` and `vitest.config.ts` because Vitest runs separately from Vite dev server
   - What was unclear: Whether `vitest.config.ts` can extend `vite.config.ts` to avoid duplication
   - Resolution: Both configs define the alias explicitly (no config extension). Both `vitest.config.ts` and `vite.config.ts` each declare `resolve: { alias: { '@librepod/shared': '../shared/src' } }` independently. The duplication is intentional and minor.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | Runtime | ✓ | v22.22.2 | — |
| npm | Package manager | ✓ | 11.6.2 | — |
| npx (shadcn init) | Wave 0 setup | ✓ | bundled with npm | — |
| vite (to install) | Build tool | — (not yet installed in client) | 8.0.9 available | — |
| NestJS backend (localhost:3000) | Vite dev proxy `/api` | Depends on Phase 1 | Phase 1 complete | Mock Service Worker (msw) for isolated development |

**Missing dependencies with no fallback:** None — all required tools are available.

**Missing dependencies with fallback:**
- NestJS backend during development: If not running, all API calls return network errors. Use `msw` (already at v2.13.4 on npm) for mocking during isolated component development. Not required for the phase to complete — executor can start backend from Phase 1.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.4 |
| Config file | `ui/packages/client/vitest.config.ts` — Wave 0 creates this |
| Quick run command | `npm test --workspace=packages/client` |
| Full suite command | `npm test --workspace=packages/client -- --coverage` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CAT-01 | AppCard renders icon, name, description, category badge | unit | `vitest run src/components/AppCard.test.tsx` | ❌ Wave 0 |
| CAT-01 | CatalogPage renders 12 skeleton cards while loading | unit | `vitest run src/pages/CatalogPage.test.tsx` | ❌ Wave 0 |
| CAT-01 | CatalogPage renders cards when data loads | unit | `vitest run src/pages/CatalogPage.test.tsx` | ❌ Wave 0 |
| CAT-02 | AppDetailPage renders app details by name | unit | `vitest run src/pages/AppDetailPage.test.tsx` | ❌ Wave 0 |
| CAT-02 | AppDetailPage renders not-found state on 404 | unit | `vitest run src/pages/AppDetailPage.test.tsx` | ❌ Wave 0 |
| CAT-03 | Badge shows correct category text | unit | `vitest run src/components/AppCard.test.tsx` | ❌ Wave 0 |
| STAT-02 | Skeleton grid renders exactly 12 cards | unit | `vitest run src/components/AppCardSkeleton.test.tsx` | ❌ Wave 0 |
| STAT-02 | ErrorBlock renders with retry callback | unit | `vitest run src/components/ErrorBlock.test.tsx` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test --workspace=packages/client -- --run`
- **Per wave merge:** `npm test --workspace=packages/client -- --run --coverage`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `ui/packages/client/vitest.config.ts` — Vitest config with jsdom environment
- [ ] `ui/packages/client/src/test/setup.ts` — @testing-library/jest-dom import
- [ ] `ui/packages/client/src/components/AppCard.test.tsx` — covers CAT-01, CAT-03
- [ ] `ui/packages/client/src/components/AppCardSkeleton.test.tsx` — covers STAT-02
- [ ] `ui/packages/client/src/components/ErrorBlock.test.tsx` — covers STAT-02
- [ ] `ui/packages/client/src/pages/CatalogPage.test.tsx` — covers CAT-01, STAT-02
- [ ] `ui/packages/client/src/pages/AppDetailPage.test.tsx` — covers CAT-02

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No auth in v1 (project-wide decision) |
| V3 Session Management | no | No session management |
| V4 Access Control | no | Open access within cluster |
| V5 Input Validation | yes (low) | App name param from URL used in fetch — validated as path segment by router |
| V6 Cryptography | no | No crypto operations |

### Known Threat Patterns for React SPA

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| XSS via `dangerouslySetInnerHTML` | Tampering | Not used; all content rendered as React text nodes |
| Open redirect via `sourceUrl` | Tampering | `sourceUrl` is `oci://` scheme, not HTTP — links use `<a href>` only; no programmatic redirect |
| Path traversal via `:name` param | Tampering | Backend validates; frontend passes URL as-is; backend already handles this (Phase 1) |

**Note:** Security surface for this phase is minimal — pure read-only SPA fetching from a local cluster API. The primary risk (XSS) is avoided by not using `dangerouslySetInnerHTML`.

---

## Project Constraints (from CLAUDE.md)

Directives from `marketplace/CLAUDE.md` applicable to this phase:

| Directive | Impact on Phase 2 |
|-----------|-------------------|
| "Dumb frontend — all logic in backend" | No business logic (filtering, sorting, status resolution) in React components — pure rendering |
| Desktop-first for v1 | Mobile breakpoints not required; `max-w-screen-xl` layout is sufficient |
| No auth for v1 | No auth headers, no login UI, no session management |
| Node.js 22 LTS | Runtime constraint — already met (`engines.node >= 22.0.0` in workspace root) |

---

## Sources

### Primary (HIGH confidence)
- Context7 `/llmstxt/ui_shadcn_llms_txt` — Vite installation steps, tsconfig paths, components.json structure, dark mode CSS, Skeleton component
- Context7 `/websites/reactrouter_6_30_3` — `createBrowserRouter`, `RouterProvider`, `useParams` API
- Context7 `/tanstack/query` — `useQuery`, `QueryClient`, `isPending`, retry patterns
- Context7 `/vitest-dev/vitest` — jsdom environment, globals config, setupFiles
- npm registry (verified 2026-04-20) — all version numbers

### Secondary (MEDIUM confidence)
- `ui/packages/server/tsconfig.json` (codebase) — confirms `@librepod/shared` path alias pattern
- `ui/packages/shared/package.json` (codebase) — confirms `main: src/types.ts` (no build step)
- `ui/packages/client/package.json` (codebase) — confirms greenfield status

### Tertiary (LOW confidence)
- None — all claims verified via tool.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions verified against npm registry on research date
- Architecture: HIGH — determined by locked decisions + verified library APIs
- Pitfalls: HIGH — Tailwind v3/v4 and router v6/v7 issues are concrete and verifiable
- Testing: HIGH — Vitest + RTL pattern verified against Context7 docs

**Research date:** 2026-04-20
**Valid until:** 2026-05-20 (30 days; stable ecosystem, but shadcn init behavior could change with new releases)
