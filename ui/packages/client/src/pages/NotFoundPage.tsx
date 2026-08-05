import { Link } from "react-router-dom"

interface NotFoundPageProps {
  title?: string
  description?: string
}

// Shared "not found" surface. Renders inside AppShell both as the catch-all
// route (router path "*") and as AppDetailPage's in-page fallback when an app
// can't be resolved — one layout, two contexts, so only the noun varies.
// Without the catch-all, react-router renders a blank <Outlet /> for mistyped
// or deep links.
export function NotFoundPage({
  title = "Page not found",
  description = "The page you're looking for doesn't exist, or may have moved.",
}: NotFoundPageProps) {
  return (
    <div className="mx-auto max-w-2xl mt-12 text-center">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <Link
        to="/"
        className="mt-4 inline-block text-sm text-muted-foreground hover:underline"
      >
        ← Back to your apps
      </Link>
    </div>
  )
}
