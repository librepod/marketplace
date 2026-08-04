/**
 * Thin fetch wrapper. Same-origin cookies are sent by default, so the session
 * cookie travels with every request without per-call configuration. On a 401
 * (session missing/expired) we redirect to the backend login route, which
 * starts the OIDC flow and returns the user to the current path.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { credentials: "include", ...init })
  if (res.status === 401) {
    const rd = encodeURIComponent(window.location.pathname + window.location.search)
    window.location.href = `/api/auth/login?rd=${rd}`
    throw new Error("unauthenticated")
  }
  return res
}
