# gogs publish-auth Job: pushes the committed user-apps source credential (the
# flux account) into KV at apps/user-apps-source for ExternalSecret
# distribution to consumer namespaces (flux-system, marketplace-ui).
# Write-only, this one path; read/list stays with eso-read-apps.
path "apps/data/user-apps-source" {
  capabilities = ["create", "update"]
}
