---
card: t_ce5a705b
stage: intent
status: accepted
app: jellyfin
created: 2026-10-19
accepted: 2026-10-20
next: sdlc/t_ce5a705b/spec.md (card t_43b7c637)
---

# Intent: add Jellyfin to marketplace

Requested by: Alex (maintainer), 2026-10-19. Accepted 2026-10-20 (board
comment, quoted under "Acceptance" below).

## Problem

The marketplace has no media-server app. Media streaming is the most
requested missing category for the RU-first audience — photos are already
covered (Immich), streaming is not covered at all.

## Outcome

Jellyfin is installable one-click from the marketplace UI on the dev
cluster and passes the full verify-app e2e suite.

## Constraints

- Follow the librepod-app skill conventions (metadata.yaml, base/overlay,
  IngressRoute, SSO decision).
- No new cluster dependencies beyond what system apps already provide.
- Media directories follow the hostPath convention of existing media apps.

## Open questions → resolved at acceptance

1. Transcoding (/dev/dri passthrough) in v1 or deferred?
   **Resolved:** no preference now; decision deferred to PR comments and
   review.
2. RU localization of the app description at add-time?
   **Resolved:** no — nothing beyond software installation; localization
   is the vendor's responsibility, not ours.

## Acceptance (board comment, 2026-10-20)

> Intent is good. With regards to russian localisation - no need to
> implement anything that goes beyond software installation. The vendor
> should take care of localisation, not us. No preference for
> transcoding as of now. We can leave this decision for the PR comments
> and review.

## Next stage

Spec pass: `sdlc/t_ce5a705b/spec.md` — app slug, metadata.yaml shape,
base/overlay structure, IngressRoute host, SSO decision (Jellyfin has
native auth; likely no SSO), storage/hostPath media dirs, resource
limits, image tag policy, RU description draft (informational only, per
acceptance). Concerns flagged inline for Alex. Gate: Alex approves spec
→ promote plan card.
