import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the DB pool so this is a true unit test: no real Postgres needed.
// requireTenantMembership and the route handlers both get a fake pg
// client whose query() we control per test (same pattern as
// tenantMiddleware.test.ts and projects.test.ts).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
  // tenantsRouter's POST / and GET / handlers use withTransaction/
  // withUserContext directly (they run before any tenantId is known), but
  // this file only exercises the PATCH /:tenantId branding route and the
  // onboarding-completeness route, both of which only go through
  // requireTenantMembership's pool.connect() usage above.
  withTransaction: vi.fn(),
  withUserContext: vi.fn(),
}));

const { tenantsRouter } = await import("../src/routes/tenants.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants", tenantsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const USER_1 = "user-1";
const USER_2 = "user-2";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

describe("PATCH /api/v1/tenants/:tenantId (branding & onboarding fields)", () => {
  it("updates industry/goals/logoUrl/primaryColor/subdomain and is audited as tenant.branding_updated", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: TENANT_A,
            slug: "acme",
            name: "Acme Inc",
            industry: "SaaS",
            goals: "Grow qualified pipeline",
            logo_url: "https://cdn.example.com/acme-logo.png",
            primary_color: "#6d5cf0",
            subdomain: "acme",
            status: "active",
            settings: {},
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }) // UPDATE ... RETURNING
      .mockResolvedValueOnce(undefined); // INSERT audit_events

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}`)
      .set("X-Dev-User-Id", USER_1)
      .send({
        industry: "SaaS",
        goals: "Grow qualified pipeline",
        logoUrl: "https://cdn.example.com/acme-logo.png",
        primaryColor: "#6d5cf0",
        subdomain: "acme",
      });

    expect(res.status).toBe(200);
    expect(res.body.tenant.primary_color).toBe("#6d5cf0");
    expect(res.body.tenant.subdomain).toBe("acme");

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE tenants"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual([
      TENANT_A,
      true,
      "SaaS",
      true,
      "Grow qualified pipeline",
      true,
      "https://cdn.example.com/acme-logo.png",
      true,
      "#6d5cf0",
      true,
      "acme",
    ]);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1][0]).toBe(TENANT_A);
    expect(auditCall![1][1]).toBe(USER_1);
    expect(auditCall![1][2]).toBe("tenant.branding_updated");
    expect(JSON.parse(auditCall![1][3])).toEqual({
      industry: "SaaS",
      goals: "Grow qualified pipeline",
      logoUrl: "https://cdn.example.com/acme-logo.png",
      primaryColor: "#6d5cf0",
      subdomain: "acme",
    });
  });

  it("rejects a non-hex primaryColor with a validation error and never reaches the UPDATE", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }); // membership

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ primaryColor: "not-a-color" });

    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
  });

  it("rejects a primaryColor missing the # or with the wrong length", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }); // membership

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ primaryColor: "6d5cf0" }); // missing leading '#'

    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
  });

  it("denies a cross-tenant user from updating another tenant's branding (tenant isolation)", async () => {
    const app = buildApp();

    // USER_2 has no active membership row for TENANT_B -> requireTenantMembership
    // rejects with 403 before the route handler (and its UPDATE query) ever runs.
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // membership lookup: none
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_B}`)
      .set("X-Dev-User-Id", USER_2)
      .send({ primaryColor: "#000000" });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
    expect(releaseMock).toHaveBeenCalled();
  });

  it("denies a member (non owner/admin) from updating branding", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "member", status: "active" }] }) // membership
      .mockResolvedValueOnce(undefined); // ROLLBACK (403 >= 400)

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ primaryColor: "#000000" });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
  });
});

describe("GET /api/v1/tenants/:tenantId/onboarding-completeness", () => {
  it("computes the checklist from real row existence, with no project yet", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ industry: null, goals: null, logo_url: null, primary_color: null }],
      }) // tenant branding fields
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ project_count: 0, widget_enabled_count: 0 }] }); // project stats

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/onboarding-completeness`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(4);
    expect(res.body.completedCount).toBe(1); // only orgCreated
    const byKey = Object.fromEntries(
      (res.body.checklist as { key: string; done: boolean }[]).map((c) => [c.key, c.done]),
    );
    expect(byKey.orgCreated).toBe(true);
    expect(byKey.brandingSet).toBe(false);
    expect(byKey.firstProjectCreated).toBe(false);
    expect(byKey.widgetEnabled).toBe(false);
  });

  it("marks brandingSet/firstProjectCreated/widgetEnabled true once real rows exist", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ industry: "SaaS", goals: null, logo_url: null, primary_color: "#6d5cf0" }],
      }) // tenant branding fields
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ project_count: 2, widget_enabled_count: 1 }] }); // project stats

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/onboarding-completeness`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.completedCount).toBe(4);
    const byKey = Object.fromEntries(
      (res.body.checklist as { key: string; done: boolean }[]).map((c) => [c.key, c.done]),
    );
    expect(byKey.brandingSet).toBe(true);
    expect(byKey.firstProjectCreated).toBe(true);
    expect(byKey.widgetEnabled).toBe(true);
  });
});
