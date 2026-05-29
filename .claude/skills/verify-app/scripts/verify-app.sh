#!/usr/bin/env bash
# Verify a deployed LibrePod marketplace app.
#
# Runs multi-layer verification checks against an app that has been
# deployed via the Gogs user-apps repo.
#
# Usage:
#   bash verify-app.sh --app whoami --namespace whoami
#   bash verify-app.sh --app vaultwarden --kubeconfig ./librepod-dev.config
#   bash verify-app.sh --app wg-easy --no-http
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed

set -uo pipefail

APP_NAME=""
NAMESPACE=""
KUBECONFIG_PATH="./librepod-dev.config"
CHECK_HTTP="true"

while [[ $# -gt 0 ]]; do
  case $1 in
    --app)        APP_NAME="$2"; shift 2 ;;
    --namespace)  NAMESPACE="$2"; shift 2 ;;
    --kubeconfig) KUBECONFIG_PATH="$2"; shift 2 ;;
    --no-http)    CHECK_HTTP="false"; shift ;;
    *)            echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$APP_NAME" ]]; then
  echo "Error: --app is required"
  exit 1
fi
if [[ -z "$NAMESPACE" ]]; then
  NAMESPACE="$APP_NAME"
fi

# Validate kubeconfig exists
if [[ ! -f "$KUBECONFIG_PATH" ]]; then
  echo "Error: kubeconfig not found at $KUBECONFIG_PATH"
  exit 1
fi

KC="--kubeconfig $KUBECONFIG_PATH"
PASS=0
FAIL=0
WARN=0
RESULTS=()

# ──────────────────────────────────────────────
# Helper: record a check result
# ──────────────────────────────────────────────
record() {
  local status="$1" name="$2" details="$3"
  RESULTS+=("${status}|${name}|${details}")
  case "$status" in
    "PASS") ((PASS++)) ;;
    "FAIL") ((FAIL++)) ;;
    "WARN") ((WARN++)) ;;
    "SKIP") ;;
  esac
}

# ──────────────────────────────────────────────
# Helper: pick a random available port
# ──────────────────────────────────────────────
random_port() {
  # Use a random port in the 20000-60000 range, check it's available
  local port
  for _ in $(seq 1 10); do
    port=$(( (RANDOM % 40000) + 20000 ))
    if ! ss -tlnp 2>/dev/null | grep -q ":${port} "; then
      echo "$port"
      return
    fi
  done
  # Fallback to a fixed port if random selection fails
  echo "28080"
}

echo "=========================================="
echo "  Verifying: $APP_NAME"
echo "  Namespace: $NAMESPACE"
echo "=========================================="
echo ""

# ──────────────────────────────────────────────
# 1. Flux Status
# ──────────────────────────────────────────────
echo "▸ Checking Flux reconciliation..."

KS_STATUS=$(flux get kustomization "marketplace-$APP_NAME" $KC 2>&1) || true
if echo "$KS_STATUS" | grep -q "True"; then
  record "PASS" "Flux Kustomization" "READY=True"
else
  record "FAIL" "Flux Kustomization" "$KS_STATUS"
fi

OCI_DIGEST=$(kubectl $KC get ocirepository "marketplace-$APP_NAME" -n flux-system \
  -o jsonpath='{.status.artifact.digest}' 2>/dev/null) || OCI_DIGEST=""
if [[ -n "$OCI_DIGEST" ]]; then
  record "PASS" "OCIRepository" "Artifact pulled (digest: ${OCI_DIGEST:0:20}...)"
else
  record "FAIL" "OCIRepository" "No artifact found"
fi

# ──────────────────────────────────────────────
# 2. Pod Health
# ──────────────────────────────────────────────
echo "▸ Checking pod health..."

PODS_JSON=$(kubectl $KC get pods -n "$NAMESPACE" -o json 2>/dev/null) || PODS_JSON="{}"
POD_COUNT=$(echo "$PODS_JSON" | jq -r '.items | length' 2>/dev/null || echo "0")

if [[ "$POD_COUNT" == "0" ]]; then
  record "FAIL" "Pod Health" "No pods found in namespace $NAMESPACE"
else
  NOT_RUNNING=$(echo "$PODS_JSON" | jq -r '[.items[] | select(.status.phase != "Running")] | length' 2>/dev/null || echo "0")
  if [[ "$NOT_RUNNING" == "0" ]]; then
    record "PASS" "Pod Health" "$POD_COUNT pod(s) Running"
  else
    record "FAIL" "Pod Health" "$NOT_RUNNING/$POD_COUNT pod(s) not Running"
  fi

  RESTARTS=$(echo "$PODS_JSON" | jq -r '[.items[].status.containerStatuses[]?.restartCount // 0] | add // 0' 2>/dev/null || echo "0")
  if [[ "$RESTARTS" == "0" || "$RESTARTS" == "null" ]]; then
    record "PASS" "Restarts" "0 restarts"
  elif [[ "$RESTARTS" -le 2 ]]; then
    record "WARN" "Restarts" "$RESTARTS restart(s) — investigate if increasing"
  else
    record "FAIL" "Restarts" "$RESTARTS restarts — likely CrashLoop"
  fi

  NOT_READY=$(echo "$PODS_JSON" | jq -r '[.items[] | .status.conditions[] | select(.type=="Ready" and .status!="True")] | length' 2>/dev/null || echo "0")
  if [[ "$NOT_READY" == "0" ]]; then
    record "PASS" "Probes" "All pods Ready (probes passing)"
  else
    record "FAIL" "Probes" "$NOT_READY pod(s) not Ready (probes failing)"
  fi
fi

# ──────────────────────────────────────────────
# 3. HTTP Endpoint
# ──────────────────────────────────────────────
echo "▸ Checking HTTP endpoint..."

if [[ "$CHECK_HTTP" == "true" ]]; then
  SVC_NAME=$(kubectl $KC get svc -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || SVC_NAME=""
  if [[ -n "$SVC_NAME" ]]; then
    SVC_PORT=$(kubectl $KC get svc "$SVC_NAME" -n "$NAMESPACE" \
      -o jsonpath='{.spec.ports[0].port}' 2>/dev/null) || SVC_PORT="80"

    # Use a random port to avoid collisions
    LOCAL_PORT=$(random_port)

    # Port-forward in background with retry
    kubectl $KC port-forward "svc/$SVC_NAME" -n "$NAMESPACE" "${LOCAL_PORT}:${SVC_PORT}" &>/dev/null &
    PF_PID=$!

    # Retry curl up to 3 times to handle port-forward startup delay
    HTTP_CODE="000"
    for attempt in $(seq 1 3); do
      sleep 2
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${LOCAL_PORT}/" --max-time 10 2>/dev/null) || HTTP_CODE="000"
      if [[ "$HTTP_CODE" != "000" ]]; then
        break
      fi
    done

    kill $PF_PID 2>/dev/null || true
    wait $PF_PID 2>/dev/null || true

    case "$HTTP_CODE" in
      200|201)   record "PASS" "HTTP Endpoint" "HTTP $HTTP_CODE" ;;
      301|302)   record "PASS" "HTTP Endpoint" "HTTP $HTTP_CODE (redirect)" ;;
      401|403)   record "PASS" "HTTP Endpoint" "HTTP $HTTP_CODE (auth required)" ;;
      000)       record "SKIP" "HTTP Endpoint" "Connection refused or timeout" ;;
      502|503)   record "FAIL" "HTTP Endpoint" "HTTP $HTTP_CODE (bad gateway / service unavailable)" ;;
      504)       record "FAIL" "HTTP Endpoint" "HTTP $HTTP_CODE (gateway timeout)" ;;
      *)         record "WARN" "HTTP Endpoint" "HTTP $HTTP_CODE (unexpected)" ;;
    esac
  else
    record "SKIP" "HTTP Endpoint" "No service found"
  fi
else
  record "SKIP" "HTTP Endpoint" "HTTP check disabled"
fi

# ──────────────────────────────────────────────
# 4. Log Inspection
# ──────────────────────────────────────────────
echo "▸ Checking logs..."

# Try multiple label selectors — apps use different label conventions
LOG_OUTPUT=""
for selector in "app=$APP_NAME" "app.kubernetes.io/name=$APP_NAME" "app.kubernetes.io/instance=$APP_NAME"; do
  LOG_OUTPUT=$(kubectl $KC logs -n "$NAMESPACE" -l "$selector" --tail=100 2>/dev/null) || LOG_OUTPUT=""
  if [[ -n "$LOG_OUTPUT" ]]; then
    break
  fi
done

# Fallback: get all pod logs in the namespace if no label matched
if [[ -z "$LOG_OUTPUT" ]]; then
  POD_NAMES=$(kubectl $KC get pods -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || POD_NAMES=""
  if [[ -n "$POD_NAMES" ]]; then
    LOG_OUTPUT=$(kubectl $KC logs "$POD_NAMES" -n "$NAMESPACE" --tail=100 2>/dev/null) || LOG_OUTPUT=""
  fi
fi

if [[ -z "$LOG_OUTPUT" ]]; then
  record "WARN" "Log Inspection" "No logs found (label selector may not match)"
else
  ERROR_COUNT=$(echo "$LOG_OUTPUT" | grep -ciE 'error|fatal|panic|exception' || echo "0")
  if [[ "$ERROR_COUNT" -eq 0 ]]; then
    record "PASS" "Log Inspection" "0 error-level entries in last 100 lines"
  elif [[ "$ERROR_COUNT" -le 2 ]]; then
    record "WARN" "Log Inspection" "$ERROR_COUNT error-level entries — review logs"
  else
    record "FAIL" "Log Inspection" "$ERROR_COUNT error-level entries in last 100 lines"
  fi
fi

# ──────────────────────────────────────────────
# 5. Resource Audit
# ──────────────────────────────────────────────
echo "▸ Auditing resources..."

# PVCs
PVC_JSON=$(kubectl $KC get pvc -n "$NAMESPACE" -o json 2>/dev/null) || PVC_JSON='{"items":[]}'
PVC_COUNT=$(echo "$PVC_JSON" | jq -r '.items | length' 2>/dev/null || echo "0")
if [[ "$PVC_COUNT" == "0" ]]; then
  record "SKIP" "PVCs" "No PVCs (app may not use persistent storage)"
else
  PENDING_PVCS=$(echo "$PVC_JSON" | jq -r '[.items[] | select(.status.phase != "Bound")] | length' 2>/dev/null || echo "0")
  if [[ "$PENDING_PVCS" == "0" ]]; then
    record "PASS" "PVCs" "$PVC_COUNT PVC(s) Bound"
  else
    record "FAIL" "PVCs" "$PENDING_PVCS/$PVC_COUNT PVC(s) not Bound"
  fi
fi

# HelmReleases (for apps using Helm via Flux)
HR_JSON=$(kubectl $KC get helmrelease -n "$NAMESPACE" -o json 2>/dev/null) || HR_JSON='{"items":[]}'
HR_COUNT=$(echo "$HR_JSON" | jq -r '.items | length' 2>/dev/null || echo "0")
if [[ "$HR_COUNT" != "0" ]]; then
  HR_READY=$(echo "$HR_JSON" | jq -r '[.items[] | select(.status.conditions[]?.type == "Ready" and .status.conditions[]?.status == "True")] | length' 2>/dev/null || echo "0")
  if [[ "$HR_READY" == "$HR_COUNT" ]]; then
    record "PASS" "HelmReleases" "$HR_COUNT HelmRelease(s) Ready"
  else
    record "FAIL" "HelmReleases" "$HR_READY/$HR_COUNT HelmRelease(s) Ready"
  fi
fi

# Services with endpoints
EP_JSON=$(kubectl $KC get endpoints -n "$NAMESPACE" -o json 2>/dev/null) || EP_JSON='{"items":[]}'
EP_COUNT=$(echo "$EP_JSON" | jq -r '.items | length' 2>/dev/null || echo "0")
if [[ "$EP_COUNT" == "0" ]]; then
  record "WARN" "Endpoints" "No endpoints found"
else
  EMPTY_EPS=$(echo "$EP_JSON" | jq -r '[.items[] | select((.subsets | length) == 0 or (.subsets[].addresses | length) == 0)] | length' 2>/dev/null || echo "0")
  if [[ "$EMPTY_EPS" == "0" ]]; then
    record "PASS" "Endpoints" "$EP_COUNT service(s) have endpoints"
  else
    record "FAIL" "Endpoints" "$EMPTY_EPS/$EP_COUNT service(s) have no endpoints"
  fi
fi

# ConfigMaps and Secrets
CM_COUNT=$(kubectl $KC get configmaps -n "$NAMESPACE" -o json 2>/dev/null | jq -r '.items | length' 2>/dev/null || echo "0")
SECRET_COUNT=$(kubectl $KC get secrets -n "$NAMESPACE" -o json 2>/dev/null | jq -r '.items | length' 2>/dev/null || echo "0")
record "PASS" "Resources" "$CM_COUNT ConfigMap(s), $SECRET_COUNT Secret(s)"

# ──────────────────────────────────────────────
# Report
# ──────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings"
echo "=========================================="
echo ""

printf "%-25s %-10s %s\n" "Check" "Status" "Details"
printf "%-25s %-10s %s\n" "─────" "──────" "───────"
for result in "${RESULTS[@]}"; do
  IFS='|' read -r status check details <<< "$result"
  case "$status" in
    "PASS") icon="✅ PASS" ;;
    "FAIL") icon="❌ FAIL" ;;
    "WARN") icon="⚠️  WARN" ;;
    "SKIP") icon="⏭️  SKIP" ;;
  esac
  printf "%-25s %-10s %s\n" "$check" "$icon" "$details"
done

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "❌ Verification FAILED for $APP_NAME"
  exit 1
else
  echo "✅ Verification PASSED for $APP_NAME"
  exit 0
fi
