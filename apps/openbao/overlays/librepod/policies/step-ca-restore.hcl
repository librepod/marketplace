# step-ca CA restore: the step-certificates Deployment (ServiceAccount
# step-ca-restore, kubernetes-auth role step-ca-restore) reads the CA backup
# at system/step-ca when its PVC turns up empty, restoring the CA instead
# of minting a new one (which would silently break every device that
# trusts the old root). Read-only, this one path.
path "system/data/step-ca" {
  capabilities = ["read"]
}
