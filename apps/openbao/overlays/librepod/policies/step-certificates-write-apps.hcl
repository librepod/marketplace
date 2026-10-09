# step-certificates bootstrap Job: publishes the LibrePod public CA (root +
# intermediate certificates — no private keys) into KV at apps/step-ca for
# ExternalSecret distribution to consumer namespaces. Write-only, this one
# path; read/list stays with eso-read-apps.
path "apps/data/step-ca" {
  capabilities = ["create", "update"]
}
