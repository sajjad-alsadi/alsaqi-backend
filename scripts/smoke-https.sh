#!/usr/bin/env bash
# =============================================================================
# smoke-https.sh — Live HTTPS smoke check for the backend Public_Endpoint
# Task 12.2 (Requirement 9: 9.1, 9.2, 9.3; failure-tracking 9.3 / 9.5)
#
# PURPOSE
#   Verify that the live backend answers over HTTPS BEFORE the frontend repo's
#   Contract_Test_Suite / E2E_Suite run against it (Req 9.1/9.2 — real target,
#   no mock). It asserts:
#     1. GET https://<endpoint>/api/health returns HTTP 200 over TLS.
#     2. The response carries the X-API-Version header (operational HTTPS path).
#     3. (best-effort) Strict-Transport-Security is present (Req 4.3 / 9.x).
#
#   "-k" / --insecure is used so self-signed TEST certs are accepted; in real
#   staging with CA-issued certs you may drop it.
#
# USAGE
#   ./scripts/smoke-https.sh [PUBLIC_ENDPOINT]
#     PUBLIC_ENDPOINT  Base HTTPS URL (default: env PUBLIC_ENDPOINT or
#                      https://localhost). Example: https://api.staging.example.com
#
#   Examples:
#     ./scripts/smoke-https.sh
#     PUBLIC_ENDPOINT=https://api.staging.example.com ./scripts/smoke-https.sh
#     ./scripts/smoke-https.sh https://localhost
#
# EXIT CODES
#   0  smoke check passed (backend is HTTPS-reachable)
#   1  smoke check FAILED — a tracked fix item is appended to the failure log
#      (see FAILURE-TRACKING below) and the script exits non-zero so CI fails.
#
# FAILURE-TRACKING (Req 9.3 / 9.5)
#   On failure, the failure is recorded as a tracked fix item by APPENDING a
#   dated entry to:
#       docs/launch-fix-items.md   (override with FIX_ITEMS_LOG=<path>)
#   Each entry records: timestamp, the endpoint probed, expected vs observed
#   result, and a stable FIX-<epoch> id. This is the same "tracked fix item"
#   convention referenced by the Deployment_Runbook (§6.4) and
#   docs/core-audit-workflow.md (§5). The non-zero exit then marks the run as
#   failed for the calling pipeline.
# =============================================================================
set -uo pipefail

ENDPOINT="${1:-${PUBLIC_ENDPOINT:-https://localhost}}"
ENDPOINT="${ENDPOINT%/}"                       # strip any trailing slash
HEALTH_URL="${ENDPOINT}/api/health"
FIX_ITEMS_LOG="${FIX_ITEMS_LOG:-docs/launch-fix-items.md}"
EXPECTED_CODE=200

echo "smoke-https: probing ${HEALTH_URL} (expect HTTP ${EXPECTED_CODE} over HTTPS)"

# Fetch status code and response headers in one shot. -k accepts self-signed
# test certs; -sS keeps it quiet but still surfaces hard errors.
headers="$(curl -ksS -m 15 -o /dev/null -D - -w 'HTTP_CODE:%{http_code}' "${HEALTH_URL}" 2>/dev/null)"
curl_rc=$?

http_code="$(printf '%s' "${headers}" | sed -n 's/.*HTTP_CODE:\([0-9]\{3\}\).*/\1/p')"
http_code="${http_code:-000}"
api_version="$(printf '%s\n' "${headers}" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-api-version"{print $2}')"
hsts="$(printf '%s\n' "${headers}" | tr -d '\r' | awk -F': ' 'tolower($1)=="strict-transport-security"{print $2}')"

failure_reason=""
if [ "${curl_rc}" -ne 0 ]; then
  failure_reason="HTTPS request failed (curl exit ${curl_rc}) — endpoint unreachable or TLS handshake failed."
elif [ "${http_code}" != "${EXPECTED_CODE}" ]; then
  failure_reason="Expected HTTP ${EXPECTED_CODE} but observed HTTP ${http_code}."
elif [ -z "${api_version}" ]; then
  failure_reason="HTTP ${http_code} received but X-API-Version header is missing (request may not have traversed the operational HTTPS path)."
fi

if [ -z "${failure_reason}" ]; then
  echo "smoke-https: PASS — ${HEALTH_URL} -> HTTP ${http_code}, X-API-Version=${api_version}${hsts:+, HSTS present}"
  exit 0
fi

# ---- FAILURE: record a tracked fix item, then fail the run -------------------
fix_id="FIX-$(date -u +%s)"
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$(dirname "${FIX_ITEMS_LOG}")"
if [ ! -f "${FIX_ITEMS_LOG}" ]; then
  {
    echo "# Launch Fix Items — Tracked Failures"
    echo
    echo "> Auto-appended tracked fix items (Req 9.3 / 9.5). Each entry is a launch-blocking"
    echo "> failure to triage and resolve before re-running the cross-repo suites."
    echo
  } > "${FIX_ITEMS_LOG}"
fi

{
  echo "## ${fix_id} — HTTPS smoke check failed (${timestamp})"
  echo
  echo "- **Source:** \`scripts/smoke-https.sh\` (Task 12.2, Requirement 9.3)"
  echo "- **Endpoint probed:** \`${HEALTH_URL}\`"
  echo "- **Expected:** HTTP ${EXPECTED_CODE} over HTTPS with \`X-API-Version\` header."
  echo "- **Observed:** HTTP ${http_code}; X-API-Version=\"${api_version:-<missing>}\"; curl exit ${curl_rc}."
  echo "- **Reason:** ${failure_reason}"
  echo "- **Status:** OPEN — backend is not a valid HTTPS target; Contract_Test_Suite / E2E_Suite must not run until resolved."
  echo
} >> "${FIX_ITEMS_LOG}"

echo "smoke-https: FAIL — ${failure_reason}" >&2
echo "smoke-https: recorded tracked fix item ${fix_id} in ${FIX_ITEMS_LOG}" >&2
exit 1
