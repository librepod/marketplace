/** The admin and personal password rule, mirrored from the server: 12+ characters,
 *  no whitespace (wg-easy rejects shorter admin passwords; Casdoor rejects spaces). */
export const MIN_PASSWORD = 12

export function validPassword(p: string): boolean {
  return p.length >= MIN_PASSWORD && !/\s/.test(p)
}

/** Where the setup code is printed — any shell with kubectl access to the device. */
export const SETUP_CODE_COMMAND = 'kubectl -n marketplace-ui logs deploy/marketplace-ui | grep "setup code"'

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export interface PostResult {
  ok: boolean
  status: number
  /** The server's message, when it sent one as text. */
  message: string | null
  body: Record<string, unknown>
}

/** POSTs JSON to a wizard endpoint. Plain fetch on purpose — apiFetch's 401 handler
 *  redirects into single sign-on, which cannot work on the raw IP. */
export async function postJson(url: string, body: unknown): Promise<PostResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return {
    ok: res.ok,
    status: res.status,
    message: typeof parsed.message === "string" ? parsed.message : null,
    body: parsed,
  }
}
