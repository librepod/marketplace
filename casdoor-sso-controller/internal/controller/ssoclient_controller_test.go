package controller

import (
	"context"
	"fmt"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/rand"
	"k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	marketplacev1alpha1 "github.com/librepod/casdoor-sso-controller/api/v1alpha1"
	"github.com/librepod/casdoor-sso-controller/internal/casdoor"
	"github.com/librepod/casdoor-sso-controller/internal/template"
)

// makeCR builds a minimal SSOClient for tests. RedirectUris intentionally
// include ${BASE_DOMAIN} so the reconciler's ResolveRedirects step is exercised.
func makeCR(name, clientID, ns string) *marketplacev1alpha1.SSOClient {
	return &marketplacev1alpha1.SSOClient{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: marketplacev1alpha1.SSOClientSpec{
			ClientID:     clientID,
			RedirectUris: []string{"https://" + clientID + ".${BASE_DOMAIN}/cb"},
		},
	}
}

func newNS() string { return "ns-" + rand.String(5) }

var _ = Describe("SSOClient controller", func() {
	var (
		fake *casdoor.FakeClient
		r    *SSOClientReconciler
	)

	BeforeEach(func() {
		fake = casdoor.NewFake()
		r = &SSOClientReconciler{
			Client:     k8sClient,
			Scheme:     scheme.Scheme,
			Casdoor:    fake,
			BaseDomain: "libre.pod",
			Org:        "librepod",
		}
	})

	Describe("create path", func() {
		It("creates the Casdoor app and writes the secret", func() {
			ctx := context.Background()
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())

			cr := makeCR("headscale-sso", "headscale", ns)
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())

			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "headscale-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())

			Expect(fake.AddCalls).To(Equal(1))
			Expect(fake.Apps).To(HaveKey("headscale"))

			sec := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "headscale-sso", Namespace: ns}, sec)).To(Succeed())
			Expect(sec.Data).To(HaveKey("OIDC_CLIENT_ID"))
			Expect(sec.Data).To(HaveKey("OIDC_CLIENT_SECRET"))
			Expect(sec.Data).To(HaveKey("OIDC_ISSUER"))
			Expect(sec.Labels["marketplace.librepod.org/sso-managed"]).To(Equal("true"))
		})

		It("preserves manually-added extra Secret keys across reconcile", func() {
			ctx := context.Background()
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := makeCR("extra-sso", "extra", ns)
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			// Pre-create the Secret with an extra key the controller does not manage.
			Expect(k8sClient.Create(ctx, &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "extra-sso", Namespace: ns, Labels: map[string]string{managedLabelKey: "true"}},
				Data:       map[string][]byte{"OAUTH_MTLS_CERT": []byte("certdata")},
			})).To(Succeed())
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "extra-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			sec := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "extra-sso", Namespace: ns}, sec)).To(Succeed())
			Expect(sec.Data).To(HaveKey("OAUTH_MTLS_CERT"))
			Expect(string(sec.Data["OAUTH_MTLS_CERT"])).To(Equal("certdata"))
			Expect(sec.Data).To(HaveKey("OIDC_CLIENT_ID"))
		})

		It("does not clobber a concurrent metadata change when adding the finalizer", func() {
			ctx := context.Background()
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := makeCR("patch-sso", "patch", ns)
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			// Add a label server-side after creation, simulating a concurrent writer.
			got := &marketplacev1alpha1.SSOClient{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "patch-sso", Namespace: ns}, got)).To(Succeed())
			got.Labels = map[string]string{"external": "true"}
			Expect(k8sClient.Update(ctx, got)).To(Succeed())
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "patch-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "patch-sso", Namespace: ns}, got)).To(Succeed())
			Expect(got.Labels["external"]).To(Equal("true"), "concurrent label must survive finalizer add")
			Expect(controllerutil.ContainsFinalizer(got, finalizerName)).To(BeTrue())
		})
	})

	Describe("idempotency", func() {
		It("does not recreate the app on a second reconcile, reaches Ready, and owns the Secret", func() {
			ctx := context.Background()
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())

			cr := makeCR("headscale2-sso", "headscale2", ns)
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())

			req := reconcile.Request{NamespacedName: types.NamespacedName{Name: "headscale2-sso", Namespace: ns}}
			_, err := r.Reconcile(ctx, req)
			Expect(err).NotTo(HaveOccurred())
			_, err = r.Reconcile(ctx, req)
			Expect(err).NotTo(HaveOccurred())

			// Get-before-create: exactly one AddApplication across two reconciles.
			Expect(fake.AddCalls).To(Equal(1))

			// Status reached Ready with the provisioned clientID.
			got := &marketplacev1alpha1.SSOClient{}
			Expect(k8sClient.Get(ctx, req.NamespacedName, got)).To(Succeed())
			Expect(got.Status.Phase).To(Equal("Ready"))
			Expect(got.Status.ClientID).To(Equal("headscale2"))

			// The Secret is owned by the CR (GC wiring).
			sec := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "headscale2-sso", Namespace: ns}, sec)).To(Succeed())
			var owned bool
			for _, or := range sec.GetOwnerReferences() {
				if or.Kind == "SSOClient" && or.Name == "headscale2-sso" {
					owned = true
				}
			}
			Expect(owned).To(BeTrue(), "Secret should be owned by the SSOClient CR")
		})
	})

	Describe("recover + drift + rotation", func() {
		It("recovers an existing app without recreating it", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			// Seed an app that is genuinely in sync with the CR below: built
			// from the same template.Build the reconciler uses, with the
			// resolved redirectUris stored as []any (as a real Casdoor
			// round-trip would). This isolates the type-mismatch check: the
			// reconciler overwrites desired["redirectUris"] with a []string,
			// so a buggy drift detector that only handles []any would always
			// report drift here.
			seedSpec := marketplacev1alpha1.SSOClientSpec{ClientID: "x", RedirectUris: []string{"https://x.${BASE_DOMAIN}/cb"}}
			seed := template.Build(seedSpec, "")
			seed["organization"] = "librepod" // Reconcile defaults org when spec omits it
			seed["redirectUris"] = []any{"https://x.libre.pod/cb"}
			seed["clientSecret"] = "EXISTING"
			fake.Apps["x"] = seed
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "x-sso", Namespace: ns}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "x", RedirectUris: []string{"https://x.${BASE_DOMAIN}/cb"}}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "x-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(fake.AddCalls).To(Equal(0))                           // did not recreate
			Expect(fake.Apps["x"]["clientSecret"]).To(Equal("EXISTING")) // secret unchanged
			Expect(fake.UpdateCalls).To(Equal(0))                        // in sync -> no update (THIS IS THE BUG-CATCHER)
		})

		It("updates Casdoor redirect URIs on drift", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			fake.Apps["y"] = casdoor.Application{"name": "y", "clientId": "y", "clientSecret": "S", "redirectUris": []any{"https://old/cb"}}
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "y-sso", Namespace: ns}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "y", RedirectUris: []string{"https://y.${BASE_DOMAIN}/cb"}}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "y-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(fake.UpdateCalls).To(BeNumerically(">=", 1))
		})

		It("detects drift on scalar fields like tokenFormat", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			// Seed an app that is in sync EXCEPT for tokenFormat (JWT vs the CR's
			// JWT-unsigned), isolating scalar-field drift detection.
			seed := template.Build(marketplacev1alpha1.SSOClientSpec{ClientID: "t", RedirectUris: []string{"https://t.${BASE_DOMAIN}/cb"}, TokenFormat: "JWT"}, "")
			seed["organization"] = "librepod"
			seed["redirectUris"] = []any{"https://t.libre.pod/cb"}
			seed["clientSecret"] = "S"
			fake.Apps["t"] = seed
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "t-sso", Namespace: ns}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "t", RedirectUris: []string{"https://t.${BASE_DOMAIN}/cb"}, TokenFormat: "JWT-unsigned"}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "t-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(fake.UpdateCalls).To(BeNumerically(">=", 1))
		})

		It("does not hot-loop when Casdoor returns grantTypes reordered", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			// Seed an app in sync EXCEPT grantTypes is stored in reversed order.
			seed := template.Build(marketplacev1alpha1.SSOClientSpec{ClientID: "o", RedirectUris: []string{"https://o.${BASE_DOMAIN}/cb"}, GrantTypes: []string{"authorization_code", "refresh_token"}}, "")
			seed["organization"] = "librepod"
			seed["redirectUris"] = []any{"https://o.libre.pod/cb"}
			seed["grantTypes"] = []any{"refresh_token", "authorization_code"} // reversed vs desired
			seed["clientSecret"] = "S"
			fake.Apps["o"] = seed
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "o-sso", Namespace: ns}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "o", RedirectUris: []string{"https://o.${BASE_DOMAIN}/cb"}, GrantTypes: []string{"authorization_code", "refresh_token"}}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "o-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(fake.UpdateCalls).To(Equal(0), "reordered grantTypes must not trigger an update")
		})

		It("rotates the secret when the rotate annotation is set, then clears the annotation", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			fake.Apps["z"] = casdoor.Application{"name": "z", "clientId": "z", "clientSecret": "OLD", "redirectUris": []any{"https://z.libre.pod/cb"}}
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "z-sso", Namespace: ns, Annotations: map[string]string{rotateAnnotation: "true"}}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "z", RedirectUris: []string{"https://z.${BASE_DOMAIN}/cb"}}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "z-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(fake.Apps["z"]["clientSecret"]).NotTo(Equal("OLD"))
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "z-sso", Namespace: ns}, cr)).To(Succeed())
			Expect(cr.Annotations).NotTo(HaveKey(rotateAnnotation))
		})

		// Regression guard for the rotation-churn bug: if a prior pass rotated
		// the secret but failed to clear the annotation (so SecretRotated=True
		// and the annotation is still "true"), the retry must NOT generate a new
		// secret — it should reuse the already-rotated one and just clear the
		// annotation. Without the condition gate, every retry minted a fresh
		// secret (unbounded churn).
		It("does not re-rotate when SecretRotated is already set", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			fake.Apps["z2"] = casdoor.Application{"name": "z2", "clientId": "z2", "clientSecret": "ROTATED", "redirectUris": []any{"https://z2.libre.pod/cb"}}
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "z2-sso", Namespace: ns, Annotations: map[string]string{rotateAnnotation: "true"}}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "z2", RedirectUris: []string{"https://z2.${BASE_DOMAIN}/cb"}}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())

			// Stamp the post-rotation state directly: annotation still "true",
			// but SecretRotated=True (a previous pass already rotated to ROTATED).
			got := &marketplacev1alpha1.SSOClient{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "z2-sso", Namespace: ns}, got)).To(Succeed())
			base := got.DeepCopy()
			got.Status.Conditions = append(got.Status.Conditions, metav1.Condition{Type: condSecretRotated, Status: metav1.ConditionTrue, Reason: "prior", ObservedGeneration: got.Generation, LastTransitionTime: metav1.Now()})
			Expect(k8sClient.Status().Patch(ctx, got, client.MergeFrom(base))).To(Succeed())

			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "z2-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())

			// Secret unchanged: the retry did not re-rotate.
			Expect(fake.Apps["z2"]["clientSecret"]).To(Equal("ROTATED"))
			// Annotation cleared on the retry.
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "z2-sso", Namespace: ns}, cr)).To(Succeed())
			Expect(cr.Annotations).NotTo(HaveKey(rotateAnnotation))
		})

		It("writes the rotated secret to the K8s Secret before clearing the annotation", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			fake.Apps["w"] = casdoor.Application{"name": "w", "clientId": "w", "clientSecret": "OLD", "redirectUris": []any{"https://w.libre.pod/cb"}}
			rr := &SSOClientReconciler{
				Client:             k8sClient,
				Scheme:             scheme.Scheme,
				Casdoor:            fake,
				BaseDomain:         "libre.pod",
				Org:                "librepod",
				secretGen:          func() (string, error) { return "NEWSECRET", nil },
				clearAnnotationErr: fmt.Errorf("patch blocked"),
			}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "w-sso", Namespace: ns, Annotations: map[string]string{rotateAnnotation: "true"}}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "w", RedirectUris: []string{"https://w.${BASE_DOMAIN}/cb"}}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "w-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			sec := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "w-sso", Namespace: ns}, sec)).To(Succeed())
			Expect(string(sec.Data["OIDC_CLIENT_SECRET"])).To(Equal("NEWSECRET"), "rotated secret must reach the Secret before annotation clear")
		})

		It("does not re-rotate when the rotation-pending annotation is set (robust to a failed status patch)", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			fake.Apps["p"] = casdoor.Application{"name": "p", "clientId": "p", "clientSecret": "ROTATED", "redirectUris": []any{"https://p.libre.pod/cb"}}
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			// Post-rotation state: rotate annotation still "true", but a prior
			// pass already rotated (rotation-pending annotation present) and the
			// Casdoor secret is ROTATED. Simulates a failed status patch where the
			// SecretRotated condition was never stamped.
			cr := &marketplacev1alpha1.SSOClient{
				ObjectMeta: metav1.ObjectMeta{Name: "p-sso", Namespace: ns,
					Annotations: map[string]string{rotateAnnotation: "true", rotationPendingAnnotation: "true"}},
				Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "p", RedirectUris: []string{"https://p.${BASE_DOMAIN}/cb"}},
			}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "p-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(fake.Apps["p"]["clientSecret"]).To(Equal("ROTATED")) // not re-rotated
		})
	})

	Describe("deletion", func() {
		It("retains the Casdoor app by default and removes the finalizer", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			fake.Apps["d"] = casdoor.Application{"name": "d", "clientId": "d", "clientSecret": "S"}
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "d-sso", Namespace: ns, Finalizers: []string{finalizerName}}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "d", RedirectUris: []string{"https://d.${BASE_DOMAIN}/cb"}}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			Expect(k8sClient.Delete(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "d-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(fake.Apps).To(HaveKey("d")) // retained
			// CR is gone (finalizer removed -> garbage collected)
			gone := &marketplacev1alpha1.SSOClient{}
			err = k8sClient.Get(ctx, types.NamespacedName{Name: "d-sso", Namespace: ns}, gone)
			Expect(apierrors.IsNotFound(err)).To(BeTrue())
		})

		It("deletes the Casdoor app when casdoorPolicy=delete", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			fake.Apps["d2"] = casdoor.Application{"name": "d2", "clientId": "d2", "clientSecret": "S"}
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{
				ObjectMeta: metav1.ObjectMeta{Name: "d2-sso", Namespace: ns, Finalizers: []string{finalizerName}},
				Spec:       marketplacev1alpha1.SSOClientSpec{ClientID: "d2", RedirectUris: []string{"https://d2.${BASE_DOMAIN}/cb"}, CasdoorPolicy: "delete"},
			}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			Expect(k8sClient.Delete(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "d2-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(fake.Apps).NotTo(HaveKey("d2")) // deleted from Casdoor
			Expect(fake.DeleteCalls).To(Equal(1))
			// CR is gone (finalizer removed -> garbage collected)
			gone := &marketplacev1alpha1.SSOClient{}
			err = k8sClient.Get(ctx, types.NamespacedName{Name: "d2-sso", Namespace: ns}, gone)
			Expect(apierrors.IsNotFound(err)).To(BeTrue())
		})

		It("deletes a cross-namespace managed Secret on CR deletion", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			appNS := newNS()
			secretNS := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: appNS}})).To(Succeed())
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: secretNS}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{
				ObjectMeta: metav1.ObjectMeta{Name: "xns-sso", Namespace: appNS, Finalizers: []string{finalizerName}},
				Spec: marketplacev1alpha1.SSOClientSpec{
					ClientID:     "xns",
					RedirectUris: []string{"https://xns.${BASE_DOMAIN}/cb"},
					Output:       marketplacev1alpha1.SSOClientOutput{SecretNamespace: secretNS},
				},
			}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			// Pre-create the managed Secret in the other namespace.
			Expect(k8sClient.Create(ctx, &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "xns-sso", Namespace: secretNS, Labels: map[string]string{managedLabelKey: "true"}},
			})).To(Succeed())
			Expect(k8sClient.Delete(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "xns-sso", Namespace: appNS}})
			Expect(err).NotTo(HaveOccurred())
			err = k8sClient.Get(ctx, types.NamespacedName{Name: "xns-sso", Namespace: secretNS}, &corev1.Secret{})
			Expect(apierrors.IsNotFound(err)).To(BeTrue())
		})

		It("does not delete a same-name Secret it did not create (no managed label)", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			appNS := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: appNS}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "uno-sso", Namespace: appNS, Finalizers: []string{finalizerName}}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "uno", RedirectUris: []string{"https://uno.${BASE_DOMAIN}/cb"}}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "uno-sso", Namespace: appNS}})).To(Succeed()) // no label
			Expect(k8sClient.Delete(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "uno-sso", Namespace: appNS}})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "uno-sso", Namespace: appNS}, &corev1.Secret{})).To(Succeed()) // left alone
		})

		It("retains and removes the finalizer after the delete retry threshold is exceeded", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			fake.GetErr = fmt.Errorf("casdoor unreachable")
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{
				ObjectMeta: metav1.ObjectMeta{Name: "stuck-sso", Namespace: ns, Finalizers: []string{finalizerName}, Annotations: map[string]string{deleteFailCountAnnotation: "9"}},
				Spec:       marketplacev1alpha1.SSOClientSpec{ClientID: "stuck", RedirectUris: []string{"https://stuck.${BASE_DOMAIN}/cb"}, CasdoorPolicy: "delete"},
			}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			Expect(k8sClient.Delete(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "stuck-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			// CR is gone (finalizer removed via retain fallback).
			gone := &marketplacev1alpha1.SSOClient{}
			Expect(apierrors.IsNotFound(k8sClient.Get(ctx, types.NamespacedName{Name: "stuck-sso", Namespace: ns}, gone))).To(BeTrue())
		})
	})

	Describe("scopes handling", func() {
		It("warns via ScopesIgnored but still reaches Ready when spec.scopes is set", func() {
			ctx := context.Background()
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{
				ObjectMeta: metav1.ObjectMeta{Name: "sc-sso", Namespace: ns},
				Spec: marketplacev1alpha1.SSOClientSpec{
					ClientID:     "sc",
					RedirectUris: []string{"https://sc.${BASE_DOMAIN}/cb"},
					Scopes:       []string{"openid", "profile", "email"},
				},
			}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "sc-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())

			got := &marketplacev1alpha1.SSOClient{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "sc-sso", Namespace: ns}, got)).To(Succeed())
			Expect(got.Status.Phase).To(Equal("Ready"))
			c := meta.FindStatusCondition(got.Status.Conditions, "ScopesIgnored")
			Expect(c).NotTo(BeNil())
			Expect(c.Status).To(Equal(metav1.ConditionTrue))
		})
	})

	Describe("rotation failure paths", func() {
		It("fails the reconcile instead of writing a secret when generation errors", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			fake.Apps["g"] = casdoor.Application{"name": "g", "clientId": "g", "clientSecret": "OLD", "redirectUris": []any{"https://g.libre.pod/cb"}}
			rr := &SSOClientReconciler{
				Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake,
				BaseDomain: "libre.pod", Org: "librepod",
				secretGen: func() (string, error) { return "", fmt.Errorf("rng broken") },
			}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{
				ObjectMeta: metav1.ObjectMeta{Name: "g-sso", Namespace: ns, Annotations: map[string]string{rotateAnnotation: "true"}},
				Spec:       marketplacev1alpha1.SSOClientSpec{ClientID: "g", RedirectUris: []string{"https://g.${BASE_DOMAIN}/cb"}},
			}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "g-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())                       // fail() swallows into a requeue, returns nil error
			Expect(fake.Apps["g"]["clientSecret"]).To(Equal("OLD")) // not rotated
			got := &marketplacev1alpha1.SSOClient{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "g-sso", Namespace: ns}, got)).To(Succeed())
			Expect(got.Status.Phase).To(Equal("Failed"))
		})
	})

	Describe("clientId immutability", func() {
		It("fails reconcile instead of provisioning a second app when status.clientId diverges from spec.clientId", func() {
			ctx := context.Background()
			fake := casdoor.NewFake()
			rr := &SSOClientReconciler{Client: k8sClient, Scheme: scheme.Scheme, Casdoor: fake, BaseDomain: "libre.pod", Org: "librepod"}
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := &marketplacev1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "ci-sso", Namespace: ns}, Spec: marketplacev1alpha1.SSOClientSpec{ClientID: "orig", RedirectUris: []string{"https://orig.${BASE_DOMAIN}/cb"}}}
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			// First reconcile provisions "orig".
			_, err := rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "ci-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			got := &marketplacev1alpha1.SSOClient{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "ci-sso", Namespace: ns}, got)).To(Succeed())
			Expect(got.Status.ClientID).To(Equal("orig"))

			// spec.clientId is CEL-immutable, so admission blocks renaming it. Reach
			// the dangerous state (status.clientId != spec.clientId) via the status
			// subresource, then assert the reconcile guard rejects it instead of
			// orphaning "orig" and provisioning a second app.
			base := got.DeepCopy()
			got.Status.ClientID = "orig-ghost"
			Expect(k8sClient.Status().Patch(ctx, got, client.MergeFrom(base))).To(Succeed())

			_, err = rr.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "ci-sso", Namespace: ns}})
			Expect(err).NotTo(HaveOccurred())
			Expect(fake.AddCalls).To(Equal(1), "no second AddApplication")
			Expect(fake.Apps).To(HaveKey("orig"))
			Expect(fake.Apps).NotTo(HaveKey("orig-ghost"))
			got2 := &marketplacev1alpha1.SSOClient{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "ci-sso", Namespace: ns}, got2)).To(Succeed())
			Expect(got2.Status.Phase).To(Equal("Failed"))
		})

		It("rejects a spec.clientId change at admission via the CEL immutability rule", func() {
			ctx := context.Background()
			ns := newNS()
			Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
			cr := makeCR("cel-sso", "cel", ns)
			Expect(k8sClient.Create(ctx, cr)).To(Succeed())
			got := &marketplacev1alpha1.SSOClient{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "cel-sso", Namespace: ns}, got)).To(Succeed())
			got.Spec.ClientID = "cel-renamed"
			err := k8sClient.Update(ctx, got)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("immutable"))
		})
	})
})
