---
name: casdoor-export
description: Use when exporting or backing up Casdoor SSO configuration from the librepod cluster into the repo's init_data.json (e.g. after making changes via the Casdoor UI).
---

# Casdoor Export

Exports Casdoor SSO configuration from the running cluster to the repository's init_data.json file.

## Context

- **Namespace**: `casdoor`
- **Kubeconfig**: `~/.kube/librepod-dev.config` (symlink into the `librepod-devices` repo; sibling `librepod-*.config` links are production devices)
- **Server binary**: `/server` inside the container
- **Init data file**: `apps/casdoor/overlays/librepod/init_data.json` (repository path)

## When to Use

Use after making changes via the Casdoor web UI when you want to persist configuration for cluster bootstrapping.

## Steps

1. Find the casdoor pod:
   ```bash
   kubectl --kubeconfig ~/.kube/librepod-dev.config get pods -n casdoor -o name
   ```

2. Run the export command inside the pod:
   ```bash
   kubectl --kubeconfig ~/.kube/librepod-dev.config exec -n casdoor <pod-name> -- /server -export -exportPath /tmp/casdoor_export.json
   ```

3. Copy the exported file from the pod:
   ```bash
   kubectl --kubeconfig ~/.kube/librepod-dev.config cp casdoor/<pod-name>:/tmp/casdoor_export.json ./apps/casdoor/overlays/librepod/init_data.json
   ```

4. Clean up the temp file in the pod:
   ```bash
   kubectl --kubeconfig ~/.kube/librepod-dev.config exec -n casdoor <pod-name> -- rm /tmp/casdoor_export.json
   ```

**Output:** The `apps/casdoor/overlays/librepod/init_data.json` file is updated with the current Casdoor configuration.

## Common Patterns

### Pod name retrieval

Since pod names include random suffixes, always retrieve the current pod name dynamically:
```bash
POD=$(kubectl --kubeconfig ~/.kube/librepod-dev.config get pods -n casdoor -o jsonpath='{.items[0].metadata.name}')
```

Then use `$POD` in subsequent commands.

## Notes

- The init_data.json file is version controlled in git, so no separate backup is needed
- The export operation is non-destructive - it reads from the database and outputs JSON
- Multiple replicas: if there are multiple casdoor pods, any one can be used for export (they share the same database)
