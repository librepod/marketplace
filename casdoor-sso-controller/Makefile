CONTROLLER_GEN ?= $(shell pwd)/bin/controller-gen
CRD_DST        := ../apps/casdoor-sso-controller/base

# Install controller-gen to bin/ if missing
$(CONTROLLER_GEN):
	GOBIN=$(shell pwd)/bin go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.17.0

# Generate CRD + RBAC directly into the deployable app's base/
.PHONY: manifests
manifests: $(CONTROLLER_GEN)
	$(CONTROLLER_GEN) crd:generateEmbeddedObjectMeta=false rbac:roleName=manager-role paths="./..." \
		output:crd:artifacts:config=$(CRD_DST) \
		output:rbac:artifacts:config=$(CRD_DST)

.PHONY: test
test: generate envtest
	KUBEBUILDER_ASSETS="$(shell $(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(LOCALBIN) -p path)" go test ./... -count=1

.PHONY: build
build:
	go build -o bin/manager ./main.go

.PHONY: generate
generate: $(CONTROLLER_GEN)
	$(CONTROLLER_GEN) object paths="./..."

# envtest
LOCALBIN ?= $(shell pwd)/bin
ENVTEST ?= $(LOCALBIN)/setup-envtest
ENVTEST_K8S_VERSION ?= 1.30.0
envtest: ## Download setup-envtest locally if necessary.
	$(call go-get-tool,$(ENVTEST),sigs.k8s.io/controller-runtime/tools/setup-envtest@latest)

define go-get-tool
@[ -f "$(1)" ] || { set -e ; echo "Downloading $(2)" ; GOBIN=$(LOCALBIN) go install $(2) ; }
endef
