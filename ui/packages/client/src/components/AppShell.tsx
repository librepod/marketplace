import { NavLink, Outlet } from "react-router-dom"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export function AppShell() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-screen-xl px-8">
        <header className="pb-6 pt-10">
          <h1 className="text-[28px] font-semibold leading-[1.2]">LibrePod</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Self-hosted apps, one click away
          </p>
          <nav className="mt-5 flex items-center gap-6" aria-label="Main navigation">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                cn(
                  "text-sm font-medium transition-colors hover:text-foreground",
                  isActive ? "text-foreground" : "text-muted-foreground"
                )
              }
            >
              Catalog
            </NavLink>
            <NavLink
              to="/my-apps"
              className={({ isActive }) =>
                cn(
                  "text-sm font-medium transition-colors hover:text-foreground",
                  isActive ? "text-foreground" : "text-muted-foreground"
                )
              }
            >
              My Apps
            </NavLink>
          </nav>
        </header>
        <Separator className="mb-6" />
        <main className="pb-12">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
