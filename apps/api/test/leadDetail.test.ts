import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as leadActivity.test.ts / deals.test.ts: fake the pg
// pool so these are true unit tests, no real Postgres/RLS involved.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { leadsRouter } = await import("../src/routes/leads.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/leads", leadsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "sales") {
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

describe("GET /leads/:id", () => {
  it("404s when the project does not exist in this tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // project NOT found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("404s when the lead does not belong to this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead NOT found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("returns the real lead row when it exists in this project", async () => {
    const app = buildApp();
    const leadRow = {
      id: LEAD_1,
      name: "Jane Prospect",
      email: "jane@example.com",
      company: "Acme Co",
      message: "Interested in your product",
      source: "public_widget",
      status: "qualified",
      created_at: "2026-01-01T00:00:00Z",
    };
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [leadRow] }, // lead found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.lead).toEqual(leadRow);
  });
});
