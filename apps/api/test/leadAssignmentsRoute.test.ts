import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Route-level tests for leadAssignmentsRouter (mocked pg client, same
// convention as dealHealth.test.ts / deals.test.ts): no real Postgres
// needed, requireTenantMembership gets a fake pg client whose query() we
// control per test.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { leadAssignmentsRouter } = await import("../src/routes/leadAssignments.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/assignments",
    leadAssignmentsRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "99999999-9999-9999-9999-999999999999";
const PROJECT_1 = "22222222-2222-2222-2222-222222222222";
const LEAD_1 = "33333333-3333-3333-3333-333333333333";
const USER_1 = "44444444-4444-4444-4444-444444444444";
const USER_2 = "55555555-5555-5555-5555-555555555555";
const DEV_USER = "user-1";

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

describe("leadAssignmentsRouter — cross-tenant isolation", () => {
  it("denies access with 403 when the caller has no active membership for the requested tenant (TENANT_B trying TENANT_A's lead)", async () => {
    const app = buildApp();
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 0, rows: [] }, // membership lookup fails: not a member of TENANT_A
      undefined, // ROLLBACK
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/assignments`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({ assignedUserId: USER_1 });

    expect(res.status).toBe(403);
  });

  it("404s on GET /current when the lead does not exist in this tenant/project (e.g. it belongs to another tenant)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // lead not found scoped to this tenant/project
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/assignments/current`)
      .set("X-Dev-User-Id", DEV_USER);

    expect(res.status).toBe(404);
  });

  it("the lead-existence query scopes by tenant_id so a lead from TENANT_B is never visible under TENANT_A", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]);

    await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/assignments/current`)
      .set("X-Dev-User-Id", DEV_USER);

    const leadQueryCall = queryMock.mock.calls.find((c) => String(c[0]).includes("FROM leads"));
    expect(leadQueryCall).toBeDefined();
    expect(leadQueryCall?.[1]).toEqual([LEAD_1, TENANT_A, PROJECT_1]);
    expect(leadQueryCall?.[1]).not.toContain(TENANT_B);
  });
});

describe("POST /assignments (assign/reassign)", () => {
  it("rejects assigning to a user who is not an active member of this tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // lead exists in project
      { rowCount: 0, rows: [] }, // assertActiveTenantMember: not an active member
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/assignments`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({ assignedUserId: USER_2 });

    expect(res.status).toBe(400);
  });

  it("creates a new assignment row and an audit_events entry, returning 201", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // lead exists in project
      { rowCount: 1, rows: [{}] }, // assertActiveTenantMember passes
      {
        rowCount: 1,
        rows: [
          {
            id: "a1",
            lead_id: LEAD_1,
            assigned_user_id: USER_2,
            assigned_by: DEV_USER,
            assigned_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }, // INSERT INTO lead_assignments
      { rowCount: 1, rows: [{}] }, // INSERT INTO audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/assignments`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({ assignedUserId: USER_2 });

    expect(res.status).toBe(201);
    expect(res.body.assignment.assignedUserId).toBe(USER_2);

    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes("INSERT INTO audit_events"));
    expect(auditCall).toBeDefined();
    expect(auditCall?.[1]).toContain(TENANT_A);
  });

  it("rejects a non-UUID assignedUserId with 400", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/assignments`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({ assignedUserId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });
});

describe("GET /assignments/history", () => {
  it("returns the full reassignment history for a lead, most recent first", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // lead exists in project
      {
        rowCount: 2,
        rows: [
          { id: "a2", lead_id: LEAD_1, assigned_user_id: USER_2, assigned_by: USER_1, assigned_at: "2026-02-01T00:00:00.000Z" },
          { id: "a1", lead_id: LEAD_1, assigned_user_id: USER_1, assigned_by: null, assigned_at: "2026-01-01T00:00:00.000Z" },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/assignments/history`)
      .set("X-Dev-User-Id", DEV_USER);

    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(2);
    expect(res.body.assignments[0].id).toBe("a2");
  });
});
