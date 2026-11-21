import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the DB pool so this is a true unit test: no real Postgres needed.
// requireTenantMembership and the route handlers both get a fake pg
// client whose query() we control per test (same pattern as
// tenantMiddleware.test.ts and publicLeads.test.ts).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { projectsRouter } = await import("../src/routes/projects.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects", projectsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const USER_1 = "user-1";
const USER_2 = "user-2";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

describe("PATCH /api/v1/tenants/:tenantId/projects/:projectId (widget settings)", () => {
  it("toggling publicWidgetEnabled and allowedOrigins persists and is readable back via GET", async () => {
    const app = buildApp();
    const allowedOrigins = ["https://customer-site.example", "https://www.customer-site.example"];

    // --- PATCH request ---
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: PROJECT_1,
            tenant_id: TENANT_A,
            name: "Acme Launch",
            slug: "acme-launch",
            description: null,
            status: "active",
            public_api_key: "pk_abc123",
            allowed_origins: allowedOrigins,
            public_widget_enabled: true,
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }) // UPDATE ... RETURNING
      .mockResolvedValueOnce(undefined); // INSERT audit_events (COMMIT fires on res "finish")

    const patchRes = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ publicWidgetEnabled: true, allowedOrigins });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.project.public_widget_enabled).toBe(true);
    expect(patchRes.body.project.allowed_origins).toEqual(allowedOrigins);
    expect(patchRes.body.project.public_api_key).toBe("pk_abc123");

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE projects"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual([PROJECT_1, TENANT_A, null, null, null, true, allowedOrigins]);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1][2]).toBe("project.widget_settings_updated");

    // --- GET request: reads the same values back ---
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: PROJECT_1,
            tenant_id: TENANT_A,
            name: "Acme Launch",
            slug: "acme-launch",
            description: null,
            status: "active",
            public_api_key: "pk_abc123",
            allowed_origins: allowedOrigins,
            public_widget_enabled: true,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }); // SELECT project

    const getRes = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(getRes.status).toBe(200);
    expect(getRes.body.project.public_widget_enabled).toBe(true);
    expect(getRes.body.project.allowed_origins).toEqual(allowedOrigins);
  });

  it("rejects malformed origins (not an absolute scheme://host origin) with a validation error", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }); // membership

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ allowedOrigins: ["not-a-valid-origin"] });

    expect(res.status).toBe(400);
    // Must never reach the UPDATE with invalid data.
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE projects"), expect.anything());
  });

  it("denies a cross-tenant user from modifying another tenant's project widget settings", async () => {
    const app = buildApp();

    // USER_2 has no active membership row for TENANT_B -> requireTenantMembership
    // rejects with 403 before the route handler (and its UPDATE query) ever runs.
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // membership lookup: none
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_B}/projects/${PROJECT_1}`)
      .set("X-Dev-User-Id", USER_2)
      .send({ publicWidgetEnabled: true, allowedOrigins: ["https://evil-site.example"] });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE projects"), expect.anything());
    expect(releaseMock).toHaveBeenCalled();
  });
});
