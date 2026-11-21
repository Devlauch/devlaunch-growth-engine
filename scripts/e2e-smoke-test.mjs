#!/usr/bin/env node
// Real, honest end-to-end smoke test against a REAL running stack.
// Run: node scripts/e2e-smoke-test.mjs
//
// Exercises real HTTP requests against http://localhost:4000/api/v1 — no
// mocking, no direct DB access (except nothing at all: every assertion goes
// through the API the same way a real client would).
//
// Exit code is non-zero if anything failed.

const BASE = process.env.API_BASE_URL ?? "http://localhost:4000/api/v1";

const results = [];
let failed = false;

function pass(name, detail) {
  results.push({ name, ok: true });
  console.log(`PASS - ${name}${detail ? " (" + detail + ")" : ""}`);
}

function fail(name, detail) {
  failed = true;
  results.push({ name, ok: false, detail });
  console.log(`FAIL - ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function call(method, path, { body, headers = {}, origin } = {}) {
  const h = { "content-type": "application/json", ...headers };
  if (origin) h["origin"] = origin;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

function expect(cond, name, detail) {
  if (cond) pass(name);
  else fail(name, detail);
}

function rand(n = 8) {
  return Math.random().toString(36).slice(2, 2 + n);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = Number(process.env.E2E_SETTLE_MS ?? 0);

async function main() {
  console.log(`Target API: ${BASE}\n`);

  // ---------------------------------------------------------------------
  // 1. Health
  // ---------------------------------------------------------------------
  {
    const r = await call("GET", "/health");
    expect(r.status === 200, "GET /health returns 200", `status=${r.status} body=${JSON.stringify(r.body)}`);
  }

  // ---------------------------------------------------------------------
  // 2. Auth: register two brand-new users (A = main actor, B = isolation check)
  // ---------------------------------------------------------------------
  const emailA = `e2e-${rand()}@example.com`;
  const emailB = `e2e-${rand()}@example.com`;
  let userA, userB, tokenA;

  {
    const r = await call("POST", "/auth/register", {
      body: { email: emailA, password: "correct horse battery staple", fullName: "E2E User A" },
    });
    expect(r.status === 201, "POST /auth/register creates user A", `status=${r.status} body=${JSON.stringify(r.body)}`);
    if (r.status === 201) {
      userA = r.body.user;
      tokenA = r.body.accessToken;
    }
  }

  {
    const r = await call("POST", "/auth/register", {
      body: { email: emailB, password: "correct horse battery staple", fullName: "E2E User B" },
    });
    expect(r.status === 201, "POST /auth/register creates user B", `status=${r.status} body=${JSON.stringify(r.body)}`);
    if (r.status === 201) userB = r.body.user;
  }

  if (!userA || !userB) {
    console.log("\nCannot continue without both users. Aborting.");
    process.exit(1);
  }

  const authA = { Authorization: `Bearer ${tokenA}` };

  // ---------------------------------------------------------------------
  // 3. Tenant + project, created end-to-end via the real API (user A becomes owner)
  // ---------------------------------------------------------------------
  let tenantId, projectId, publicApiKey;
  const originUrl = "http://localhost:5555";

  {
    const r = await call("POST", "/tenants", {
      headers: authA,
      body: { slug: `e2e-${rand()}`, name: "E2E Smoke Test Tenant", industry: "testing" },
    });
    expect(r.status === 201, "POST /tenants creates tenant (A becomes owner)", `status=${r.status} body=${JSON.stringify(r.body)}`);
    if (r.status === 201) tenantId = r.body.tenant.id;
  }

  if (!tenantId) {
    console.log("\nCannot continue without a tenant. Aborting.");
    process.exit(1);
  }

  {
    const r = await call("POST", `/tenants/${tenantId}/projects`, {
      headers: authA,
      body: { name: "E2E Project", slug: `e2e-proj-${rand()}` },
    });
    expect(r.status === 201, "POST .../projects creates project", `status=${r.status} body=${JSON.stringify(r.body)}`);
    if (r.status === 201) {
      projectId = r.body.project.id;
      publicApiKey = r.body.project.public_api_key;
    }
  }

  if (!projectId) {
    console.log("\nCannot continue without a project. Aborting.");
    process.exit(1);
  }

  await sleep(SETTLE_MS);

  // enable the public widget + allowlist our test origin, via the real API
  {
    const r = await call("PATCH", `/tenants/${tenantId}/projects/${projectId}`, {
      headers: authA,
      body: { publicWidgetEnabled: true, allowedOrigins: [originUrl] },
    });
    expect(
      r.status === 200 && r.body.project.public_widget_enabled === true,
      "PATCH project enables public widget + allowlists test origin",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  await sleep(SETTLE_MS);

  // ---------------------------------------------------------------------
  // 4. Public lead capture widget -> confirm via authenticated leads list
  // ---------------------------------------------------------------------
  const leadEmail = `lead-${rand()}@example.com`;
  {
    const r = await call("POST", `/public/projects/${publicApiKey}/leads`, {
      origin: originUrl,
      body: { name: "Jane Prospect", email: leadEmail, message: "Interested in your product" },
    });
    expect(r.status === 201, "POST public lead-capture widget accepts a synthetic lead", `status=${r.status} body=${JSON.stringify(r.body)}`);
  }

  await sleep(SETTLE_MS);

  {
    const r = await call("GET", `/tenants/${tenantId}/projects/${projectId}/leads`, { headers: authA });
    const found = Array.isArray(r.body?.leads) && r.body.leads.some((l) => l.email === leadEmail);
    expect(
      r.status === 200 && found,
      "GET authenticated leads list contains the publicly-captured lead",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  // ---------------------------------------------------------------------
  // 5. ICP profile create + list
  // ---------------------------------------------------------------------
  {
    const r = await call("POST", `/tenants/${tenantId}/projects/${projectId}/icp-profiles`, {
      headers: authA,
      body: { name: "E2E ICP", segment: "e2e_segment", description: "Smoke test ICP", painPoints: ["pain1"], channels: ["email"] },
    });
    expect(r.status === 201, "POST icp-profiles creates an ICP profile", `status=${r.status} body=${JSON.stringify(r.body)}`);
  }

  {
    const r = await call("GET", `/tenants/${tenantId}/projects/${projectId}/icp-profiles`, { headers: authA });
    const found = Array.isArray(r.body?.icpProfiles) && r.body.icpProfiles.some((p) => p.name === "E2E ICP");
    expect(r.status === 200 && found, "GET icp-profiles lists the created profile", `status=${r.status} body=${JSON.stringify(r.body)}`);
  }

  // ---------------------------------------------------------------------
  // 6. Campaign: draft -> submit-for-approval -> approve -> confirm final state
  // ---------------------------------------------------------------------
  let campaignId, approvalId;
  {
    const r = await call("POST", `/tenants/${tenantId}/projects/${projectId}/campaigns`, {
      headers: authA,
      body: { name: "E2E Campaign", channel: "email" },
    });
    expect(
      r.status === 201 && r.body.campaign?.status === "draft",
      "POST campaigns creates a draft campaign",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
    if (r.status === 201) campaignId = r.body.campaign.id;
  }

  await sleep(SETTLE_MS);

  if (campaignId) {
    const r = await call("POST", `/tenants/${tenantId}/projects/${projectId}/campaigns/${campaignId}/submit-for-approval`, {
      headers: authA,
    });
    expect(
      r.status === 201 && r.body.campaign?.status === "pending_approval" && r.body.approval?.status === "pending",
      "POST submit-for-approval moves campaign to pending_approval and creates an approval",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
    if (r.status === 201) approvalId = r.body.approval.id;
  }

  await sleep(SETTLE_MS);

  if (approvalId) {
    const r = await call("POST", `/tenants/${tenantId}/approvals/${approvalId}/decision`, {
      headers: authA,
      body: { decision: "approved" },
    });
    expect(
      r.status === 200 && r.body.approval?.status === "approved",
      "POST approvals/:id/decision approves the pending approval",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  await sleep(SETTLE_MS);

  if (campaignId) {
    const r = await call("GET", `/tenants/${tenantId}/projects/${projectId}/campaigns/${campaignId}`, { headers: authA });
    expect(
      r.status === 200 && r.body.campaign?.status === "approved",
      "GET campaign confirms final status is 'approved'",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  await sleep(SETTLE_MS);

  // ---------------------------------------------------------------------
  // 7. Analytics overview
  // ---------------------------------------------------------------------
  {
    const r = await call("GET", `/tenants/${tenantId}/projects/${projectId}/analytics/overview`, { headers: authA });
    const shapeOk =
      r.body &&
      typeof r.body.leads?.total === "number" &&
      Array.isArray(r.body.leads?.byStatus) &&
      Array.isArray(r.body.campaigns?.byStatus) &&
      Array.isArray(r.body.agentExecutions?.byStatus);
    expect(
      r.status === 200 && shapeOk && r.body.leads.total >= 1,
      "GET analytics/overview returns real aggregate data (leads.total >= 1)",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  // ---------------------------------------------------------------------
  // 8. Integrations registry
  // ---------------------------------------------------------------------
  {
    const r = await call("GET", `/tenants/${tenantId}/projects/${projectId}/integrations`, { headers: authA });
    const allNotConnected =
      Array.isArray(r.body?.integrations) &&
      r.body.integrations.length === 6 &&
      r.body.integrations.every((i) => i.status === "not_connected");
    expect(
      r.status === 200 && allNotConnected,
      "GET integrations returns 6-provider registry, all honestly 'not_connected'",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  // ---------------------------------------------------------------------
  // 9. Discovery: source -> organization -> contact (with verification) -> duplicate detection
  // ---------------------------------------------------------------------
  let discoverySourceId;
  {
    const r = await call("POST", `/tenants/${tenantId}/projects/${projectId}/discovery-sources`, {
      headers: authA,
      body: { connectorType: "public_directory", name: "E2E discovery source" },
    });
    expect(
      r.status === 201,
      "POST discovery-sources creates a source (public_directory — the only approved connector type)",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
    if (r.status === 201) discoverySourceId = r.body.discoverySource.id;
  }

  // Sanity-check the documented rejection of not-yet-approved connector types
  // (csv_upload), since the task explicitly calls this connector type out.
  {
    const r = await call("POST", `/tenants/${tenantId}/projects/${projectId}/discovery-sources`, {
      headers: authA,
      body: { connectorType: "csv_upload", name: "Should be rejected" },
    });
    expect(
      r.status === 400,
      "POST discovery-sources rejects csv_upload (not wired up yet) with 400, not a 500/silent accept",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  const orgDomain = `e2e-${rand()}.example.com`;
  let orgId;
  {
    const r = await call("POST", `/tenants/${tenantId}/projects/${projectId}/discovered-organizations`, {
      headers: authA,
      body: {
        discoverySourceId,
        name: "E2E Discovered Org",
        domain: orgDomain,
        sourceUrl: `https://${orgDomain}`,
      },
    });
    expect(
      r.status === 201 && r.body.duplicate === false,
      "POST discovered-organizations creates a new organization",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
    if (r.status === 201) orgId = r.body.organization.id;
  }

  await sleep(SETTLE_MS);

  if (orgId) {
    const r = await call("POST", `/tenants/${tenantId}/projects/${projectId}/discovered-organizations/${orgId}/contacts`, {
      headers: authA,
      body: { name: "Dana Discovered", email: `dana-${rand()}@${orgDomain}`, contactChannel: "named_person" },
    });
    const vs = r.body?.contact?.verification_status;
    expect(
      r.status === 201 && typeof vs === "string" && vs.length > 0,
      "POST discovered contact returns a populated verification_status (real check, MX may fail in sandbox)",
      `status=${r.status} verification_status=${JSON.stringify(vs)} body=${JSON.stringify(r.body)}`,
    );
  }

  // Re-POST the exact same organization (same domain) -> duplicate detection
  {
    const r = await call("POST", `/tenants/${tenantId}/projects/${projectId}/discovered-organizations`, {
      headers: authA,
      body: {
        name: "E2E Discovered Org (resubmitted)",
        domain: orgDomain,
        sourceUrl: `https://${orgDomain}/again`,
      },
    });
    expect(
      r.status === 200 && r.body.duplicate === true && r.body.organization?.id === orgId,
      "Re-POSTing the same domain is detected as a duplicate (no second row)",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  // ---------------------------------------------------------------------
  // 10. Tenant isolation: user B (no membership) must NOT see tenant A's leads
  // ---------------------------------------------------------------------
  {
    const r = await call("GET", `/tenants/${tenantId}/projects/${projectId}/leads`, {
      headers: { "X-Dev-User-Id": userB.id },
    });
    expect(
      r.status === 401 || r.status === 403,
      "User B (no membership) is denied access to tenant A's leads (401/403, not data)",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  // Also verify via JWT-less dev-auth path is consistent: an entirely
  // unauthenticated request is also rejected (not silently scoped to nothing).
  {
    const r = await call("GET", `/tenants/${tenantId}/projects/${projectId}/leads`, {});
    expect(
      r.status === 401,
      "Fully unauthenticated request to a tenant-scoped route is rejected with 401",
      `status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  console.log("\n--- Summary ---");
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} checks passed`);
  for (const r of results) {
    if (!r.ok) console.log(`  FAILED: ${r.name}`);
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Unhandled error in smoke test:", err);
  process.exit(1);
});
