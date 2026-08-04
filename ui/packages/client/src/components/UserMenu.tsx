import { UserCircle2 } from "lucide-react"
import { useUser } from "@/hooks/useUser"

/** "Signed in as <name>" + sign-out. Rendered in AppShell header. */
export function UserMenu() {
  const { data: user } = useUser()
  if (!user) return null
  return (
    <a
      href="/api/auth/logout"
      className="ml-auto inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      title={`Signed in as ${user.name}${user.email ? ` (${user.email})` : ""} — click to sign out`}
    >
      <UserCircle2 className="size-4" />
      <span className="max-w-[10rem] truncate">{user.name}</span>
    </a>
  )
}
