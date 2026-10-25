# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: a non-sysadmin self-hosting owner ("I want to self-host apps, but I don't want
to be a system administrator"). First meets the product right after a fresh install,
reaching the UI over a raw IP — `http://192.168.x.y` on a home LAN, or a public IP on a
cloud server — possibly on a phone. Not assumed to know Kubernetes, Flux, certificates or
WireGuard; setup starts with a code read from the device's log, so someone with access to
the machine is involved once.

## Product Purpose

LibrePod marketplace UI: browse a catalog of pre-configured apps and install/uninstall
them one-click on the user's own cluster via GitOps. Success for first-run: the owner goes
from `http://<ip>` to a claimed device, a personal account, a trusted root CA, working
connectivity (WireGuard or their own), and the first SSO sign-in at `https://<base-domain>`.

## Positioning

Zero-config self-hosting: SSO, a private CA and an optional WireGuard VPN that carries DNS
arrive working out of the box; the device is claimed in a browser wizard with a setup code —
no Docker knowledge, no env vars, no manual volume mounts.

## Operating Context

- Fresh boot: system apps converge over several minutes; the UI tolerates partial
  availability ("waking up" while OpenBao or Casdoor isn't answering).
- Before onboarding finishes: the raw IP serves the wizard; `*.<base-domain>` does not
  resolve for the user's devices.
- One flow for every environment — a home device, a cloud VM with a public IP, a VM on a
  shared corporate network, any Kubernetes cluster. The setup code is the only gate.
- WireGuard is the default DNS unlock (its client configs hand out the device as DNS);
  "I'll bring my own" covers Tailscale/Headscale, tunnels and own DNS.
- After onboarding: access is `https://<name>.<baseDomain>`; the raw IP only points to the
  domain.
- The pod's network ≠ the browser's network: the server reaches Casdoor, wg-easy and the
  root CA in-cluster while the browser cannot resolve them yet.

## Capabilities and Constraints

- Auth: OIDC via Casdoor + stateless HMAC session cookie (Secure) — cannot work over
  plain-HTTP raw IP by design; the wizard never attempts SSO over IP, and the AuthGate
  redirect chain must never fire for an un-onboarded or IP-bound visitor.
- Proof of ownership: a 12-character setup code marketplace-ui creates on first start and
  prints to its log. Claiming needs it (and nothing else), so does continuing in another
  browser, and it dies when onboarding finishes; `reset-onboarding` issues a new one.
  `reset-onboarding` gives a new setup code and reopens the wizard. It keeps your account, apps, app data, VPN peers and every machine credential. To recover a forgotten password: run it, enter the new code, keep your username, and set a new password.
- Identities: the owner's SSO account is the only human credential. Casdoor's built-in
  `admin` password is machine-generated, stored readable in OpenBao `system/admin` and kept
  in sync at every marketplace-ui start; apps that ship an admin generate their own. The
  owner creates a personal account (`<name>@<base-domain>`) for daily SSO, and it joins
  the Casdoor group `librepod/admins`.
- The first SSO sign-in at the domain finishes onboarding. Until then the wizard is the
  only way in; there is no "set up later".
- State is durable: one OpenBao record. Live service state (peers, handshakes) only drives
  the screens, never access.
- Only marketplace-ui serves on the raw device IP; other apps' UIs are unreachable
  mid-wizard, so the wizard cannot hand off to them.

## Brand Commitments

Name: LibrePod. Dark mode is forced. shadcn-style component system on Tailwind v4
tokens, Geist Variable, monochrome neutral scale.

## Product Principles

1. Proxy, don't redirect: when the browser can't reach a service, the server does it on
   its behalf over cluster-internal DNS.
2. Cluster truth is the wizard's state: derive steps from the onboarding record and live
   services, never from wizard-local storage.
3. First-run has exactly one hero — the owner — and it ends with their first sign-in.
4. The raw IP is scaffolding: every step exists to graduate the user onto named, trusted
   access.
5. Fail visible, not fatal: partial convergence presents as "waking up," never as a dead
   SSO redirect.

## Evidence on Hand

- Implementation: `ui/packages/{client,server,shared}` (NestJS 11, React 19, Tailwind
  v4/shadcn); onboarding in `packages/server/src/onboarding/` and
  `packages/client/src/pages/onboarding/`; design in
  `docs/superpowers/specs/2026-10-14-onboarding-setup-code-design.md`.
- Root CA mounted in the marketplace-ui pod
  (`apps/marketplace-ui/overlays/librepod/deployment-auth-patch.yaml`).
