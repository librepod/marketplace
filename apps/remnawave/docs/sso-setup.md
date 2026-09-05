# Remnawave SSO setup (Casdoor via the "generic" provider)

Remnawave supports passwordless admin login over OAuth2/OIDC. Its OAuth2
settings live in the panel's own database and are edited in the UI
(**Remnawave Settings → Authentication**) — there are no env vars for them.
The marketplace pre-provisions the Casdoor side; this one-time UI step
completes the wiring.

## Why the "generic" provider (not "PocketID")

Remnawave's dedicated PocketID connector hardcodes PocketID's endpoint paths
(`https://<domain>/authorize`, `https://<domain>/api/oidc/token`), so it can
never point at Casdoor. The **generic** provider takes explicit
authorization/token URLs — that is the Casdoor-compatible path. Casdoor plays
the role PocketID plays in the upstream docs.

## 0. What the platform already provisioned

- Casdoor application `remnawave` with redirect URI
  `https://remnawave.<BASE_DOMAIN>/oauth2/callback/generic`
  (SSOClient `remnawave-sso` in namespace `remnawave`)
- `Secret/remnawave-sso` in namespace `remnawave` with the credentials
- CA trust for `id.<BASE_DOMAIN>` in the panel pod

## 1. Register the first super-admin

Open `https://remnawave.<BASE_DOMAIN>` and register — the first user becomes
the super-admin. (OAuth2 login mints a session for this user, so it must exist
before SSO is used.)

## 2. Fetch the client credentials

```bash
kubectl -n remnawave get secret remnawave-sso \
  -o jsonpath='{.data.CLIENT_ID}' | base64 -d; echo
kubectl -n remnawave get secret remnawave-sso \
  -o jsonpath='{.data.CLIENT_SECRET}' | base64 -d; echo
```

## 3. Configure the panel

**Remnawave Settings → Authentication → Generic**:

| Field | Value |
|---|---|
| Enabled | on |
| Client ID | `CLIENT_ID` from the secret |
| Client Secret | `CLIENT_SECRET` from the secret |
| with PKCE | off |
| Authorization URL | `https://id.<BASE_DOMAIN>/login/oauth/authorize` |
| Token URL | `https://id.<BASE_DOMAIN>/api/login/oauth/access_token` |
| Frontend Domain | `remnawave.<BASE_DOMAIN>` |
| Allowed Emails | your Casdoor account's email — **required, see below** |

> **Allowed Emails is mandatory with Casdoor.** An empty list does *not* mean
> "allow everyone": Remnawave then requires a `remnawaveAccess: true` custom
> claim in the ID token (`auth.service.ts`, v3.4.3 gate:
> `hasCustomClaim || allowedEmails.includes(email)`), and Casdoor's
> `JWT-Standard` tokens cannot carry arbitrary claims — only user-schema
> fields. With the list empty, **every** OAuth2 login fails with `Forbidden`
> (code `E000`) on `/api/auth/oauth2/callback`. List the Casdoor emails of
> the admins who may sign in (`kubectl -n casdoor exec deploy/casdoor -- …`
> or the Casdoor UI shows each user's email).

## 4. Log in

Return to the login page and use the generic-provider button. Remnawave
requests `openid email profile`, exchanges the code server-side (the pod
trusts the LibrePod CA), and reads your email from the ID token. Access is
granted only if the email is in **Allowed Emails** — this is super-admin
login, so keep that list to trusted admins only.

> Locked out? The rescue CLI re-enables password login:
> `kubectl -n remnawave exec deploy/remnawave -- remnawave cli`

## Rotating the client secret

```bash
kubectl annotate ssoclient remnawave-sso -n remnawave \
  marketplace.librepod.org/rotate-secret=true --overwrite
```

Then re-fetch the credentials (step 2), update them in the panel UI, and
`kubectl -n remnawave rollout restart deploy/remnawave`.
