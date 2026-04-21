import { Outlet } from "react-router-dom"
import { Separator } from "@/components/ui/separator"

export function AppShell() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-screen-xl px-8">
        <header className="pb-6 pt-12">
          <h1 className="text-[28px] font-semibold leading-[1.2]">App Catalog</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse and install self-hosted apps
          </p>
        </header>
        <Separator className="mb-6" />
        <main className="pb-12">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
