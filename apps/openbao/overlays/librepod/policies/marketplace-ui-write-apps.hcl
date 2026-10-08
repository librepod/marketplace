# marketplace-ui: provision/update app secrets under apps/, plus read for the
# install-time read-merge of already-generated values and the legacy secret
# mirror.
path "apps/data/*" {
  capabilities = ["create", "update", "read"]
}

path "apps/metadata/*" {
  capabilities = ["create", "update", "read", "list"]
}
