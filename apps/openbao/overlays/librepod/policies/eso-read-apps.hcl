# External Secrets Operator: read-only access to the apps/ KV v2 engine.
path "apps/data/*" {
  capabilities = ["read"]
}

path "apps/metadata/*" {
  capabilities = ["read", "list"]
}
