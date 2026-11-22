#!/usr/bin/env bash
#
# DevLaunch Growth Engine Phase 1 — end-to-end smoke test.
#
# Exercises the real API over HTTP against a live stack (Postgres + Redis +
# api + worker). Safely re-runnable: every run registers brand-new users /
# tenants / projects (timestamp + random suffix), so it never collides with
# data from a previous run and never assumes any pre-existing rows.
#
# Usage:
#   ./scripts/e2e-smoke-test.sh
#   API_BASE_URL=http://localhost:4000/api/v1 ./scripts/e2e-smoke-test.sh
#
# Requires: bash, curl, node (used only as a JSON parser/formatter — no npm
# packages, no extra dependencies).

set -u

API_BASE_URL="${API_BASE_URL:-http://localhost:4000/api/v1}"
POLL_TIMEOUT_SECS="${POLL_TIMEOUT_SECS:-10}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-1}"

PASS_COUNT=0
FAIL_COUNT=0
STEP_NUM=0

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

color_reset="\033[0m"
color_green="\033[32m"
color_red="\033[31m"
color_yellow="\033[33m"

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf "${color_green}PASS${color_reset} [%02d] %s\n" "$STEP_NUM" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf "${color_red}FAIL${color_reset} [%02d] %s\n" "$STEP_NUM" "$1"
  if [ -n "${2:-}" ]; then
    printf "       -> %s\n" "$2"
  fi
}

info() {
  printf "${color_yellow}     %s${color_reset}\n" "$1"
}

step() {
  STEP_NUM=$((STEP_NUM + 1))
  echo
  echo "--- Step $STEP_NUM: $1 ---"
}

# Extract a dotted-path field from a JSON string using node (no jq dependency).
# Usage: json_get '<json>' 'path.to.field'
# Returns empty string (and prints nothing) if the path is missing/null.
json_get() {
  local json="$1"
  local path="$2"
  node -e '
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try {
        const obj = JSON.parse(data);
        const path = process.argv[1];
        let cur = obj;
        for (const part of path.split(".")) {
          if (cur === null || cur === undefined) { cur = undefined; break; }
          cur = cur[part];
        }
        if (cur === undefined || cur === null) {
          process.stdout.write("");
        } else if (typeof cur === "object") {
          process.stdout.write(JSON.stringify(cur));
        } else {
          process.stdout.write(String(cur));
        }
      } catch (e) {
        process.stdout.write("");
      }
    });
  ' "$path" <<< "$json"
}

# Performs an HTTP request and captures body + status code.
# Sets globals: HTTP_BODY, HTTP_STATUS
# Usage: http_call METHOD PATH [JSON_BODY] [EXTRA_CURL_ARGS...]
http_call() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  shift 3 2>/dev/null || shift $#
  local extra_args=("$@")

  local url="${API_BASE_URL}${path}"
  local tmp_body
  tmp_body="$(mktemp)"

  local curl_args=(-sS -o "$tmp_body" -w "%{http_code}" -X "$method" "$url" -H "Content-Type: application/json")
  if [ -n "$body" ]; then
    curl_args+=(-d "$body")
  fi
  curl_args+=("${extra_args[@]}")

  HTTP_STATUS="$(curl "${curl_args[@]}" 2>/dev/null)"
  HTTP_BODY="$(cat "$tmp_body")"
  rm -f "$tmp_body"
}

is_2xx() {
  case "$1" in
    2??) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# unique identifiers for this run
# ---------------------------------------------------------------------------

RUN_ID="$(date +%s)${RANDOM}"
USER1_EMAIL="smoke-user1-${RUN_ID}@example.com"
USER2_EMAIL="smoke-user2-${RUN_ID}@example.com"
PASSWORD="SmokeTest123!"
TENANT1_SLUG="smoke-tenant1-${RUN_ID}"
TENANT2_SLUG="smoke-tenant2-${RUN_ID}"
PROJECT_SLUG="smoke-project-${RUN_ID}"
ALLOWED_ORIGIN="https://smoke-allowed-${RUN_ID}.example.com"
DISALLOWED_ORIGIN="https://smoke-disallowed-${RUN_ID}.example.com"

echo "============================================================"
echo "DevLaunch Growth Engine Phase 1 — E2E smoke test"
echo "API_BASE_URL = ${API_BASE_URL}"
echo "run id       = ${RUN_ID}"
echo "============================================================"

# ---------------------------------------------------------------------------
# Step 1: health check
# ---------------------------------------------------------------------------

step "Health check (GET /health)"
http_call GET "/health"
STATUS_FIELD="$(json_get "$HTTP_BODY" status)"
if is_2xx "$HTTP_STATUS" && [ "$STATUS_FIELD" = "ok" ]; then
  pass "GET /health returned 200 with status=ok"
else
  fail "GET /health did not return ok" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

# ---------------------------------------------------------------------------
# Step 2: register + login user 1, capture access token
# ---------------------------------------------------------------------------

step "Register user 1 (${USER1_EMAIL})"
http_call POST "/auth/register" "{\"email\":\"${USER1_EMAIL}\",\"password\":\"${PASSWORD}\",\"fullName\":\"Smoke User One\"}"
if is_2xx "$HTTP_STATUS"; then
  pass "Registered user 1"
else
  fail "Could not register user 1" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

step "Log in as user 1"
http_call POST "/auth/login" "{\"email\":\"${USER1_EMAIL}\",\"password\":\"${PASSWORD}\"}"
USER1_TOKEN="$(json_get "$HTTP_BODY" accessToken)"
if is_2xx "$HTTP_STATUS" && [ -n "$USER1_TOKEN" ]; then
  pass "Logged in as user 1, captured access token"
else
  fail "Login for user 1 failed" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi
AUTH1=(-H "Authorization: Bearer ${USER1_TOKEN}")

# ---------------------------------------------------------------------------
# Step 3: create tenant + project
# ---------------------------------------------------------------------------

step "Create tenant for user 1"
http_call POST "/tenants" "{\"slug\":\"${TENANT1_SLUG}\",\"name\":\"Smoke Tenant One\"}" "${AUTH1[@]}"
TENANT1_ID="$(json_get "$HTTP_BODY" tenant.id)"
if is_2xx "$HTTP_STATUS" && [ -n "$TENANT1_ID" ]; then
  pass "Created tenant 1 (id=${TENANT1_ID})"
else
  fail "Could not create tenant 1" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

step "Create project under tenant 1"
http_call POST "/tenants/${TENANT1_ID}/projects" "{\"name\":\"Smoke Project\",\"slug\":\"${PROJECT_SLUG}\"}" "${AUTH1[@]}"
PROJECT1_ID="$(json_get "$HTTP_BODY" project.id)"
if is_2xx "$HTTP_STATUS" && [ -n "$PROJECT1_ID" ]; then
  pass "Created project (id=${PROJECT1_ID})"
else
  fail "Could not create project" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

# ---------------------------------------------------------------------------
# Step 4: enable public widget + set allowed origin
# ---------------------------------------------------------------------------

step "Enable public widget + set allowed origin on project"
http_call PATCH "/tenants/${TENANT1_ID}/projects/${PROJECT1_ID}" \
  "{\"publicWidgetEnabled\":true,\"allowedOrigins\":[\"${ALLOWED_ORIGIN}\"]}" "${AUTH1[@]}"
WIDGET_ENABLED="$(json_get "$HTTP_BODY" project.public_widget_enabled)"
PROJECT_PUBLIC_KEY="$(json_get "$HTTP_BODY" project.public_api_key)"
ALLOWED_ORIGINS_JSON="$(json_get "$HTTP_BODY" project.allowed_origins)"
if is_2xx "$HTTP_STATUS" && [ "$WIDGET_ENABLED" = "true" ] && [[ "$ALLOWED_ORIGINS_JSON" == *"$ALLOWED_ORIGIN"* ]] && [ -n "$PROJECT_PUBLIC_KEY" ]; then
  pass "PATCH project reflects publicWidgetEnabled=true and allowed origin (public_api_key=${PROJECT_PUBLIC_KEY})"
else
  fail "Widget settings did not persist as expected" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

# ---------------------------------------------------------------------------
# Step 5: public lead from allowed origin succeeds
# ---------------------------------------------------------------------------

step "Submit public lead with allowed Origin header (expect 2xx + lead id)"
http_call POST "/public/projects/${PROJECT_PUBLIC_KEY}/leads" \
  "{\"name\":\"Allowed Lead\",\"email\":\"lead-allowed-${RUN_ID}@example.com\"}" \
  -H "Origin: ${ALLOWED_ORIGIN}"
LEAD_ID="$(json_get "$HTTP_BODY" lead.id)"
if is_2xx "$HTTP_STATUS" && [ -n "$LEAD_ID" ]; then
  pass "Lead captured from allowed origin (lead id=${LEAD_ID})"
else
  fail "Lead submission from allowed origin failed" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

# ---------------------------------------------------------------------------
# Step 6: public lead from disallowed origin is rejected (403)
# ---------------------------------------------------------------------------

step "Submit public lead with DISALLOWED Origin header (expect 403)"
http_call POST "/public/projects/${PROJECT_PUBLIC_KEY}/leads" \
  "{\"name\":\"Disallowed Lead\",\"email\":\"lead-disallowed-${RUN_ID}@example.com\"}" \
  -H "Origin: ${DISALLOWED_ORIGIN}"
if [ "$HTTP_STATUS" = "403" ]; then
  pass "Disallowed-origin lead correctly rejected with 403"
else
  fail "Disallowed-origin lead was not rejected with 403 as expected" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

# ---------------------------------------------------------------------------
# Step 7: agent templates -> instance -> run -> poll to terminal status
# ---------------------------------------------------------------------------

step "List agent templates and find 'market-research'"
http_call GET "/agent-templates" "" "${AUTH1[@]}"
TEMPLATE_ID="$(node -e '
  let data = "";
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => {
    try {
      const obj = JSON.parse(data);
      const list = obj.agentTemplates || [];
      const match = list.find((t) => t.key === "market-research");
      process.stdout.write(match ? match.id : "");
    } catch (e) {
      process.stdout.write("");
    }
  });
' <<< "$HTTP_BODY")"
if is_2xx "$HTTP_STATUS" && [ -n "$TEMPLATE_ID" ]; then
  pass "Found market-research template (id=${TEMPLATE_ID})"
else
  fail "Could not find market-research agent template" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

step "Create agent instance from market-research template"
http_call POST "/tenants/${TENANT1_ID}/projects/${PROJECT1_ID}/agent-instances" \
  "{\"templateId\":\"${TEMPLATE_ID}\",\"name\":\"Smoke Market Research\"}" "${AUTH1[@]}"
AGENT_INSTANCE_ID="$(json_get "$HTTP_BODY" agentInstance.id)"
if is_2xx "$HTTP_STATUS" && [ -n "$AGENT_INSTANCE_ID" ]; then
  pass "Created agent instance (id=${AGENT_INSTANCE_ID})"
else
  fail "Could not create agent instance" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

step "Queue an agent run"
http_call POST "/tenants/${TENANT1_ID}/projects/${PROJECT1_ID}/agent-runs" \
  "{\"agentInstanceId\":\"${AGENT_INSTANCE_ID}\",\"input\":{\"industry\":\"education\",\"geography\":\"India\",\"segment\":\"engineering colleges\",\"question\":\"smoke test\"}}" "${AUTH1[@]}"
EXECUTION_ID="$(json_get "$HTTP_BODY" executionId)"
if is_2xx "$HTTP_STATUS" && [ -n "$EXECUTION_ID" ]; then
  pass "Queued agent run (executionId=${EXECUTION_ID})"
else
  fail "Could not queue agent run" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

step "Poll execution until terminal status (timeout ${POLL_TIMEOUT_SECS}s)"
FINAL_STATUS=""
FINAL_BODY=""
if [ -n "$EXECUTION_ID" ]; then
  elapsed=0
  while [ "$elapsed" -lt "$POLL_TIMEOUT_SECS" ]; do
    http_call GET "/tenants/${TENANT1_ID}/agent-executions/${EXECUTION_ID}" "" "${AUTH1[@]}"
    CUR_STATUS="$(json_get "$HTTP_BODY" status)"
    case "$CUR_STATUS" in
      succeeded|failed|needs_approval)
        FINAL_STATUS="$CUR_STATUS"
        FINAL_BODY="$HTTP_BODY"
        break
        ;;
    esac
    sleep "$POLL_INTERVAL_SECS"
    elapsed=$((elapsed + POLL_INTERVAL_SECS))
  done
  if [ -z "$FINAL_STATUS" ]; then
    FINAL_STATUS="$CUR_STATUS"
    FINAL_BODY="$HTTP_BODY"
  fi
fi

if [ "$FINAL_STATUS" = "succeeded" ] || [ "$FINAL_STATUS" = "failed" ] || [ "$FINAL_STATUS" = "needs_approval" ]; then
  pass "Execution reached terminal status: ${FINAL_STATUS}"
else
  fail "Execution did not reach a terminal status within ${POLL_TIMEOUT_SECS}s" "last_status=${FINAL_STATUS:-<none>} body=$FINAL_BODY"
fi

step "Assert execution status is 'succeeded' with a result object present"
RESULT_FIELD="$(json_get "$FINAL_BODY" result)"
if [ "$FINAL_STATUS" = "succeeded" ] && [ -n "$RESULT_FIELD" ] && [ "$RESULT_FIELD" != "null" ]; then
  pass "Execution succeeded with a result object (${RESULT_FIELD:0:120}...)"
else
  fail "Execution did not succeed with a result object" "status=${FINAL_STATUS:-<none>} body=$FINAL_BODY"
fi

# ---------------------------------------------------------------------------
# Step 8: tenant isolation — second user/tenant cannot read first tenant's data
# ---------------------------------------------------------------------------

step "Register + log in SECOND user, create their own tenant"
http_call POST "/auth/register" "{\"email\":\"${USER2_EMAIL}\",\"password\":\"${PASSWORD}\",\"fullName\":\"Smoke User Two\"}"
if is_2xx "$HTTP_STATUS"; then
  pass "Registered user 2"
else
  fail "Could not register user 2" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

http_call POST "/auth/login" "{\"email\":\"${USER2_EMAIL}\",\"password\":\"${PASSWORD}\"}"
USER2_TOKEN="$(json_get "$HTTP_BODY" accessToken)"
if is_2xx "$HTTP_STATUS" && [ -n "$USER2_TOKEN" ]; then
  pass "Logged in as user 2, captured access token"
else
  fail "Login for user 2 failed" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi
AUTH2=(-H "Authorization: Bearer ${USER2_TOKEN}")

http_call POST "/tenants" "{\"slug\":\"${TENANT2_SLUG}\",\"name\":\"Smoke Tenant Two\"}" "${AUTH2[@]}"
TENANT2_ID="$(json_get "$HTTP_BODY" tenant.id)"
if is_2xx "$HTTP_STATUS" && [ -n "$TENANT2_ID" ]; then
  pass "Created tenant 2 for user 2 (id=${TENANT2_ID})"
else
  fail "Could not create tenant 2" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

step "User 2 attempts to read tenant 1's project by id (via tenant 2's path) — expect 403/404"
http_call GET "/tenants/${TENANT2_ID}/projects/${PROJECT1_ID}" "" "${AUTH2[@]}"
if [ "$HTTP_STATUS" = "403" ] || [ "$HTTP_STATUS" = "404" ]; then
  pass "Cross-tenant project read correctly rejected (status=${HTTP_STATUS})"
else
  fail "Cross-tenant project read was NOT rejected as expected" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

step "User 2 attempts to read tenant 1's execution directly via tenant 1's own path — expect 403/404"
http_call GET "/tenants/${TENANT1_ID}/agent-executions/${EXECUTION_ID}" "" "${AUTH2[@]}"
if [ "$HTTP_STATUS" = "403" ] || [ "$HTTP_STATUS" = "404" ]; then
  pass "Cross-tenant execution read correctly rejected (status=${HTTP_STATUS})"
else
  fail "Cross-tenant execution read was NOT rejected as expected" "http_status=$HTTP_STATUS body=$HTTP_BODY"
fi

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------

echo
echo "============================================================"
echo "SUMMARY: ${PASS_COUNT} passed, ${FAIL_COUNT} failed (run id ${RUN_ID})"
echo "============================================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
