# marketplace-ui: first-run onboarding state in system/ (regular apps never see
# system/ — eso-read-apps reads apps/* only).
#   system/marketplace-ui/*  the onboarding record: state, setup code, generation
#   system/admin             Casdoor's machine-generated admin password, stored readable by design
#                            (LibrePod is a trusted perimeter)
path "system/data/marketplace-ui/*" {
  capabilities = ["create", "update", "read"]
}

path "system/data/admin" {
  capabilities = ["create", "update", "read"]
}
