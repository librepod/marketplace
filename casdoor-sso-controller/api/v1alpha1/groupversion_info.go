// Package v1alpha1 contains API Schema definitions for the marketplace v1alpha1 API group.
// +groupName=marketplace.librepod.org
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	GroupVersion  = schema.GroupVersion{Group: "marketplace.librepod.org", Version: "v1alpha1"}
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}
	AddToScheme   = SchemeBuilder.AddToScheme
)

func init() {
	SchemeBuilder.Register(&SSOClient{}, &SSOClientList{})
}
