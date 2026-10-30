# ColliePWA (`collie`)

Runs the [ColliePWA](https://colliepwa.dev) ([source](https://github.com/AltanS/collie))
crew **lead**: one always-on URL, `https://collie.<BASE_DOMAIN>`, from which a
phone drives the AI agents on your crew members (machines running `collie` as
crew members). The lead reaches the members over your tailnet.

The image, `ghcr.io/cyxou/collie-lead`, is built from each upstream collie
release; its tag is the collie version.

## How it is wired

- **Front door**: traefik, SSO-gated by the oauth2-proxy forward-auth
  middlewares. `/auth` (the PWA's "Sign in" link) redirects to oauth2-proxy's
  sign-in. Every `/api` route but `/api/health` and `/api/pair` also needs a
  paired device, reads included. Never expose the lead with `tailscale funnel`.
- **Tailscale sidecar** (the shared `tailscale` component, picked in the
  install dialog): joins the pod to your
  tailnet, giving the lead egress to the members and an address members join
  at. The node identity is `tailscaled.state` on the component's `tailscale-state` volume
  (containerboot runs with `TS_KUBE_SECRET=""`), so the lead keeps its tailnet
  address across restarts (a reinstall gets a new state volume and enrols again). The sidecar logs in
  with `TS_AUTHKEY` only when that state can't (`TS_AUTH_ONCE=true`): Headscale
  0.28 enrols a new node whenever a tags-only pre-auth key is presented again.
- **State**: the PVC `collie-data` (crew trust store, device pairings,
  push keys). Losing it means every
  member re-runs `collie crew join` and every phone re-pairs. Losing the
  tailscale volume makes the lead join the tailnet as a new node: delete the old node on the control server first,
  or the new one gets a suffixed name (`collie-lead-<random>`) and
  `COLLIE_PUBLIC_URL` points at the dead node.

## Install settings

| Setting | Purpose |
|---|---|
| `COLLIE_PUBLIC_URL` | The address crew members join at (`http://<lead tailnet name or IP>:8787`). |

The tailnet settings (auth key, extra `tailscale up` flags, hostname) belong to
the shared `tailscale` component and appear under Components in the install
dialog; the hostname defaults to `collie-lead`.

**Migrating an existing install:** reinstall with the tailscale component
selected. Its state volume is new, so the node enrols again and needs a fresh
auth key. Delete the old `collie-lead` node on the control server first, or the
new one gets a suffixed name and `COLLIE_PUBLIC_URL` breaks.

`COLLIE_PUBLIC_HOSTS` is deliberately not a setting. The public hostname needs
no entry (collie accepts the host of every `COLLIE_ALLOWED_ORIGINS` entry, which
the app sets), crew traffic never checks it, and a tailnet host listed there
would serve the PWA on the tailnet, where no SSO applies.

## Tailnet access

The sidecar shares the pod's network namespace, so any tailnet peer that can
reach the lead's port 8787 gets past the NetworkPolicy and the SSO middlewares.
Crew members need that port: they call the lead's `/crew/v1/*` there. Any other
peer meets only collie's device pairing. In the tailnet policy, allow
`tcp:8787` on the lead from the crew members' machines and nothing else (syntax
for Tailscale and Headscale: upstream's
[deployment guide](https://github.com/AltanS/collie/blob/main/docs/deployment.md#tailscale-acls-mandatory)).

## Operating the lead

Membership changes "restart the bridge" by killing PID 1, which is unreliable
in a container; follow each one with a rollout restart instead.

```bash
# Invite a member (single-use token, valid 10 minutes), then restart the lead
kubectl -n collie exec deploy/collie -- collie crew invite --plain
kubectl -n collie rollout restart deploy/collie

# On the member: join at COLLIE_PUBLIC_URL, then restart its bridge
echo <token> | collie crew join http://<lead tailnet address>:8787 --insecure -

# Restart the lead again after the first join so it reloads the roster
kubectl -n collie rollout restart deploy/collie
kubectl -n collie exec deploy/collie -- collie crew status --plain

# Pair a phone (prints a code + QR; enter it under Settings → Paired devices)
kubectl -n collie exec -it deploy/collie -- collie pair

# Web push
kubectl -n collie exec deploy/collie -- collie push-keys
kubectl -n collie exec deploy/collie -- collie push-test
```

## Updates

Each new image tag reaches the catalog through a Renovate PR. Once it is
merged, an installed lead follows within about ten minutes: its source tracks
every version at or above the one it was installed at, up to the next major. A
new major version reaches a lead only by reinstalling. Crew members are updated
separately, on their own machines.
