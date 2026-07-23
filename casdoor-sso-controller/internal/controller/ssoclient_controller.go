package controller

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	marketplacev1alpha1 "github.com/librepod/casdoor-sso-controller/api/v1alpha1"
	"github.com/librepod/casdoor-sso-controller/internal/casdoor"
	"github.com/librepod/casdoor-sso-controller/internal/naming"
	"github.com/librepod/casdoor-sso-controller/internal/template"
)

const (
	managedLabelKey  = "marketplace.librepod.org/sso-managed"
	rotateAnnotation = "marketplace.librepod.org/rotate-secret"
	finalizerName    = "marketplace.librepod.org/ssoclient-finalizer"

	// rotationPendingAnnotation is stamped on the CR's metadata right after a
	// rotation is pushed to Casdoor. It survives a failed status subresource
	// patch (unlike the SecretRotated condition, which lives in .status), so
	// rotationCompleted can still suppress re-rotation on the requeue. Cleared
	// together with the rotate annotation in clearAnnotation.
	rotationPendingAnnotation = "marketplace.librepod.org/rotation-pending"

	// condSecretRotated marks that a secret rotation has been pushed to Casdoor
	// but the rotate annotation has not yet been cleared. It prevents a failed
	// annotation-clear from re-entering the rotation path on the next requeue
	// (which would generate a fresh secret every retry — unbounded churn).
	condSecretRotated = "SecretRotated"

	// deleteFailCountAnnotation counts consecutive Casdoor delete failures for a
	// deleting CR. After deleteFailThreshold attempts the finalizer gives up,
	// leaves the Casdoor app in place (retain), and lets the CR be removed — so a
	// permanently-unreachable Casdoor cannot block CR deletion forever.
	deleteFailCountAnnotation = "marketplace.librepod.org/delete-fail-count"
	deleteFailThreshold       = 10 // ~5 min at 30s backoff before retaining

	// Status phases mirror the SSOClientStatus Phase enum.
	phaseReady  = "Ready"
	phaseFailed = "Failed"

	// requeueFailureInterval backs off transient Casdoor failures so they self-heal.
	requeueFailureInterval = 30 * time.Second
)

// SSOClientReconciler reconciles an SSOClient object, provisioning a matching
// Casdoor OIDC Application and writing the resulting credentials into a labeled
// Secret in the app's namespace.
type SSOClientReconciler struct {
	client.Client
	Scheme     *runtime.Scheme
	Casdoor    casdoor.Client
	BaseDomain string
	Org        string
	// secretGen overrides the default secret generator (test seam). Nil => newClientSecret.
	secretGen func() (string, error)
	// clearAnnotationErr, when non-nil, makes clearAnnotation return this error
	// (test seam for the rotation Secret/annotation-clear ordering).
	clearAnnotationErr error
}

// +kubebuilder:rbac:groups=marketplace.librepod.org,resources=ssoclients,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=marketplace.librepod.org,resources=ssoclients/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=marketplace.librepod.org,resources=ssoclients/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=coordination.k8s.io,resources=leases,verbs=get;list;watch;create;update;patch;delete

func (r *SSOClientReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var cr marketplacev1alpha1.SSOClient
	if err := r.Get(ctx, req.NamespacedName, &cr); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	org := cr.Spec.Organization
	if org == "" {
		org = r.Org
	}

	// spec.clientId is the Casdoor identity and must not change after provisioning
	// (a CEL rule blocks it at admission; this guard is the reconcile-time safety
	// net for the rare case where spec and status have diverged). Failing here
	// beats the alternative — orphaning the old app and provisioning a second.
	if cr.Status.ClientID != "" && cr.Status.ClientID != cr.Spec.ClientID {
		return r.fail(ctx, &cr, fmt.Errorf("spec.clientId is immutable: was %q, now %q — revert the change or delete+recreate the SSOClient", cr.Status.ClientID, cr.Spec.ClientID))
	}

	// Deletion handling. The finalizer lets us reconcile Casdoor-side cleanup
	// before the CR is garbage-collected. casdoorPolicy defaults to "retain"
	// (the Casdoor application is left in place); "delete" removes the
	// application first. Any Casdoor error is surfaced via fail() so the
	// finalizer stays and the reconcile retries — we never leak a Casdoor app
	// by dropping the finalizer on a transient failure, and we never block CR
	// deletion when the app is already gone.
	if !cr.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&cr, finalizerName) {
			if cr.Spec.CasdoorPolicy == "delete" {
				// Key the lookup off status.clientId (the provisioned identity),
				// falling back to spec only when status is empty (never reconciled).
				lookupID := cr.Status.ClientID
				if lookupID == "" {
					lookupID = cr.Spec.ClientID
				}
				if err := r.casdoorDeleteWithFallback(ctx, &cr, lookupID); err != nil {
					return r.fail(ctx, &cr, err)
				}
			}
			// Best-effort cleanup of the managed Secret. Cross-namespace
			// OwnerReferences are ignored by GC, so when output.secretNamespace
			// differs from the CR's namespace the finalizer must remove the
			// Secret explicitly. Only delete Secrets carrying our managed label
			// — never a user-owned Secret that happens to share the name.
			sec := &corev1.Secret{}
			secKey := client.ObjectKey{Name: naming.SecretName(&cr), Namespace: naming.SecretNamespace(&cr, r.Org)}
			if err := r.Get(ctx, secKey, sec); err == nil {
				if sec.Labels[managedLabelKey] == "true" {
					if err := r.Delete(ctx, sec); err != nil && !apierrors.IsNotFound(err) {
						return r.fail(ctx, &cr, fmt.Errorf("delete managed secret: %w", err))
					}
				}
			}
			// Remove the finalizer. A NotFound here means a concurrent reconcile
			// already removed it and the API server GC'd the object — this happens
			// because the removal is itself an update event that re-enqueues the
			// (now stale) object. Swallow it: cleanup is already complete, and
			// returning the raw NotFound would log a spurious "Reconciler error"
			// on every delete.
			if err := r.patchFinalizer(ctx, &cr, false); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&cr, finalizerName) {
		if err := r.patchFinalizer(ctx, &cr, true); err != nil {
			return ctrl.Result{}, err
		}
	}

	redirects := naming.ResolveRedirects(cr.Spec.RedirectUris, r.BaseDomain)
	// Empty clientSecret => Casdoor generates one on create.
	desired := template.Build(cr.Spec, "")
	// template.Build sets organization from spec.Organization (often empty); use
	// the resolved org so the app lands in the right owner scope and so drift
	// can compare it consistently.
	desired["organization"] = org
	desired[casdoor.FieldRedirectUris] = redirects

	// Get-or-create. The Casdoor app name == the CR's clientId; the DB owner
	// is always "admin", encoded inside the client's GetApplication.
	existing, found, err := r.Casdoor.GetApplication(ctx, cr.Spec.ClientID)
	if err != nil {
		return r.fail(ctx, &cr, fmt.Errorf("get application: %w", err))
	}
	var clientID, secret string
	if !found {
		created, err := r.Casdoor.AddApplication(ctx, desired)
		if err != nil {
			return r.fail(ctx, &cr, fmt.Errorf("add application: %w", err))
		}
		clientID, secret = casdoor.AppClientID(created), casdoor.AppClientSecret(created)
	} else {
		clientID = casdoor.AppClientID(existing)
		secret = casdoor.AppClientSecret(existing)
		switch {
		// Rotation wins this pass; any remaining drift reconciles on the next
		// iteration. The SecretRotated condition guards the window between
		// "secret rotated in Casdoor" and "rotate annotation cleared": if the
		// annotation clear fails and we requeue, the condition makes us skip
		// generating another secret and only retry the clear.
		case cr.Annotations[rotateAnnotation] == "true":
			if !rotationCompleted(&cr) {
				var gerr error
				secret, gerr = r.genSecret()
				if gerr != nil {
					return r.fail(ctx, &cr, fmt.Errorf("rotate secret: generate: %w", gerr))
				}
				existing[casdoor.FieldClientSecret] = secret
				if err := r.Casdoor.UpdateApplication(ctx, existing); err != nil {
					return r.fail(ctx, &cr, fmt.Errorf("rotate secret: %w", err))
				}
				// Persist the rotation-pending marker on metadata BEFORE writing
				// the Secret: it is the durable signal rotationCompleted honors, so
				// a later failed status patch or annotation clear cannot cause a
				// re-rotation. Cleared together with the rotate annotation.
				pendBase := cr.DeepCopy()
				if cr.Annotations == nil {
					cr.Annotations = map[string]string{}
				}
				cr.Annotations[rotationPendingAnnotation] = "true"
				if err := r.Patch(ctx, &cr, client.MergeFrom(pendBase)); err != nil {
					return r.fail(ctx, &cr, fmt.Errorf("rotate secret: stamp pending marker: %w", err))
				}
			}
			// The rotate annotation is cleared AFTER upsertSecret (below), so a
			// failed clear never leaves Casdoor rotated but the K8s Secret stale.
		case drift(existing, desired):
			if err := r.Casdoor.UpdateApplication(ctx, mergeExisting(existing, desired)); err != nil {
				return r.fail(ctx, &cr, fmt.Errorf("update application: %w", err))
			}
		}
	}

	// Casdoor should always return a generated clientSecret. An empty one means
	// a create that did not generate (version mismatch) or a corrupted existing
	// app — fail loudly rather than write a broken Secret.
	if secret == "" {
		return r.fail(ctx, &cr, fmt.Errorf("casdoor returned empty clientSecret for %q", cr.Spec.ClientID))
	}

	if err := r.upsertSecret(ctx, &cr, clientID, secret); err != nil {
		return r.fail(ctx, &cr, fmt.Errorf("upsert secret: %w", err))
	}

	// Clear the rotate annotation only after the Secret holds the new value.
	// A failed clear requeues via requeuePendingRotation, but the Secret is
	// already correct, so no client is ever locked out waiting for the retry.
	if cr.Annotations[rotateAnnotation] == "true" {
		if err := r.clearAnnotation(ctx, &cr); err != nil {
			return r.requeuePendingRotation(ctx, &cr)
		}
	}

	return r.succeed(ctx, &cr, clientID)
}

// patchFinalizer adds or removes the finalizer via a merge patch scoped to
// metadata.finalizers, so an object fetched at the top of Reconcile cannot
// clobber concurrent spec edits or conflict on resourceVersion the way a full
// Update of the (potentially stale) object would.
func (r *SSOClientReconciler) patchFinalizer(ctx context.Context, cr *marketplacev1alpha1.SSOClient, add bool) error {
	base := cr.DeepCopy()
	if add {
		controllerutil.AddFinalizer(cr, finalizerName)
	} else {
		controllerutil.RemoveFinalizer(cr, finalizerName)
	}
	return r.Patch(ctx, cr, client.MergeFrom(base))
}

// casdoorDeleteWithFallback deletes the Casdoor app, but after
// deleteFailThreshold consecutive failures (tracked on deleteFailCountAnnotation)
// it gives up, leaves the app in Casdoor (retain), and stamps a status condition
// so the orphan is visible — unblocking CR deletion instead of looping forever
// against a permanently-unreachable Casdoor.
func (r *SSOClientReconciler) casdoorDeleteWithFallback(ctx context.Context, cr *marketplacev1alpha1.SSOClient, id string) error {
	existing, found, err := r.Casdoor.GetApplication(ctx, id)
	if err == nil && found {
		// Casdoor 3.x delete-application requires the full object body; a
		// {owner,name} body is a silent no-op.
		err = r.Casdoor.DeleteApplication(ctx, existing)
	}
	if err == nil {
		// Success — clear any stale failure counter.
		if cr.Annotations[deleteFailCountAnnotation] != "" {
			_ = r.patchAnnotation(ctx, cr, deleteFailCountAnnotation, "")
		}
		return nil
	}
	count := 1
	if n, perr := strconv.Atoi(cr.Annotations[deleteFailCountAnnotation]); perr == nil {
		count = n + 1
	}
	if count >= deleteFailThreshold {
		// Fall back to retain so the CR can be deleted; record the orphan.
		statusBase := cr.DeepCopy()
		meta.SetStatusCondition(&cr.Status.Conditions, metav1.Condition{
			Type:               "CasdoorDeleteFailed",
			Status:             metav1.ConditionTrue,
			Reason:             "RetainFallback",
			Message:            fmt.Sprintf("gave up deleting Casdoor app %q after %d failures; it is left in place", id, count),
			ObservedGeneration: cr.Generation,
		})
		_ = r.Status().Patch(ctx, cr, client.MergeFrom(statusBase)) // best-effort
		return nil
	}
	_ = r.patchAnnotation(ctx, cr, deleteFailCountAnnotation, strconv.Itoa(count))
	return fmt.Errorf("delete application (attempt %d/%d): %w", count, deleteFailThreshold, err)
}

// patchAnnotation sets (value != "") or deletes (value == "") a single metadata
// annotation via a merge patch, so annotation bookkeeping cannot clobber
// concurrent spec/metadata edits the way a full Update would.
func (r *SSOClientReconciler) patchAnnotation(ctx context.Context, cr *marketplacev1alpha1.SSOClient, key, value string) error {
	base := cr.DeepCopy()
	if cr.Annotations == nil {
		cr.Annotations = map[string]string{}
	}
	if value == "" {
		delete(cr.Annotations, key)
	} else {
		cr.Annotations[key] = value
	}
	return r.Patch(ctx, cr, client.MergeFrom(base))
}

// upsertSecret creates or updates the labeled Secret carrying the OIDC
// credentials, owned by the SSOClient CR.
//
// NOTE: Kubernetes garbage collection only honors OwnerReferences between
// resources in the SAME namespace. The pilot keeps CR and Secret co-located
// (both in the app namespace). If output.secretNamespace ever points elsewhere,
// the finalizer (Task 14) must clean the Secret up explicitly — GC will not.
func (r *SSOClientReconciler) upsertSecret(ctx context.Context, cr *marketplacev1alpha1.SSOClient, clientID, secret string) error {
	keys := naming.Keys(cr)
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      naming.SecretName(cr),
			Namespace: naming.SecretNamespace(cr, r.Org),
			Labels:    map[string]string{managedLabelKey: "true"},
		},
		Type: corev1.SecretTypeOpaque,
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, sec, func() error {
		if sec.Labels == nil {
			sec.Labels = map[string]string{}
		}
		sec.Labels[managedLabelKey] = "true"
		sec.Type = corev1.SecretTypeOpaque
		// Merge keys instead of replacing sec.Data, so extra keys an author or
		// chart placed in the Secret (e.g. OAUTH_MTLS_CERT) survive reconcile.
		if sec.Data == nil {
			sec.Data = map[string][]byte{}
		}
		sec.Data[keys.ClientID] = []byte(clientID)
		sec.Data[keys.ClientSecret] = []byte(secret)
		sec.Data[keys.Issuer] = []byte(naming.IssuerURL(r.BaseDomain))
		return ctrl.SetControllerReference(cr, sec, r.Scheme)
	})
	return err
}

func (r *SSOClientReconciler) succeed(ctx context.Context, cr *marketplacev1alpha1.SSOClient, clientID string) (ctrl.Result, error) {
	patch := client.MergeFrom(cr.DeepCopy())
	cr.Status.Phase = phaseReady
	cr.Status.ClientID = clientID
	cr.Status.ObservedGeneration = cr.Generation
	cr.Status.LastReconcileTime = &metav1.Time{Time: time.Now()}
	meta.SetStatusCondition(&cr.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionTrue,
		Reason:             "Provisioned",
		Message:            "Casdoor application synced; secret up to date",
		ObservedGeneration: cr.Generation,
	})
	// A successful reconcile (the rotate annotation is gone) clears the
	// SecretRotated marker so the next rotation request is honored.
	meta.SetStatusCondition(&cr.Status.Conditions, metav1.Condition{
		Type:               condSecretRotated,
		Status:             metav1.ConditionFalse,
		Reason:             "UpToDate",
		Message:            "no rotation pending",
		ObservedGeneration: cr.Generation,
	})
	// spec.scopes is accepted for ergonomics but never applied: Casdoor's
	// Application.scopes is []object (ScopeItem) and OIDC scopes are driven by
	// the client's auth request, not this field. The ScopesIgnored condition is
	// reconciled to match current state EVERY pass — True (warning) when scopes
	// are set, False once they are removed — so a stale warning never lingers
	// after an author drops the no-op field. (Previously this was only set
	// inside `if scopes > 0`, so removing scopes left ScopesIgnored=True
	// forever — a sticky-condition bug.)
	scopesIgnored := metav1.Condition{
		Type:               "ScopesIgnored",
		Status:             metav1.ConditionFalse,
		Reason:             "NoUnsupportedFields",
		Message:            "spec.scopes is not set; no fields are being ignored",
		ObservedGeneration: cr.Generation,
	}
	if len(cr.Spec.Scopes) > 0 {
		scopesIgnored.Status = metav1.ConditionTrue
		scopesIgnored.Reason = "UnsupportedField"
		scopesIgnored.Message = "spec.scopes is accepted but not applied; OIDC scopes come from the client auth request"
	}
	meta.SetStatusCondition(&cr.Status.Conditions, scopesIgnored)
	if err := r.Status().Patch(ctx, cr, patch); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// rotationCompleted reports whether a secret rotation has already been pushed
// to Casdoor for the current rotate annotation. The metadata
// rotationPendingAnnotation is the durable signal (it survives a failed status
// subresource patch); the SecretRotated condition is a secondary signal.
func rotationCompleted(cr *marketplacev1alpha1.SSOClient) bool {
	if cr.Annotations[rotationPendingAnnotation] == "true" {
		return true
	}
	c := meta.FindStatusCondition(cr.Status.Conditions, condSecretRotated)
	return c != nil && c.Status == metav1.ConditionTrue
}

// requeuePendingRotation stamps SecretRotated=True so the next reconcile skips
// re-rotation and only retries the annotation clear, then requeues. The status
// patch is observability/flow-control only: a failure is logged and we still
// requeue (the worst case is one extra rotation if both the annotation clear
// AND this status patch fail in the same pass).
func (r *SSOClientReconciler) requeuePendingRotation(ctx context.Context, cr *marketplacev1alpha1.SSOClient) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	logger.Info("secret rotated but rotate annotation clear failed; will retry the clear without re-rotating")
	patch := client.MergeFrom(cr.DeepCopy())
	meta.SetStatusCondition(&cr.Status.Conditions, metav1.Condition{
		Type:               condSecretRotated,
		Status:             metav1.ConditionTrue,
		Reason:             "RotatedPendingAnnotationClear",
		Message:            "secret rotated; rotate annotation clear pending",
		ObservedGeneration: cr.Generation,
	})
	if perr := r.Status().Patch(ctx, cr, patch); perr != nil {
		logger.Error(perr, "failed to stamp SecretRotated; rotation may re-fire on requeue")
	}
	return ctrl.Result{RequeueAfter: requeueFailureInterval}, nil
}

func (r *SSOClientReconciler) fail(ctx context.Context, cr *marketplacev1alpha1.SSOClient, cause error) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	logger.Error(cause, "reconcile failed")
	patch := client.MergeFrom(cr.DeepCopy())
	cr.Status.Phase = phaseFailed
	meta.SetStatusCondition(&cr.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             "ReconcileError",
		Message:            cause.Error(),
		ObservedGeneration: cr.Generation,
	})
	// A status-patch failure is observability-only: log it but keep the backoff
	// requeue (returning it would storm a broken status subresource).
	if perr := r.Status().Patch(ctx, cr, patch); perr != nil {
		logger.Error(perr, "failed to patch SSOClient failure status; will retry on next requeue")
	}
	// Leave any existing secret intact so consumers keep working. Requeue with
	// backoff so transient Casdoor failures self-heal.
	return ctrl.Result{RequeueAfter: requeueFailureInterval}, nil
}

// SetupWithManager registers the reconciler with the controller-runtime manager.
func (r *SSOClientReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&marketplacev1alpha1.SSOClient{}).
		Owns(&corev1.Secret{}).
		Complete(r)
}

// drift reports whether the existing Casdoor application has diverged from the
// desired state derived from the CR. Slice fields are compared as []string on
// BOTH sides (robust to []any from JSON and []string from ResolveRedirects).
// Scalar fields are compared with scalarEqual, which normalizes JSON float64
// numbers (e.g. expireInHours) against Go int and treats an absent key as the
// zero value (so an omitted enableSignUp does not drift against a desired
// false). Together this covers every CR-controlled field so editing the CR
// reliably syncs to Casdoor without a no-op UpdateApplication hot-loop.
// driftSliceFields/driftScalarFields are the Casdoor application fields drift()
// reconciles. Expressed as casdoor field constants (not literals) so a typo or a
// field rename is a compile error, and so TestDriftFieldsAreCasdoorConstants can
// guard the link.
var driftSliceFields = []string{casdoor.FieldRedirectUris, casdoor.FieldGrantTypes}
var driftScalarFields = []string{casdoor.FieldTokenFormat, casdoor.FieldExpireHours, casdoor.FieldOrganization, casdoor.FieldEnableSignUp}

func drift(existing, desired casdoor.Application) bool {
	for _, k := range driftSliceFields {
		if !equalStringSet(anySliceToStrings(existing[k]), anySliceToStrings(desired[k])) {
			return true
		}
	}
	for _, k := range driftScalarFields {
		if !scalarEqual(existing[k], desired[k]) {
			return true
		}
	}
	return false
}

// scalarEqual compares a CR-controlled scalar across the Casdoor JSON shape
// (existing: float64 for numbers, bool, nil for absent) and the Go shape
// (desired: int, string, bool). fmt.Sprint would mis-compare nil vs false
// ("<nil>" != "false") and hot-loop UpdateApplication every reconcile.
func scalarEqual(a, b any) bool {
	if a == nil || b == nil {
		// An absent key matches only the other side's zero value (false, "", 0),
		// NOT an arbitrary desired value like expireInHours=168.
		return scalarZero(a) == scalarZero(b)
	}
	if fa, ok := toFloat(a); ok {
		if fb, ok := toFloat(b); ok {
			return fa == fb
		}
	}
	if ba, ok := a.(bool); ok {
		if bb, ok := b.(bool); ok {
			return ba == bb
		}
	}
	return fmt.Sprint(a) == fmt.Sprint(b)
}

// toFloat coerces JSON-decoded and Go numeric types to float64 for comparison.
func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

// scalarZero renders a scalar as its zero/empty token so nil (an absent Casdoor
// key) compares equal to false/""/0 but NOT to a non-zero desired value. The
// sentinel is chosen so it can never collide with a real rendered value.
func scalarZero(v any) string {
	switch x := v.(type) {
	case nil:
		return scalarZeroSentinel
	case bool:
		if x {
			return "true"
		}
		return scalarZeroSentinel
	case string:
		if x == "" {
			return scalarZeroSentinel
		}
		return x
	}
	if f, ok := toFloat(v); ok {
		if f == 0 {
			return scalarZeroSentinel
		}
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

const scalarZeroSentinel = "\x00"

// mergeExisting copies desired fields onto a clone of the existing app,
// preserving all Casdoor-managed fields (e.g. clientId) and never overwriting
// the secret (drift never rotates; rotation is a separate code path). The copy
// is shallow — safe because callers serialize the result immediately without
// mutating nested values.
func mergeExisting(existing, desired casdoor.Application) casdoor.Application {
	out := casdoor.Application{}
	for k, v := range existing {
		out[k] = v
	}
	for k, v := range desired {
		if k == casdoor.FieldClientSecret {
			continue // never overwrite the secret via drift
		}
		out[k] = v
	}
	return out
}

// anySliceToStrings coerces a []any OR []string to []string. Must handle both:
// template.Build stores slices as []any, but Reconcile overwrites redirectUris
// with a []string from naming.ResolveRedirects. Returning an empty slice for
// a []string input (the original type-mismatch bug) caused drift to evaluate
// always-true whenever the existing app had any redirect URI.
func anySliceToStrings(v any) []string {
	out := make([]string, 0)
	switch arr := v.(type) {
	case []any:
		for _, x := range arr {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	case []string:
		out = append(out, arr...)
	}
	return out
}

// equalStringSet reports set equality (order-insensitive) of two string slices.
// Duplicates are treated as distinct only if their counts differ. Used by drift
// for slice fields so a Casdoor response that reorders the same set does not
// hot-loop UpdateApplication every reconcile.
func equalStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := map[string]int{}
	for _, s := range a {
		counts[s]++
	}
	for _, s := range b {
		counts[s]--
		if counts[s] < 0 {
			return false
		}
	}
	return true
}

// newClientSecret returns a 20-byte (40 hex char) random string for rotation.
// A crypto/rand failure is propagated rather than silently producing a short or
// empty secret: the caller fails the reconcile instead of writing a broken value
// to Casdoor and the K8s Secret.
func newClientSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}

// genSecret returns a rotation secret, honoring the secretGen override when set
// (used by tests to force the failure path) and falling back to newClientSecret.
func (r *SSOClientReconciler) genSecret() (string, error) {
	if r.secretGen != nil {
		return r.secretGen()
	}
	return newClientSecret()
}

// clearAnnotation removes the rotate annotation from the CR via a strategic
// merge patch so the rotation does not fire again on the next reconcile.
func (r *SSOClientReconciler) clearAnnotation(ctx context.Context, cr *marketplacev1alpha1.SSOClient) error {
	patch := client.MergeFrom(cr.DeepCopy())
	if r.clearAnnotationErr != nil {
		return r.clearAnnotationErr
	}
	if cr.Annotations == nil {
		cr.Annotations = map[string]string{}
	}
	delete(cr.Annotations, rotateAnnotation)
	delete(cr.Annotations, rotationPendingAnnotation)
	return r.Patch(ctx, cr, patch)
}
