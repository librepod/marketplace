import { NavLink, Outlet } from "react-router-dom"
import { Separator } from "@/components/ui/separator"
import { Toaster } from "@/components/ui/sonner"
import { UserMenu } from "@/components/UserMenu"
import { SoonTag } from "@/components/SoonTag"
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
            Your apps and your device, one place
          </p>
          <div className="mt-5 flex items-center gap-6">
            <nav className="flex items-center gap-6" aria-label="Main navigation">
              <NavLink to="/" end className={navLinkClassName}>
                Apps
              </NavLink>
              <NavLink to="/catalog" className={navLinkClassName}>
                Catalog
              </NavLink>
              {/* Users management is on the roadmap — shown as a disabled,
                  non-navigable item so the control-plane shape is legible
                  without offering a dead link. */}
              <span
                aria-disabled
                className="inline-flex cursor-default items-center gap-1.5 text-sm font-medium text-muted-foreground/60"
              >
                Users
                <SoonTag />
              </span>
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
