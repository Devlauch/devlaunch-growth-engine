import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as deals.test.ts: fake the pg pool so these are
// true unit tests, no real Postgres/RLS involved.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { companiesRouter } = await import("../src/routes/companies.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/companies", companiesRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const COMPANY_1 = "66666666-6666-6666-6666-666666666666";
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

describe("POST /companies", () => {
  it("creates a company for this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: COMPANY_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            name: "Acme Corp",
            domain: "acme.com",
          },
        ],
      }, // INSERT companies
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/companies`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Acme Corp", domain: "acme.com" });

    expect(res.status).toBe(201);
    expect(res.body.company.name).toBe("Acme Corp");
  });

  it("404s when the project does not belong to this tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // project NOT found
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/companies`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Acme Corp" });

    expect(res.status).toBe(404);
  });

  it("rejects a missing name", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/companies`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /companies", () => {
  it("lists companies for this project, filterable by search", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Corp" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/companies?search=Acme`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.companies).toHaveLength(1);
    const listCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM companies"),
    );
    expect(listCall![1]).toEqual([TENANT_A, PROJECT_1, "Acme"]);
  });
});

describe("GET /companies/:id", () => {
  it("404s for an unknown company", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // company not found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/companies/${COMPANY_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /companies/:id", () => {
  it("updates provided fields only", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Corp" }] }, // loadCompanyOr404
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Corp", industry: "SaaS" }] }, // UPDATE
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/companies/${COMPANY_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ industry: "SaaS" });

    expect(res.status).toBe(200);
    expect(res.body.company.industry).toBe("SaaS");
  });

  it("rejects an empty patch body", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: COMPANY_1 }] }, // loadCompanyOr404
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/companies/${COMPANY_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("DELETE /companies/:id", () => {
  it("deletes an existing company", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: COMPANY_1 }] }, // loadCompanyOr404
      { rowCount: 1, rows: [] }, // DELETE
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/companies/${COMPANY_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(204);
  });
});
