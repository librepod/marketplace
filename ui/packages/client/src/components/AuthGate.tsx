import type { ReactNode } from "react"
import { useUser } from "@/hooks/useUser"
import { FullScreenSpinner } from "@/components/FullScreenSpinner"

/**
 * Gates the app behind a Casdoor session. On mount it reads /api/me:
 *  - pending → spinner
 *  - 401     → apiFetch already redirected to /api/auth/login (render nothing)
 *  - 200     → render children (the user is cached under queryKey ["me"])
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { data: user, isPending } = useUser()
  if (isPending) return <FullScreenSpinner />
  if (!user) return null
  return <>{children}</>
}
