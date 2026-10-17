# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: a non-sysadmin self-hosting owner ("I want to self-host apps, but I don't want
to be a system administrator"). First meets the product right after flashing a device,
on their own LAN, with no DNS for `*.libre.pod` — reaching the UI over a raw IP like
`http://192.168.x.y`, possibly on a phone. Not assumed to know Kubernetes, Flux,
certificates, or WireGuard.

## Product Purpose

LibrePod marketplace UI: browse a catalog of pre-configured apps and install/uninstall
them one-click on the user's own cluster via GitOps. Success for first-run: the owner
goes from raw-IP access to a claimed device with SSO login, a working WireGuard tunnel
that resolves `*.libre.pod`, and trusted HTTPS — without opening a shell.

## Positioning

Zero-config self-hosting: SSO, a private WireGuard VPN that carries DNS, and a private
CA arrive working out of the box; the device claims itself in a browser wizard — no
Docker knowledge, no env vars, no manual volume mounts.

## Operating Context

- Fresh boot: system apps converge over several minutes (storage → traefik →
  cert-manager → gogs/casdoor/wg-easy); the UI must tolerate partial availability.
- Before onboarding: the browser reaches only `http://<device-IP>` (marketplace-ui
  serves the raw IP); `*.libre.pod` does not resolve for the user's devices.
- WireGuard is the DNS unlock (confirmed): wg-easy client configs hand out the device
  as DNS, so a connected tunnel resolves all `*.libre.pod` names.
- After onboarding: access is `https://<name>.<baseDomain>` through the tunnel.
  `BASE_DOMAIN` is cluster-configured (default `libre.pod`), exposed via `/api/config`;
  the tour adapts copy to it rather than offering a domain picker.
- The pod's network ≠ the browser's network: the server reaches `id.<domain>`, wg-easy,
  and the root CA in-cluster while the browser cannot resolve them yet.

## Capabilities and Constraints

- Auth: OIDC via Casdoor (`id.<domain>`) + stateless HMAC session cookie (secure-only)
  — cannot work over plain-HTTP raw IP by design; onboarding must not attempt SSO
  over IP, and the AuthGate redirect chain must never fire for an un-onboarded or
  IP-bound visitor.
- First-admin mechanism (confirmed): Casdoor ships with its built-in default admin
  credential; onboarding creates a single fixed owner — `admin` in org `librepod`,
  `admin@<base-domain>`, password-only claim — then randomizes the built-in admin's
  password. The bootstrap window IS the factory credential's validity — no marker
  state. wg-easy has no SSO, so the SAME chosen password is adopted there
  (persisted to a cluster Secret; a later Casdoor password change does not
  propagate to wg-easy).
- First-run gate (confirmed): open claim window on the LAN that closes when onboarding
  completes (Synology/TrueNAS first-boot model). Claim race accepted.
- Tour scope (confirmed): owner-only; full-service wizard (server proxies the wg-easy
  API and serves the CA from the pod-mounted cert file); ends at "graduation" —
  redirect to the domain + first SSO login as the new owner. Multi-user management is
  a later product feature (Users control-panel placeholder exists in the shell).
- Only marketplace-ui serves on the raw device IP; other apps' UIs are unreachable
  mid-tour, so the wizard cannot hand off to them.

## Brand Commitments

Name: LibrePod. Dark mode is forced. shadcn-style component system on Tailwind v4
tokens, Geist Variable, monochrome neutral scale.

## Product Principles

1. Proxy, don't redirect: when the browser can't reach a service, the server does it
   on its behalf over cluster-internal DNS.
2. Cluster truth is the wizard's state: derive step completion from live services,
   never from wizard-local storage.
3. First-run has exactly one hero — the owner — and the tour ends.
4. The raw IP is scaffolding: every step exists to graduate the user onto named,
   trusted, tunneled access.
5. Fail visible, not fatal: partial convergence presents as "waking up," never as a
   dead SSO redirect.

## Evidence on Hand

- Implementation: `ui/packages/{client,server,shared}` (NestJS 11, React 19, Tailwind
  v4/shadcn); auth flow in `packages/server/src/auth/`, `AuthGate` in the client.
- Root CA already mounted in the marketplace-ui pod
  (`apps/marketplace-ui/overlays/librepod/deployment-auth-patch.yaml`).
- Raw-IP serving for fresh clusters shipped (marketplace repo master, 2026-08).
