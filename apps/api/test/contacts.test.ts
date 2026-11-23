import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as deals.test.ts / companies.test.ts: fake the pg
// pool so these are true unit tests, no real Postgres/RLS involved.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { contactsRouter } = await import("../src/routes/contacts.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/contacts", contactsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const COMPANY_1 = "44444444-4444-4444-4444-444444444444";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const CONTACT_1 = "66666666-6666-6666-6666-666666666666";
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

describe("POST /contacts", () => {
  it("creates a contact linked to a company and a lead", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // company exists in project
      { rowCount: 1, rows: [{}] }, // lead exists in project
      {
        rowCount: 1,
        rows: [
          {
            id: CONTACT_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            company_id: COMPANY_1,
            lead_id: LEAD_1,
            name: "Jane Doe",
          },
        ],
      }, // INSERT contacts
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/contacts`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Jane Doe", companyId: COMPANY_1, leadId: LEAD_1 });

    expect(res.status).toBe(201);
    expect(res.body.contact.name).toBe("Jane Doe");
    expect(res.body.contact.company_id).toBe(COMPANY_1);
  });

  it("404s when companyId does not belong to this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // company NOT found
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/contacts`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Jane Doe", companyId: COMPANY_1 });

    expect(res.status).toBe(404);
  });

  it("rejects a missing name", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/contacts`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /contacts", () => {
  it("filters by companyId when provided", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CONTACT_1, company_id: COMPANY_1 }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/contacts?companyId=${COMPANY_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(1);
    const listCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM contacts"),
    );
    expect(listCall![1]).toEqual([TENANT_A, PROJECT_1, COMPANY_1]);
  });
});

describe("GET /contacts/:id", () => {
  it("404s for an unknown contact", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // contact not found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/contacts/${CONTACT_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /contacts/:id", () => {
  it("updates provided fields only", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CONTACT_1, name: "Jane Doe" }] }, // loadContactOr404
      { rowCount: 1, rows: [{ id: CONTACT_1, name: "Jane Doe", title: "VP Sales" }] }, // UPDATE
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/contacts/${CONTACT_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ title: "VP Sales" });

    expect(res.status).toBe(200);
    expect(res.body.contact.title).toBe("VP Sales");
  });

  it("rejects an empty patch body", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CONTACT_1 }] }, // loadContactOr404
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/contacts/${CONTACT_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("DELETE /contacts/:id", () => {
  it("deletes an existing contact", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CONTACT_1 }] }, // loadContactOr404
      { rowCount: 1, rows: [] }, // DELETE
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/contacts/${CONTACT_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(204);
  });
});
