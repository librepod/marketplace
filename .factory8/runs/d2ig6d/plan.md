# Plan: remnawave-admin — shared tailscale component on web-backend (issue #386)

Wire the shared tailscale component into `apps/remnawave-admin` exactly the way
`apps/remnawave` already has it, so the node-agent feature works on this tailnet:
agents deployed on Remnawave nodes (`tag:remnawave-node`, ACL default-deny) get a
tag-scoped tailnet path to the collector that only web-backend serves
(`POST /api/v2/collector/*`, WebSocket `/api/v2/agent/ws`, `:8081`).

Mechanics (already built, nothing new to invent): `spec.components` in
`metadata.yaml` is the marketplace opt-in; the installer composes
`shared-components/tailscale` into the app's overlay in-cluster. The component's
kustomize patch selects the Deployment annotated `librepod.org/component-target: "true"`
and injects the sidecar, the `tailscale-state` PVC, the `tailscale-settings`
ExternalSecret (OpenBao `apps/<instance>/tailscale`), and the MagicDNS-first
dnsConfig. The repo-side contract is therefore two lines plus a doc note.

## Files that change

1. **`apps/remnawave-admin/metadata.yaml`** — add between `settings` and
   `dependencies` (where `apps/remnawave/metadata.yaml` carries it):

   ```yaml
   components:
     - name: tailscale
   ```

   No `values:` override: the component's `TS_HOSTNAME` default `{app}` already
   yields `remnawave-admin` — the hostname the issue wants (collie pins
   `collie-lead` only because its name isn't a legal tailnet hostname choice).

2. **`apps/remnawave-admin/base/deployment-web-backend.yaml`** — the Deployment
   has no `annotations` block today; add one (mirrors
   `apps/remnawave/base/deployment.yaml:6`):

   ```yaml
   metadata:
     name: remnawave-admin-web-backend
     annotations:
       librepod.org/component-target: "true"
   ```

   Only this Deployment: bot and frontend need no tailnet identity, and
   `scripts/check-app-components.sh` enforces *exactly one* annotated Deployment
   per app composed with a `kind: patch` component — annotating anything else
   breaks the gate.

3. **`apps/remnawave-admin/docs/post-install.md`** — extend "4. Node agents
   (optional)" with the tailnet option, per the issue's note that the tag is
   consumer-side:
   - agent `AGENT_COLLECTOR_URL` alternative: `http://remnawave-admin.ts.<your-domain>:8081`
     (MagicDNS suffix is `ts.<BASE_DOMAIN>`, matching the doc's `<your-domain>` style);
   - the backend must advertise `tag:remnawave-admin` — either TS_EXTRA_ARGS
     `--advertise-tags=tag:remnawave-admin` (Apps → remnawave-admin → component
     settings) or a pre-tagged headscale preauth key;
   - headscale ACLs (DB-mode policy managed in Headplane, not this repo) need a
     tag-scoped dst, e.g. `tag:remnawave-node → tag:remnawave-admin:8081` — ACL
     dsts cannot use FQDNs, which is why the tag has to be on the deployment.

Explicitly **not** changing:
- `spec.version` in metadata.yaml — no app version bumps; app changes ship as
  rolling re-pushes of the current tags (`5.2.1` + digest pins).
- `catalog.yaml` — CI-owned via `generate-catalog.sh`; never committed.
- `components/tailscale/*` — the shared component is untouched; the tag is
  expressed through its existing settings surface.
- `apps/remnawave-admin/overlays/librepod/kustomization.yaml` — the repo overlay
  never lists the shared component; the installer adds it at install time
  (`check-app-components.sh` simulates exactly this).
- headscale config — ACL policy lives in the headscale DB (Headplane), out of
  repo scope; documented in the post-install note instead.

## Order of work

1. `metadata.yaml`: add the `components:` block.
2. `base/deployment-web-backend.yaml`: add the annotation.
3. `docs/post-install.md`: extend the node-agents section.
4. Validate locally (needs `yq` + `kustomize` from `nix-shell shell.nix`):
   `nix-shell shell.nix --run 'bash scripts/check-app-components.sh remnawave-admin'`
   — must print `OK`. This composes the component into a throwaway copy of the
   overlay the same way the installer does and asserts: baseline overlay builds,
   exactly one annotated Deployment, and a `tailscale` container on it afterwards.
5. Commit on the run branch, push, open the PR with `Fixes #386`. CI reruns the
   same check (`validate-apps.yaml`) and `publish-apps.yaml` pushes a `pr-<n>`
   app artifact, commented on the PR, for on-cluster verification.
6. On-cluster proof (below) is the operator's merge gate; the run ends at the PR.

## Risks

- **Pod DNS changes for web-backend.** The component patch sets `dnsPolicy: None`
  with MagicDNS first, CoreDNS second, and a search list headed
  `${INSTANCE_NAME}.svc.cluster.local`. The backend resolves postgres by short
  name (`remnawave-admin-db`) and the panel by FQDN (`API_BASE_URL`); both keep
  resolving while namespace == INSTANCE_NAME (true for every app today — the
  remnawave panel already runs under this exact assumption). A short-name miss
  costs a few fast NXDOMAINs before fallthrough (`timeout 1`, `attempts 2`).
- **Install gains a hard tailnet dependency.** containerboot's startup probe
  keeps the pod unready until the node holds a tailnet IP: a wrong TS_AUTHKEY or
  login server surfaces as a visibly failed install. By design; same as remnawave.
- **Tags apply at first login only.** `TS_AUTH_ONCE=true` means
  `--advertise-tags=…` in TS_EXTRA_ARGS takes effect when the node first joins;
  adding the tag to an already-enrolled node needs re-enrollment (delete the node
  in headscale or wipe `tailscale-state`). Fresh installs are unaffected. #260 /
  #287 track the remaining auth-key/state quirks and do not block this.
- **Agents stay unreachable until the operator adds the ACL dst rule** in
  Headplane — default-deny is the starting state. The repo can only document it;
  the curl check below is the proof it was done.
- **New namespace resources**: `tailscale-state` PVC (nfs-client, 1Gi) and the
  `tailscale-settings` ExternalSecret. The PVC-backed identity is what makes
  reinstalls reuse the same tailnet name/IP — the component's designed behavior.

## Proof

- Local gate: `nix-shell shell.nix --run 'bash scripts/check-app-components.sh remnawave-admin'`
  prints `OK` (run it also with no args — all apps — as CI does).
- CI: `validate-apps.yaml` green on the PR; `publish-apps.yaml` comments the
  `pr-<n>` artifact ref on the PR for cluster testing
  (`flux reconcile source oci <name> --tag pr-<n>`).
- On-cluster, after install/update with the component:
  - `kubectl -n remnawave-admin get pods -l app.kubernetes.io/component=web-backend
    -o jsonpath='{.items[0].spec.containers[*].name}'` → `remnawave-admin-web-backend tailscale`;
  - sidecar `tailscale status` shows hostname `remnawave-admin` carrying
    `tag:remnawave-admin`;
  - from a `tag:remnawave-node` host, once the ACL dst exists:
    `curl http://remnawave-admin.ts.<your-domain>:8081/api/v2/health` answers;
  - the panel's Servers → Panel nodes view shows the agent connected
    (WebSocket `/api/v2/agent/ws`), with host metrics and access-log connections
    flowing — the actual feature the issue is asking to unblock.
