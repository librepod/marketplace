# Remnawave Admin SSO setup (Casdoor via the "OIDC" provider)

The web panel supports OAuth2/OIDC sign-in (Google, GitHub, and a generic
OIDC provider). The generic provider is discovery-based — you give it an
issuer URL and it reads the endpoints from
`/.well-known/openid-configuration` — so it works with Casdoor directly,
no per-endpoint URLs to fill in.

The OAuth settings live in the panel's own database and are edited in the
UI (**Settings → OAuth**). There are no env vars for them; the marketplace
pre-provisions the Casdoor side and this one-time UI step completes the
wiring.

## 0. What the platform already provisioned

- Casdoor application `remnawave-admin` with redirect URI
  `https://remnawave-admin.<BASE_DOMAIN>/oauth/callback`
  (SSOClient `remnawave-admin-sso` in namespace `remnawave-admin`)
- `Secret/remnawave-admin-sso` in namespace `remnawave-admin` with the
  credentials
- CA trust for `id.<BASE_DOMAIN>` in the web-backend pod (the server-side
  token exchange runs there)

## 1. Register the first admin

Open `https://remnawave-admin.<BASE_DOMAIN>` — the **first login registers
the admin account** (see post-install.md). Create it and sign in with the
password once: OAuth login cannot create accounts (below), so the account
must exist before SSO is linked to it.

## 2. Fetch the client credentials

```bash
kubectl -n remnawave-admin get secret remnawave-admin-sso \
  -o jsonpath='{.data.CLIENT_ID}' | base64 -d; echo
kubectl -n remnawave-admin get secret remnawave-admin-sso \
  -o jsonpath='{.data.CLIENT_SECRET}' | base64 -d; echo
```

## 3. Configure the panel

**Settings → OAuth → OIDC**:

| Field | Value |
|---|---|
| Client ID | `CLIENT_ID` from the secret |
| Client Secret | `CLIENT_SECRET` from the secret |
| Issuer URL | `https://id.<BASE_DOMAIN>` |
| Button label | anything (default "SSO") |

## 4. Link your account

OAuth login **never auto-creates accounts**: the panel only accepts an
OAuth identity that has been linked to an existing admin. While logged in,
use the OAuth settings' link/self-service action to bind your Casdoor
identity (identified by its `sub` claim) to your admin account. After
linking, the SSO button on the login page signs you straight in.

## Troubleshooting

- **SSO button missing / "not configured"** — all three OIDC fields must be
  set (client id, secret, issuer); the panel treats the provider as
  configured only then.
- **Callback error, TLS/certificate message** — the CA trust patch did not
  apply to the web-backend pod; check the `merge-ca-bundle` init container
  and `Secret/step-certificates-certs` in the namespace.
- **Login rejected after a successful Casdoor round-trip** — the identity
  is not linked to an admin account (step 4), or you signed in as a
  different Casdoor user than the one you linked.
