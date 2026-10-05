# marketplace-ui: provision/update app secrets under apps/, without read
# access (write-only provisioning).
path "apps/data/*" {
  capabilities = ["create", "update"]
}

path "apps/metadata/*" {
  capabilities = ["create", "update", "read", "list"]
}
