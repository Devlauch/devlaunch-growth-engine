import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// Must be set BEFORE the dynamic import below: config/env.ts reads
// process.env once at module-evaluation time (same convention as
// credentialEncryption.test.ts), and this is the first time this test
// file's module registry loads that chain.
process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString("base64");

const { listmonkIntegrationRouter } = await import("../src/routes/listmonkIntegration.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { encryptCredential } = await import("../src/lib/credentialEncryption.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations/listmonk", listmonkIntegrationRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const CAMPAIGN_1 = "22222222-2222-2222-2222-222222222222";
const USER_1 = "user-1";
const BASE = `/api/v1/tenants/${TENANT_1}/projects/${PROJECT_1}/integrations/listmonk`;

function mockMembership(role = "owner") {
  return [undefined, undefined, { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

function mockProjectInTenant() {
  return { rowCount: 1, rows: [{ "?column?": 1 }] };
}

/** getListmonkClient's first query: SELECT id FROM integrations ... */
function connectedIntegrationId() {
  return { rowCount: 1, rows: [{ id: "int-1" }] };
}

/** getIntegrationCredential's own query: SELECT config, encrypted_credential_ref, status ... */
function connectedCredentialRow(secret = "listmonk-api-key") {
  return {
    rowCount: 1,
    rows: [{ config: { baseUrl: "http://listmonk.local", apiUser: "u" }, encrypted_credential_ref: encryptCredential(secret), status: "connected" }],
  };
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /", () => {
  it("returns a real status overview with no fabricated data when nothing is connected", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 0, rows: [] }, // integration row: none
      { rowCount: 0, rows: [] }, // listmonk_lists
      { rowCount: 0, rows: [] }, // subscriberCounts
      { rowCount: 0, rows: [] }, // campaigns
    ]);

    const app = buildApp();
    const res = await request(app).get(BASE).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.integration).toBeNull();
    expect(res.body.subscriberCounts).toEqual({});
    expect(res.body.campaigns).toEqual([]);
  });
});

describe("POST /sync-subscribers", () => {
  it("refuses with 400 when there is no listmonk integration row at all", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 0, rows: [] }, // getListmonkClient: no integration row
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/sync-subscribers`).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(400);
  });
});

describe("POST /campaigns/:campaignId/send", () => {
  it("refuses to send (403) when the campaign has not been approved", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      connectedIntegrationId(), // getListmonkClient: SELECT id
      connectedCredentialRow(), // getIntegrationCredential
      { rowCount: 1, rows: [{ status: "pending_approval" }] }, // triggerCampaignSend: campaigns lookup — not approved
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/campaigns/${CAMPAIGN_1}/send`).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });

  it("refuses with 400 when there is no usable listmonk credential", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 0, rows: [] }, // getListmonkClient: no integration row
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/campaigns/${CAMPAIGN_1}/send`).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(400);
  });
});
