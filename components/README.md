# Shared components

Optional pieces (VPN egress, tailnet membership, public exposure) that a user
picks in the install dialog. Each one lives here once, is published as its own
cosign-signed OCI artifact (`components/<name>`), and is composed into the app
in-cluster by a Flux ArtifactGenerator. Apps never carry a copy.

A component is a kustomize `kind: Component` plus a `component.yaml`
descriptor (version, `group`, `kind: patch | resource`, `settings`, `values`).

## Author rules

- **Patch targeting.** Patch components select the app's Deployment with
  `target.annotationSelector: librepod.org/component-target=true`; the patch's
  `metadata.name` is a placeholder. A sidecar container is named after the
  component (`gluetun`, `sing-box`, `tailscale`).
- **No namespaces, fixed names.** Resources omit `namespace:` and use fixed names
  (`tailscale-state`, `gluetun-settings`); the app namespace isolates them.
- **Version = native version.** `spec.version` equals the `images:` tag in
  `kustomization.yaml` (Renovate bumps both). Image-less components hand-bump a
  semver. A manifest-only change re-pushes the same tag.
- **Defaults on every variable.** Write `${VAR:=default}`; strict substitution
  must never fail a build. `INSTANCE_NAME` is always supplied by the installer.
  Reserved names: `BASE_DOMAIN`, `DEVICE_IP`, `INSTANCE_NAME`.
- **Secrets.** Settings go to OpenBao `apps/<app>/<component>`, delivered by the
  component's own ExternalSecret `<name>-settings`, never merged into the app's.
- **`from: install` values** need an anchored `pattern` (`^…$`); the server also
  restricts them to a safe charset.
- **`from: derived` values** are never asked: the installer fills the `default`
  template (`{OTHER_VALUE}` placeholders) from the component's other values.
- **Exposure contract.** A component in group `exposure` must provide
  `PUBLIC_HOST`, the public hostname the app is served at. Apps read only
  `${PUBLIC_HOST:=<local fallback>}`, so they never depend on how they are
  exposed (frp-expose today, another tunnel later).

## Opting an app in

Annotate exactly one Deployment (`librepod.org/component-target: "true"`) when
the app lists a `patch` component, then add to `metadata.yaml`:

```yaml
spec:
  components:
    - name: frp-expose
      values:            # every `from: app` value of the component
        FRP_EXPOSE_HOST: immich-server.immich.svc.cluster.local
        FRP_EXPOSE_PORT: "2283"
```

## Checking

`nix-shell shell.nix --run 'bash scripts/check-app-components.sh [<app>...]'`
validates every descriptor and builds each opted-in app with each of its
components (CI runs it in `validate-apps`).
