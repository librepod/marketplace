import { NavLink, Outlet } from "react-router-dom"
import { Separator } from "@/components/ui/separator"
import { Toaster } from "@/components/ui/sonner"
import { UserMenu } from "@/components/UserMenu"
import { cn } from "@/lib/utils"

// Top-nav link styling. The active item carries a foreground underline so the
// current section is unambiguous at a glance — color alone (foreground vs
// muted-foreground) is too quiet for the primary navigation signal.
function navLinkClassName({ isActive }: { isActive: boolean }) {
  return cn(
    "text-sm font-medium transition-colors hover:text-foreground",
    isActive
      ? "text-foreground underline decoration-2 underline-offset-4"
      : "text-muted-foreground",
  )
}

export function AppShell() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-screen-xl px-6 md:px-8">
        <header className="pb-6 pt-8">
          <h1 className="text-2xl font-semibold">LibrePod</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Self-hosted apps, one click away
          </p>
          <div className="mt-5 flex items-center gap-6">
            <nav className="flex items-center gap-6" aria-label="Main navigation">
              <NavLink to="/" end className={navLinkClassName}>
                Catalog
              </NavLink>
              <NavLink to="/my-apps" className={navLinkClassName}>
                My Apps
              </NavLink>
            </nav>
            <UserMenu />
          </div>
        </header>
        <Separator className="mb-6" />
        <main className="pb-12">
          <Outlet />
        </main>
      </div>
      <Toaster position="bottom-right" />
    </div>
  )
}
