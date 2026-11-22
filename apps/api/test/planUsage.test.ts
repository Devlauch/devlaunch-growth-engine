import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same pool-mocking pattern as projects.test.ts/tenantMiddleware.test.ts:
// a fake pg client whose query() is scripted per test, so these are true
// unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { planRouter } = await import("../src/routes/planUsage.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/plan", planRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const USER_OWNER = "user-owner";
const USER_MEMBER = "user-member";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

describe("GET /api/v1/tenants/:tenantId/plan", () => {
  it("returns the real plan, its limits, and real usage counts for each resource", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      // getQuotaUsage("projects"): plan lookup + COUNT
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ plan: "starter" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: 2 }] })
      // getQuotaUsage("agentRunsPerDay")
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ plan: "starter" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: 7 }] })
      // getQuotaUsage("teamMembers")
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ plan: "starter" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: 1 }] })
      // getQuotaUsage("discoverySources")
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ plan: "starter" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: 0 }] });

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/plan`)
      .set("X-Dev-User-Id", USER_OWNER);

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("starter");
    expect(res.body.limits).toEqual({
      maxProjects: 3,
      maxAgentRunsPerDay: 50,
      maxTeamMembers: 5,
      maxDiscoverySources: 3,
    });
    expect(res.body.usage).toEqual({
      projects: { current: 2, limit: 3 },
      agentRunsPerDay: { current: 7, limit: 50 },
      teamMembers: { current: 1, limit: 5 },
      discoverySources: { current: 0, limit: 3 },
    });
  });
});

describe("PATCH /api/v1/tenants/:tenantId/plan", () => {
  it("updates the tenant's plan (owner) and writes an audit event — never claims a real payment", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: TENANT_A, slug: "devlaunch", name: "DevLaunch", plan: "growth" }],
      }) // UPDATE tenants ... RETURNING
      .mockResolvedValueOnce(undefined); // INSERT audit_events

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/plan`)
      .set("X-Dev-User-Id", USER_OWNER)
      .send({ plan: "growth" });

    expect(res.status).toBe(200);
    expect(res.body.tenant.plan).toBe("growth");

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE tenants"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual([TENANT_A, "growth"]);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall).toBeDefined();
    // 'tenant.plan_changed' is a literal in the SQL text, not a bound
    // parameter — assert on the query string, not a params-array index.
    expect(auditCall![0]).toContain("tenant.plan_changed");
    expect(JSON.parse(auditCall![1][2])).toEqual({ newPlan: "growth" });
  });

  it("rejects a plan change from a non-owner member with 403 and never touches the row", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m2", role: "member", status: "active" }] }); // membership

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/plan`)
      .set("X-Dev-User-Id", USER_MEMBER)
      .send({ plan: "enterprise" });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
  });

  it("rejects an invalid plan name with a validation error", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }); // membership

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/plan`)
      .set("X-Dev-User-Id", USER_OWNER)
      .send({ plan: "platinum" });

    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
  });
});
