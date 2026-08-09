# Casdoor

Casdoor is the platform SSO/IdP for LibrePod. OIDC Applications for individual
apps are provisioned automatically by the `casdoor-sso-controller` from
`SSOClient` custom resources — do not create them by hand.

## Maximizing SSO session length (trusted-network deployments)

Persistent cross-app SSO is on by default (every Casdoor Application is
provisioned with `enableSigninSession` + `enableAutoSignin` enabled by the
casdoor-sso-controller). To make that session *long-lived* — appropriate on a
single-user, VPN-only network — raise the organization's session/token
lifetime, which is an org-level Casdoor setting NOT managed by this repo:

1. Log in to the Casdoor admin UI at `https://<idp-subdomain>.<base-domain>`.
2. Go to **Organizations → librepod → Edit**.
3. Raise the token/session expiry fields to the desired duration and Save.

This is a one-time manual step per cluster. It is intentionally not codified:
the `librepod` organization is created interactively at bootstrap and is not
provisioned as code. To capture it reproducibly, use the `casdoor-export` flow.

**Security note:** silent cross-app auto sign-in means anyone with an active
Casdoor session on the network completes app logins with no re-auth. This is the
intended trade-off for a trusted-VPN, single-user deployment. A specific app can
opt out by setting `enableSigninSession: false` in its SSOClient
`applicationOverrides`.
