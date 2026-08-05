import crypto from "node:crypto";

// Mint stateless HMAC session tokens identical to the server's SessionService
// (ui/packages/server/src/auth/session.service.ts). The AuthGuard added in #51
// gates every /api/* route on a valid `mp_session` cookie, so the e2e suites
// must present one — without driving a real Casdoor login. Both tiers use this:
//
//   - Tier 1 (hermetic): feeds the SAME secret to its own webServer env, so it
//     controls both signing and verification.
//   - Tier 2 (real cluster): run-tier2.sh reads the LIVE secret from
//     Secret/marketplace-ui-session (key `session-secret`) and exports it as
//     E2E_SESSION_SECRET, since the in-cluster server verifies against a random
//     key the test runner can't otherwise know.
//
// The AuthGuard only checks signature validity + exp (no role/claim gating in
// the login-only scope of #51), so a stub identity is sufficient. NB: the HMAC
// here MUST stay in sync with SessionService.sign/verify — this is the single
// source of truth for that algorithm across both tiers.

export const SESSION_COOKIE_NAME = "mp_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60; // mirrors SessionService.TTL_SECONDS

export function mintSessionToken(secret: string, claims: Record<string, unknown> = {}): string {
  if (!secret) throw new Error("mintSessionToken: secret is required");
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      sub: "e2e",
      name: "E2E Runner",
      email: "e2e@tier1.local",
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
      ...claims,
    }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

// Build a Playwright storageState that authenticates BOTH the `page` fixture
// (SPA + AuthGate + install/uninstall button clicks) and the `request` fixture
// (/api/apps, /api/installed reads). `domain` MUST equal the baseURL hostname
// (cookies ignore the port, and a mismatch silently drops the cookie). Plain
// HTTP e2e (localhost dev server / kubectl port-forward) → secure:false.
// Structurally identical to Playwright's StorageState (cookies: Cookie[]; origins:
// Origin[]), so the return value is directly assignable to `use.storageState`. Typed
// explicitly so the returned cookie literal gets contextual typing (otherwise
// sameSite would widen to `string` and be rejected by the "Lax"|"Strict"|"None" union).
type SessionStorageState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Lax" | "Strict" | "None";
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
};

export function sessionStorageState(secret: string, domain: string): SessionStorageState {
  const now = Math.floor(Date.now() / 1000);
  return {
    cookies: [
      {
        name: SESSION_COOKIE_NAME,
        value: mintSessionToken(secret),
        domain,
        path: "/",
        expires: now + SESSION_TTL_SECONDS,
        httpOnly: false,
        secure: false, // e2e runs over plain HTTP (localhost)
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
}
