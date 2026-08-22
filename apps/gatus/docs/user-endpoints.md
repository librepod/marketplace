# Adding your own monitored endpoints

Gatus on LibrePod merges its configuration from every `*.yaml` file in its
config directory. The platform ships storage, SSO login, and two default
checks (the identity provider and gatus itself); **your endpoints live in a
ConfigMap you own in your user-apps repo**, and gatus picks them up
automatically — no restarts, no marketplace involvement.

## How to add endpoints

1. In your user-apps repo, create a ConfigMap named exactly
   `gatus-user-config` in namespace `gatus`. Each `*.yaml` data key is one
   config fragment (endpoint lists from all fragments are appended):

   ```yaml
   # apps/gatus-user/configmap.yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: gatus-user-config      # must be exactly this name
     namespace: gatus             # must be exactly this namespace
   data:
     endpoints.yaml: |            # any *.yaml key names work
       endpoints:
         - name: My website
           url: https://example.com
           interval: 1m
           conditions:
             - "[STATUS] == 200"
         - name: Nextcloud
           group: selfhosted
           url: https://cloud.example.com/status.php
           interval: 5m
           conditions:
             - "[STATUS] == 200"
   ```

2. Kustomize requires every directory listed in the root kustomization to
   have its own `kustomization.yaml` — create one next to the ConfigMap:

   ```yaml
   # apps/gatus-user/kustomization.yaml
   apiVersion: kustomize.config.k8s.io/v1beta1
   kind: Kustomization
   resources:
     - configmap.yaml
   ```

3. Reference the directory in your repo's root `kustomization.yaml`:

   ```yaml
   resources:
     - apps/gatus-user
   ```

4. Commit and push. Within a couple of minutes (Flux reconcile + volume
   sync) the endpoints appear on your dashboard — gatus hot-reloads.

## Rules and guardrails

- Fragments may contain `endpoints` (appended across fragments), and may
  also configure `alerting`, `ui`, `maintenance`, etc. (deep-merged).
- Platform keys (`storage`, `security`) are already defined by the
  platform — defining them in a fragment is a config conflict and the
  update is **skipped** (the old config keeps running; gatus logs why).
  (Nested *additions* under these keys — e.g. `security.oidc.allowed-subjects` —
  can still merge; conflicts fire only on keys defined twice.)
- A fragment with invalid YAML is likewise skipped, never crashes the
  pod: check the gatus logs for
  `The configuration file was updated, but it is not valid.`
- To remove your endpoints, delete the ConfigMap or empty its `data`.
  Kubernetes does not guarantee mounted files disappear promptly after a
  ConfigMap *deletion* — if your endpoints linger, restart the gatus pod.
  The platform defaults always remain.
- The fragment requires namespace `gatus` to exist: add `apps/gatus-user`
  only after gatus is installed, and remove it when you uninstall gatus —
  otherwise your user-apps repository stops reconciling.
- Full endpoint syntax (conditions, alerts, client config, groups):
  https://raw.githubusercontent.com/TwiN/gatus/master/README.md#endpoints
