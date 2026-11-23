import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const USER_1 = "user-1";
const USER_2 = "user-2";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * Builds a fresh app + mocked pg pool for the integrations router, with
 * INTEGRATION_CREDENTIALS_KEY set to `credentialsKey` (or unset, the
 * default — matching every real environment that hasn't configured it).
 * Uses vi.resetModules()/vi.doMock() per-call so each test gets a clean
 * import of config/env.js (which reads process.env once at import time,
 * same convention as apps/api/test/meetings.test.ts's CALENDLY_API_KEY
 * handling).
 */
async function loadApp(credentialsKey?: string) {
  vi.resetModules();
  if (credentialsKey === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
  else process.env.INTEGRATION_CREDENTIALS_KEY = credentialsKey;

  const queryMock = vi.fn();
  const releaseMock = vi.fn();
  const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

  vi.doMock("../src/db/pool.js", () => ({ pool: { connect: connectMock } }));

  const { integrationsRouter } = await import("../src/routes/integrations.js");
  const { errorHandler } = await import("../src/middleware/errorHandler.js");

  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations", integrationsRouter);
  app.use(errorHandler);

  return { app, queryMock, releaseMock, connectMock };
}

afterEach(() => {
  delete process.env.INTEGRATION_CREDENTIALS_KEY;
  vi.doUnmock("../src/db/pool.js");
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(queryMock: ReturnType<typeof vi.fn>, responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

describe("tenant isolation on integrations routes", () => {
  it("denies a user with no active membership in the target tenant", async () => {
    const { app, queryMock, releaseMock } = await loadApp();
    queueResponses(queryMock, [undefined, undefined, { rowCount: 0, rows: [] }, undefined]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_B}/projects/${PROJECT_1}/integrations`)
      .set("X-Dev-User-Id", USER_2);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("FROM integrations"), expect.anything());
    expect(releaseMock).toHaveBeenCalled();
  });
});

describe("GET /integrations — real registry, never a fabricated 'connected' state", () => {
  it("defaults every provider (including chatwoot) to not_connected when no rows exist yet", async () => {
    const { app, queryMock } = await loadApp();
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // no integrations rows yet
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.integrations).toHaveLength(14);
    expect(res.body.integrations.some((i: { provider: string }) => i.provider === "chatwoot")).toBe(true);
    expect(res.body.integrations.some((i: { provider: string }) => i.provider === "hunter")).toBe(true);
    expect(res.body.integrations.some((i: { provider: string }) => i.provider === "clearbit")).toBe(true);
    expect(res.body.integrations.some((i: { provider: string }) => i.provider === "google_ads")).toBe(true);
    expect(res.body.integrations.some((i: { provider: string }) => i.provider === "meta_ads")).toBe(true);
    expect(res.body.integrations.some((i: { provider: string }) => i.provider === "whatsapp_business")).toBe(true);
    expect(res.body.integrations.some((i: { provider: string }) => i.provider === "apollo")).toBe(true);
    expect(res.body.integrations.some((i: { provider: string }) => i.provider === "google")).toBe(true);
    expect(res.body.integrations.every((i: { status: string }) => i.status === "not_connected")).toBe(true);
  });

  it("marks apollo and google as 'real' (unified credential path), never a fabricated 'connected' state with no row", async () => {
    const { app, queryMock } = await loadApp();
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 0, rows: [] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const apollo = res.body.integrations.find((i: { provider: string }) => i.provider === "apollo");
    const google = res.body.integrations.find((i: { provider: string }) => i.provider === "google");
    expect(apollo.real).toBe(true);
    expect(apollo.status).toBe("not_connected");
    expect(google.real).toBe(true);
    expect(google.status).toBe("not_connected");
  });

  it("merges in a real existing row's status and config instead of fabricating it", async () => {
    const { app, queryMock } = await loadApp();
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      {
        rowCount: 1,
        rows: [
          {
            id: "int-1",
            provider: "listmonk",
            status: "pending_setup",
            scopes: [],
            config: { baseUrl: "https://listmonk.example.com" },
            updated_at: "2026-11-20",
          },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const listmonk = res.body.integrations.find((i: { provider: string }) => i.provider === "listmonk");
    expect(listmonk.status).toBe("pending_setup");
    expect(listmonk.config).toEqual({ baseUrl: "https://listmonk.example.com" });
    expect(listmonk.hasSecret).toBe(true);
    expect(listmonk.real).toBe(true);
    const others = res.body.integrations.filter((i: { provider: string }) => i.provider !== "listmonk");
    expect(others.every((i: { status: string }) => i.status === "not_connected")).toBe(true);
  });
});

describe("POST /integrations/:provider/connect", () => {
  it("rejects an unknown provider", async () => {
    const { app, queryMock } = await loadApp();
    queueResponses(queryMock, [...mockMembership()]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/not-a-real-provider/connect`)
      .set("X-Dev-User-Id", USER_1)
      .send({ config: {} });

    expect(res.status).toBe(400);
  });

  it("stores config only (no secret) and sets status to pending_setup, never 'connected'", async () => {
    const { app, queryMock } = await loadApp();
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: "int-1", provider: "listmonk", status: "pending_setup", scopes: [], config: { baseUrl: "https://x" }, updated_at: "now" }],
      }, // INSERT ... ON CONFLICT ... RETURNING
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/listmonk/connect`)
      .set("X-Dev-User-Id", USER_1)
      .send({ config: { baseUrl: "https://x" } });

    expect(res.status).toBe(201);
    expect(res.body.integration.status).toBe("pending_setup");

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO integrations"),
    );
    expect(insertCall).toBeDefined();
    // [tenantId, projectId, provider, encryptedCredentialRef, configJson, userId]
    expect(insertCall![1]).toEqual([TENANT_A, PROJECT_1, "listmonk", null, JSON.stringify({ baseUrl: "https://x" }), USER_1]);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1][2]).toBe("integration.connected");
  });

  it("responds 501 and never stores plaintext when a secret is given but encryption isn't configured", async () => {
    const { app, queryMock } = await loadApp(); // no INTEGRATION_CREDENTIALS_KEY
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/connect`)
      .set("X-Dev-User-Id", USER_1)
      .send({ config: {}, secret: "real-chatwoot-token" });

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe("credential_encryption_not_configured");
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO integrations"), expect.anything());
  });

  it("encrypts the secret before storing it when encryption is configured", async () => {
    const { app, queryMock } = await loadApp(VALID_KEY);
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      {
        rowCount: 1,
        rows: [{ id: "int-1", provider: "chatwoot", status: "pending_setup", scopes: [], config: {}, updated_at: "now" }],
      },
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/connect`)
      .set("X-Dev-User-Id", USER_1)
      .send({ config: {}, secret: "real-chatwoot-token" });

    expect(res.status).toBe(201);

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO integrations"),
    );
    expect(insertCall).toBeDefined();
    const storedRef = insertCall![1][3] as string;
    expect(storedRef).not.toBeNull();
    expect(storedRef.startsWith("v1.")).toBe(true);
    expect(storedRef).not.toContain("real-chatwoot-token");

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    const auditMetadata = JSON.parse(auditCall![1][4] as string);
    expect(auditMetadata.secretProvided).toBe(true);
    expect(JSON.stringify(auditMetadata)).not.toContain("real-chatwoot-token");
  });
});

describe("POST /integrations/:provider/health-check", () => {
  it("404s when no integration row exists yet for this provider", async () => {
    const { app, queryMock } = await loadApp();
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // integration id lookup
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/postiz/health-check`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("honestly reports integration_not_yet_implemented when no provider client module exists (never a fabricated success)", async () => {
    // Uses 'mautic' rather than 'postiz' deliberately: Milestone 2's Agent D
    // has since landed a real apps/api/src/lib/postizClient.ts (with a real
    // checkHealth export) — postiz is no longer a "no client module" case.
    // 'mautic' remains registry-only (see docs/INTEGRATION_STATUS.md), so
    // it's still the right provider to exercise this "not implemented yet"
    // path with.
    const { app, queryMock } = await loadApp();
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: "int-1" }] }, // integration id lookup
      { rowCount: 1, rows: [{ config: { baseUrl: "https://x" }, encrypted_credential_ref: null, status: "pending_setup" }] }, // getIntegrationCredential
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/mautic/health-check`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("integration_not_yet_implemented");
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE integrations SET status"), expect.anything());

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1][2]).toBe("integration.health_checked");
  });

  it("honestly reports apollo as 'error' (never a fabricated 'connected') with a not-configured detail when no secret is stored", async () => {
    const { app, queryMock } = await loadApp();
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: "int-1" }] }, // integration id lookup
      { rowCount: 1, rows: [{ config: {}, encrypted_credential_ref: null, status: "pending_setup" }] }, // getIntegrationCredential — no secret
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/apollo/health-check`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    // routes/integrations.ts's generic health-check route collapses any
    // non-'connected' checkHealth status (including apolloClient.ts's own
    // honest 'not_configured') to 'error' at the HTTP-response/DB-status
    // level — same existing behavior hunterClient.ts's 'not_configured'
    // already gets. The underlying honest reason survives in `detail`.
    expect(res.body.status).toBe("error");
    expect(res.body.detail).toMatch(/no apollo api key/i);

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE integrations SET status"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1][0]).toBe("error");
  });

  it("honestly reports google as 'error' with a not-configured detail when the engine id (cx) is missing even though a key is stored", async () => {
    const { app, queryMock } = await loadApp();
    queueResponses(queryMock, [
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: "int-1" }] }, // integration id lookup
      {
        rowCount: 1,
        rows: [{ config: {}, encrypted_credential_ref: "v1.somevalue", status: "pending_setup" }],
      },
      undefined, // audit insert
    ]);
    // getIntegrationCredential will try to decrypt — encryption isn't
    // configured in this test (no INTEGRATION_CREDENTIALS_KEY), so it logs
    // a warning and returns secret: null, which is still enough to exercise
    // the "missing engine id" honest-failure path in googleClient.ts.

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/google/health-check`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(res.body.detail).toMatch(/API key/i);
  });
});
