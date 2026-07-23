package v1alpha1

import (
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// SSOClientSpec defines the desired Casdoor OIDC Application.
// +kubebuilder:object:generate=true
type SSOClientSpec struct {
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="clientId is immutable once set"
	ClientID      string          `json:"clientId"`
	Organization  string          `json:"organization,omitempty"`
	RedirectUris  []string        `json:"redirectUris"`
	Scopes        []string        `json:"scopes,omitempty"`
	GrantTypes    []string        `json:"grantTypes,omitempty"`
	TokenFormat   string          `json:"tokenFormat,omitempty"`
	ExpireInHours int             `json:"expireInHours,omitempty"`
	Output        SSOClientOutput `json:"output,omitempty"`
	// CasdoorPolicy is "retain" (default) or "delete" on CR deletion.
	// +kubebuilder:validation:Enum=retain;delete
	CasdoorPolicy string `json:"casdoorPolicy,omitempty"`
	// ApplicationOverrides is a free-form JSON object shallow-merged onto the
	// Casdoor Application at provision time. Use it for Casdoor Application
	// properties the CR does not model explicitly — branding and display fields
	// such as logo, favicon, headerHtml, footerHtml, formOffset, themeData,
	// formBackgroundUrl. New Casdoor properties can be configured per SSOClient
	// by adding a key here, WITHOUT a CRD schema change or a controller release.
	//
	// Controller-managed keys are protected and silently ignored if present:
	// name, clientId, clientSecret, organization, redirectUris, grantTypes,
	// tokenFormat, expireInHours, enableSignUp, displayName, title. The
	// controller stamps those last, so platform policy (e.g. enableSignUp=false)
	// and identity cannot be bypassed via an override.
	//
	// Values are passed through verbatim; Casdoor validates them on apply and any
	// error surfaces as a Failed phase. Nested objects/arrays replace the whole
	// field (shallow merge, not deep merge).
	// +optional
	ApplicationOverrides *apiextensionsv1.JSON `json:"applicationOverrides,omitempty"`
}

// +kubebuilder:object:generate=true
type SSOClientOutput struct {
	SecretName      string        `json:"secretName,omitempty"`
	SecretNamespace string        `json:"secretNamespace,omitempty"`
	Keys            SSOClientKeys `json:"keys,omitempty"`
}

// +kubebuilder:object:generate=true
type SSOClientKeys struct {
	ClientID     string `json:"clientId,omitempty"`
	ClientSecret string `json:"clientSecret,omitempty"`
	Issuer       string `json:"issuer,omitempty"`
}

// +kubebuilder:object:generate=true
type SSOClientStatus struct {
	// +kubebuilder:validation:Enum=Pending;Provisioning;Ready;Failed
	Phase              string             `json:"phase,omitempty"`
	ClientID           string             `json:"clientId,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	LastReconcileTime  *metav1.Time       `json:"lastReconcileTime,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=ssoc
// +kubebuilder:storageversion
type SSOClient struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              SSOClientSpec   `json:"spec,omitempty"`
	Status            SSOClientStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type SSOClientList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []SSOClient `json:"items"`
}
