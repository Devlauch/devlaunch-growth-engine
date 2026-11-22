import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Integration-level check (route + middleware + quota lib together) that
// POST /projects really enforces the plan's maxProjects quota, on top of
// quota.test.ts's unit coverage of enforceQuota itself. Same pool-mocking
// pattern as projects.test.ts.
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
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

describe("POST /api/v1/tenants/:tenantId/projects (quota enforcement)", () => {
  it("blocks creation with 402 when the tenant is already at its free-plan project limit", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      // enforceQuota("projects"): plan lookup + real COUNT(*)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ plan: "free" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: 1 }] }); // already at the free plan's limit of 1

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "One Too Many", slug: "one-too-many" });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("plan_limit_exceeded");
    expect(res.body.error.message).toContain("free");
    // Must never reach the slug-uniqueness check or the INSERT.
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO projects"), expect.anything());
  });

  it("allows creation when the tenant is under its plan's project limit", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      // enforceQuota("projects"): plan lookup + real COUNT(*), under the limit
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ plan: "starter" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: 1 }] }) // starter allows 3
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // slug-uniqueness check: none
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "new-project-id",
            tenant_id: TENANT_A,
            name: "Room To Grow",
            slug: "room-to-grow",
            description: null,
            status: "active",
            public_api_key: "pk_abc123",
            allowed_origins: [],
            public_widget_enabled: false,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }) // INSERT INTO projects ... RETURNING
      .mockResolvedValueOnce(undefined); // INSERT audit_events

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Room To Grow", slug: "room-to-grow" });

    expect(res.status).toBe(201);
    expect(res.body.project.slug).toBe("room-to-grow");
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO projects"), expect.anything());
  });
});
