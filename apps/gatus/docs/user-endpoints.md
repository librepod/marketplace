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

2. Reference the file in your repo's root `kustomization.yaml`:

   ```yaml
   resources:
     - apps/gatus-user
   ```

3. Commit and push. Within a couple of minutes (Flux reconcile + volume
   sync) the endpoints appear on your dashboard — gatus hot-reloads.

## Rules and guardrails

- Fragments may contain `endpoints` (appended across fragments), and may
  also configure `alerting`, `ui`, `maintenance`, etc. (deep-merged).
- Platform keys (`storage`, `security`) are already defined by the
  platform — defining them in a fragment is a config conflict and the
  update is **skipped** (the old config keeps running; gatus logs why).
- A fragment with invalid YAML is likewise skipped, never crashes the
  pod: check the gatus logs for
  `The configuration file was updated, but it is not valid.`
- Deleting the ConfigMap removes your endpoints; the platform defaults
  remain.
- Full endpoint syntax (conditions, alerts, client config, groups):
  https://raw.githubusercontent.com/TwiN/gatus/master/README.md#endpoints
