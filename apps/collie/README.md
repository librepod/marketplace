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
  sign-in. Writes are additionally gated by collie's device pairing. Never
  expose the lead with `tailscale funnel`.
- **Tailscale sidecar** (`components/tailscale`): joins the pod to your
  tailnet, giving the lead egress to the members and an address members join
  at.
- **State**: the PVC `collie-lead-state` (crew trust store, device pairings,
  push keys, the sidecar's state dir) and the Secret `collie-tailscale-state`
  (the lead's tailnet identity, created on first start). Uninstalling deletes
  the namespace and with it the Secret, so a reinstalled lead joins the
  tailnet as a new node with a new address and members re-join. (The volume's
  data is retained by the storage class.)

## Install settings

| Setting | Purpose |
|---|---|
| `TS_AUTHKEY` | Pre-auth key that joins the lead to the tailnet on first start. |
| `TS_EXTRA_ARGS` | Extra `tailscale up` flags, e.g. `--login-server=https://headscale.example.com` for a Headscale tailnet. |
| `COLLIE_PUBLIC_URL` | The address crew members join at (`http://<lead tailnet name or IP>:8787`). |
| `COLLIE_PUBLIC_HOSTS` | Comma-separated `host:port` values members reach the lead at; must include the host of `COLLIE_PUBLIC_URL`. |

The public hostname needs no `COLLIE_PUBLIC_HOSTS` entry: collie accepts the
host of every `COLLIE_ALLOWED_ORIGINS` entry, which the app sets.

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
every version at or above the one it was installed at. Crew members are
updated separately, on their own machines.
