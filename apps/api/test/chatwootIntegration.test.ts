import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocked-pg-pool pattern as notes.test.ts / integrations.test.ts —
// requireAuth (X-Dev-User-Id dev fallback) + requireTenantMembership run
// for real against this mocked pool, exercising real tenant-isolation
// behavior without a live Postgres/RLS.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// GET /conversations delegates to getChatwootClientForTenant — mocked here
// so this route's own logic (not_configured handling, response mapping,
// upstream-failure -> 502) is tested in isolation from chatwootClient.ts's
// own already-covered HTTP behavior (chatwootClient.test.ts).
const getChatwootClientForTenantMock = vi.fn();
vi.mock("../src/lib/chatwootClient.js", () => ({
  getChatwootClientForTenant: getChatwootClientForTenantMock,
}));

// GET /identity-hash delegates to getIntegrationCredential — mocked here so
// this route's own logic (not-connected / not-opted-in / real-hash-returned
// handling) is tested in isolation from integrationCredentials.ts's own
// already-covered decrypt behavior.
const getIntegrationCredentialMock = vi.fn();
vi.mock("../src/lib/integrationCredentials.js", () => ({
  getIntegrationCredential: getIntegrationCredentialMock,
}));

const { chatwootIntegrationRouter } = await import("../src/routes/chatwootIntegration.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations/chatwoot", chatwootIntegrationRouter);
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
  getChatwootClientForTenantMock.mockReset();
  getIntegrationCredentialMock.mockReset();
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

describe("GET /integrations/chatwoot/conversations", () => {
  it("denies a user with no active membership", async () => {
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }, undefined]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/conversations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
    expect(getChatwootClientForTenantMock).not.toHaveBeenCalled();
  });

  it("reports not_configured (200, not an error) when chatwoot isn't connected for this project", async () => {
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]); // project exists
    getChatwootClientForTenantMock.mockResolvedValueOnce({ status: "not_configured", detail: "no credential" });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/conversations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "not_configured", detail: "no credential", conversations: [] });
  });

  it("returns a real conversation list from the resolved client", async () => {
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);
    const listConversations = vi.fn().mockResolvedValueOnce([{ id: 1, inboxId: 3, status: "open" }]);
    getChatwootClientForTenantMock.mockResolvedValueOnce({ listConversations });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/conversations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", conversations: [{ id: 1, inboxId: 3, status: "open" }] });
  });

  it("maps a real Chatwoot API failure to 502, never swallowing it", async () => {
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);
    const listConversations = vi.fn().mockRejectedValueOnce(new Error("HTTP 401: invalid api_access_token"));
    getChatwootClientForTenantMock.mockResolvedValueOnce({ listConversations });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/conversations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(502);
  });
});

describe("GET /integrations/chatwoot/embed-snippet", () => {
  it("404s when no baseUrl/websiteToken is configured yet", async () => {
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ config: {} }] }, // integrations row with no config
    ]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/embed-snippet`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("builds a real snippet from the stored config, never including the api access token", async () => {
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ config: { baseUrl: "https://chat.example.com", accountId: "1", websiteToken: "tok_abc" } }] },
    ]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/embed-snippet`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.baseUrl).toBe("https://chat.example.com");
    expect(res.body.websiteToken).toBe("tok_abc");
    expect(res.body.snippet).toContain('BASE_URL + "/packs/js/sdk.js"');
    expect(res.body.snippet).toContain('"https://chat.example.com"');
    expect(res.body.snippet).toContain("tok_abc");
    expect(res.body.snippet).not.toContain("api_access_token");
  });
});

describe("GET /integrations/chatwoot/identity-hash — Milestone 3 identity verification", () => {
  it("denies a user with no active membership", async () => {
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }, undefined]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/identity-hash`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
    expect(getIntegrationCredentialMock).not.toHaveBeenCalled();
  });

  it("404s when no chatwoot integration is connected for this project yet", async () => {
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);
    getIntegrationCredentialMock.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/identity-hash`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
    expect(res.body.status).toBe("not_connected");
  });

  it("501s honestly (never fabricating a hash) when connected with a bare apiAccessToken and no widgetHmacToken — every pre-existing tenant", async () => {
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);
    getIntegrationCredentialMock.mockResolvedValueOnce({
      config: { baseUrl: "https://chat.example.com", accountId: "1" },
      secret: "plain-bare-api-access-token", // the shape every tenant had before this feature
      status: "connected",
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/identity-hash`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(501);
    expect(res.body.status).toBe("chatwoot_identity_not_configured");
  });

  it("returns a real identifier + identifier_hash that independently verifies against Chatwoot's own HMAC-SHA256 scheme, when opted in", async () => {
    const widgetHmacToken = "real-inbox-hmac-token";
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);
    getIntegrationCredentialMock.mockResolvedValueOnce({
      config: { baseUrl: "https://chat.example.com", accountId: "1", websiteToken: "tok_abc" },
      secret: JSON.stringify({ apiAccessToken: "real-api-token", widgetHmacToken }),
      status: "connected",
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/identity-hash`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.baseUrl).toBe("https://chat.example.com");
    expect(res.body.websiteToken).toBe("tok_abc");
    expect(typeof res.body.identifier).toBe("string");
    expect(res.body.identifier).toContain(TENANT_A);
    expect(res.body.identifier).toContain(PROJECT_1);
    expect(res.body.identifier).toContain(USER_1);

    // Independently recompute the hash exactly as Chatwoot's own
    // hmac_concern.rb would (HMAC-SHA256(widgetHmacToken, identifier),
    // hex) — proves the server's output is a CORRECTLY-signed hash
    // Chatwoot's own verification would accept, not just "some string".
    const expectedHash = createHmac("sha256", widgetHmacToken).update(res.body.identifier).digest("hex");
    expect(res.body.identifierHash).toBe(expectedHash);
  });

  it("never returns the same identifier/hash for two different authenticated users (no identity confusion)", async () => {
    const widgetHmacToken = "real-inbox-hmac-token";
    const credential = {
      config: { baseUrl: "https://chat.example.com", accountId: "1" },
      secret: JSON.stringify({ apiAccessToken: "real-api-token", widgetHmacToken }),
      status: "connected",
    };

    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);
    getIntegrationCredentialMock.mockResolvedValueOnce(credential);
    const app = buildApp();
    const resUser1 = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/identity-hash`)
      .set("X-Dev-User-Id", USER_1);

    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);
    getIntegrationCredentialMock.mockResolvedValueOnce(credential);
    const resUser2 = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/chatwoot/identity-hash`)
      .set("X-Dev-User-Id", "user-2");

    expect(resUser1.body.identifier).not.toBe(resUser2.body.identifier);
    expect(resUser1.body.identifierHash).not.toBe(resUser2.body.identifierHash);
  });
});
