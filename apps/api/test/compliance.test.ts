import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as discovery.test.ts / publicLeads.test.ts: fake the
// pg pool so these are true unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const {
  suppressionRouter,
  consentRecordsRouter,
  countrySendSettingsRouter,
  publicUnsubscribeRouter,
} = await import("../src/routes/compliance.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const {
  isSuppressed,
  hasConsent,
  isCountrySendAllowed,
  checkSendEligibility,
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
} = await import("../src/lib/suppression.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/suppression-list", suppressionRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/consent-records", consentRecordsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/country-send-settings", countrySendSettingsRouter);
  app.use("/api/v1/public", publicUnsubscribeRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

function mockTenantDbQuery(responses: unknown[]) {
  // Used for direct suppression.ts unit tests: a minimal fake PoolClient.
  const q = vi.fn();
  for (const r of responses) q.mockResolvedValueOnce(r);
  return { query: q } as unknown as import("pg").PoolClient;
}

describe("suppression.ts: isSuppressed", () => {
  it("returns not suppressed when no row matches", async () => {
    const tenantDb = mockTenantDbQuery([{ rowCount: 0, rows: [] }]);
    const result = await isSuppressed(tenantDb, TENANT_A, { email: "a@example.com", channel: "email" });
    expect(result).toEqual({ suppressed: false });
  });

  it("returns suppressed with reason when a matching row exists", async () => {
    const tenantDb = mockTenantDbQuery([{ rowCount: 1, rows: [{ reason: "unsubscribed" }] }]);
    const result = await isSuppressed(tenantDb, TENANT_A, { email: "a@example.com", channel: "email" });
    expect(result).toEqual({ suppressed: true, reason: "unsubscribed" });
  });

  it("returns not suppressed when neither email nor phone is provided (short-circuits, no query)", async () => {
    const tenantDb = mockTenantDbQuery([]);
    const result = await isSuppressed(tenantDb, TENANT_A, { channel: "email" });
    expect(result).toEqual({ suppressed: false });
  });
});

describe("suppression.ts: hasConsent", () => {
  it("returns false when no consent row matches", async () => {
    const tenantDb = mockTenantDbQuery([{ rowCount: 0, rows: [] }]);
    const result = await hasConsent(tenantDb, TENANT_A, { email: "a@example.com", channel: "email" });
    expect(result).toBe(false);
  });

  it("returns true when the most recent matching row has consent_given=true", async () => {
    const tenantDb = mockTenantDbQuery([{ rowCount: 1, rows: [{ consent_given: true }] }]);
    const result = await hasConsent(tenantDb, TENANT_A, { leadId: "lead-1", channel: "whatsapp" });
    expect(result).toBe(true);
  });

  it("returns false when the most recent matching row has consent_given=false", async () => {
    const tenantDb = mockTenantDbQuery([{ rowCount: 1, rows: [{ consent_given: false }] }]);
    const result = await hasConsent(tenantDb, TENANT_A, { phone: "+14155550132", channel: "sms" });
    expect(result).toBe(false);
  });
});

describe("suppression.ts: isCountrySendAllowed", () => {
  it("defaults to allowed=true, requiresExplicitConsent=false when no row is configured", async () => {
    const tenantDb = mockTenantDbQuery([{ rowCount: 0, rows: [] }]);
    const result = await isCountrySendAllowed(tenantDb, TENANT_A, { countryCode: "de", channel: "email" });
    expect(result).toEqual({ allowed: true, requiresExplicitConsent: false });
  });

  it("reflects a configured restrictive row", async () => {
    const tenantDb = mockTenantDbQuery([
      { rowCount: 1, rows: [{ sending_allowed: false, requires_explicit_consent: true }] },
    ]);
    const result = await isCountrySendAllowed(tenantDb, TENANT_A, { countryCode: "DE", channel: "whatsapp" });
    expect(result).toEqual({ allowed: false, requiresExplicitConsent: true });
  });
});

describe("suppression.ts: checkSendEligibility", () => {
  it("is eligible when nothing blocks", async () => {
    const tenantDb = mockTenantDbQuery([
      { rowCount: 0, rows: [] }, // isSuppressed
      { rowCount: 0, rows: [] }, // isCountrySendAllowed (no country passed -> not even queried, see below)
    ]);
    const result = await checkSendEligibility(tenantDb, TENANT_A, {
      email: "a@example.com",
      channel: "email",
    });
    expect(result).toEqual({ eligible: true, blockReasons: [] });
  });

  it("collects every blocking reason instead of stopping at the first", async () => {
    const tenantDb = mockTenantDbQuery([
      { rowCount: 1, rows: [{ reason: "bounced" }] }, // isSuppressed -> suppressed
      { rowCount: 1, rows: [{ sending_allowed: false, requires_explicit_consent: true }] }, // isCountrySendAllowed
      { rowCount: 0, rows: [] }, // hasConsent -> no consent on file
    ]);
    const result = await checkSendEligibility(tenantDb, TENANT_A, {
      email: "a@example.com",
      channel: "email",
      countryCode: "DE",
    });
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toEqual(
      expect.arrayContaining(["suppressed:bounced", "country_not_allowed", "consent_required"]),
    );
    expect(result.blockReasons).toHaveLength(3);
  });

  it("does not require consent when the country does not require it", async () => {
    const tenantDb = mockTenantDbQuery([
      { rowCount: 0, rows: [] }, // isSuppressed
      { rowCount: 1, rows: [{ sending_allowed: true, requires_explicit_consent: false }] }, // isCountrySendAllowed
    ]);
    const result = await checkSendEligibility(tenantDb, TENANT_A, {
      email: "a@example.com",
      channel: "email",
      countryCode: "US",
    });
    expect(result).toEqual({ eligible: true, blockReasons: [] });
  });
});

describe("suppression.ts: unsubscribe token roundtrip", () => {
  it("generates and verifies a token for a leadId subject", () => {
    const token = generateUnsubscribeToken({ tenantId: TENANT_A, leadId: "lead-1" });
    const verified = verifyUnsubscribeToken(token);
    expect(verified).toEqual({ tenantId: TENANT_A, leadId: "lead-1", email: null });
  });

  it("generates and verifies a token for an email subject", () => {
    const token = generateUnsubscribeToken({ tenantId: TENANT_A, email: "a@example.com" });
    const verified = verifyUnsubscribeToken(token);
    expect(verified).toEqual({ tenantId: TENANT_A, leadId: null, email: "a@example.com" });
  });

  it("throws when neither leadId nor email is given", () => {
    expect(() => generateUnsubscribeToken({ tenantId: TENANT_A })).toThrow();
  });

  it("rejects a tampered token (flipped signature)", () => {
    const token = generateUnsubscribeToken({ tenantId: TENANT_A, email: "a@example.com" });
    const [payload, signature] = token.split(".");
    const tampered = `${payload}.${signature.slice(0, -1)}${signature.at(-1) === "a" ? "b" : "a"}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("rejects a tampered payload (different email than was signed)", () => {
    const tokenA = generateUnsubscribeToken({ tenantId: TENANT_A, email: "a@example.com" });
    const tokenB = generateUnsubscribeToken({ tenantId: TENANT_A, email: "b@example.com" });
    const [, signatureB] = tokenB.split(".");
    const [payloadA] = tokenA.split(".");
    const frankensteined = `${payloadA}.${signatureB}`;
    expect(verifyUnsubscribeToken(frankensteined)).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("not-a-token")).toBeNull();
    expect(verifyUnsubscribeToken("a.b.c")).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("denies GET /suppression-list when the caller has no active membership", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/suppression-list`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });
});

describe("suppression-list route validation", () => {
  it("lists suppression entries", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: "s1", email: "a@example.com", channel: "email", reason: "manual" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/suppression-list`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.suppressionEntries).toHaveLength(1);
  });

  it("rejects POST with neither email nor phone", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/suppression-list`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "email" });

    expect(res.status).toBe(400);
  });

  it("creates a manual suppression entry, defaulting reason to 'manual'", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: "s1", email: "a@example.com", channel: "email", reason: "manual" }],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/suppression-list`)
      .set("X-Dev-User-Id", USER_1)
      .send({ email: "a@example.com", channel: "email" });

    expect(res.status).toBe(201);
    expect(res.body.suppressionEntry.reason).toBe("manual");

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO suppression_list"),
    );
    expect(insertCall![1][3]).toBe("manual");
  });

  it("returns 409 when the insert conflicts with an existing unique entry", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/suppression-list`)
      .set("X-Dev-User-Id", USER_1)
      .send({ email: "a@example.com", channel: "email" });

    expect(res.status).toBe(409);
  });

  it("deletes a suppression entry by id", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }, { rowCount: 1, rows: [{ id: "s1" }] }]);

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/suppression-list/44444444-4444-4444-4444-444444444444`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(204);
  });

  it("404s deleting a suppression entry that doesn't exist", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/suppression-list/44444444-4444-4444-4444-444444444444`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("consent-records route validation", () => {
  it("rejects POST with none of leadId/email/phone", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/consent-records`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "email", consentGiven: true, consentSource: "explicit_optin" });

    expect(res.status).toBe(400);
  });

  it("creates a consent record", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: "c1", consent_given: true }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/consent-records`)
      .set("X-Dev-User-Id", USER_1)
      .send({ email: "a@example.com", channel: "email", consentGiven: true, consentSource: "explicit_optin" });

    expect(res.status).toBe(201);
  });

  it("filters list by leadId query param", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/consent-records?leadId=55555555-5555-5555-5555-555555555555`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const listCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM consent_records"),
    );
    expect(listCall![1][1]).toBe("55555555-5555-5555-5555-555555555555");
  });
});

describe("country-send-settings route validation", () => {
  it("rejects an invalid country code length", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/country-send-settings`)
      .set("X-Dev-User-Id", USER_1)
      .send({ countryCode: "DEU", channel: "email" });

    expect(res.status).toBe(400);
  });

  it("upserts a country+channel row", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: "cs1", country_code: "DE", channel: "email", sending_allowed: true }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/country-send-settings`)
      .set("X-Dev-User-Id", USER_1)
      .send({ countryCode: "de", channel: "email" });

    expect(res.status).toBe(201);
    expect(res.body.countrySendSetting.country_code).toBe("DE");
  });

  it("patches a country+channel row", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: "cs1", sending_allowed: false }] },
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/country-send-settings/44444444-4444-4444-4444-444444444444`)
      .set("X-Dev-User-Id", USER_1)
      .send({ sendingAllowed: false });

    expect(res.status).toBe(200);
    expect(res.body.countrySendSetting.sending_allowed).toBe(false);
  });

  it("404s patching a row that doesn't exist", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/country-send-settings/44444444-4444-4444-4444-444444444444`)
      .set("X-Dev-User-Id", USER_1)
      .send({ sendingAllowed: false });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/public/unsubscribe", () => {
  it("rejects a malformed/tampered token with 400 and never writes anything", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/v1/public/unsubscribe").send({ token: "garbage.token" });

    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("accepts a valid token carrying an email and inserts into suppression_list", async () => {
    const token = generateUnsubscribeToken({ tenantId: TENANT_A, email: "a@example.com" });
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      undefined, // insert suppression_list
      undefined, // COMMIT
    ]);

    const app = buildApp();
    const res = await request(app).post("/api/v1/public/unsubscribe").send({ token });

    expect(res.status).toBe(200);
    expect(res.body.unsubscribed).toBe(true);

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO suppression_list"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual([TENANT_A, "a@example.com"]);
  });

  it("accepts a valid token carrying only a leadId, resolving its email first", async () => {
    const token = generateUnsubscribeToken({ tenantId: TENANT_A, leadId: "lead-1" });
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 1, rows: [{ email: "lead@example.com" }] }, // lead lookup
      undefined, // insert suppression_list
      undefined, // COMMIT
    ]);

    const app = buildApp();
    const res = await request(app).post("/api/v1/public/unsubscribe").send({ token });

    expect(res.status).toBe(200);
    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO suppression_list"),
    );
    expect(insertCall![1]).toEqual([TENANT_A, "lead@example.com"]);
  });

  it("404s when the token's leadId can't be found", async () => {
    const token = generateUnsubscribeToken({ tenantId: TENANT_A, leadId: "missing-lead" });
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 0, rows: [] }, // lead lookup: not found
      undefined, // ROLLBACK
    ]);

    const app = buildApp();
    const res = await request(app).post("/api/v1/public/unsubscribe").send({ token });

    expect(res.status).toBe(404);
  });
});
