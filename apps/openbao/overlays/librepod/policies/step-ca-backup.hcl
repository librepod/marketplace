# step-ca CA backup at system/step-ca: the full CA material (public certs,
# private keys, ca.json/defaults.json, both passwords) written wholesale by
# the step-certificates bootstrap Job (kubernetes-auth role
# step-certificates). Separate engine from apps/ on purpose: eso-read-apps
# grants read on apps/* only, so regular apps cannot reach the private keys.
# The read side (CA restore on an empty PVC) is step-ca-restore.hcl.
path "system/data/step-ca" {
  capabilities = ["create", "update"]
}
