import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { reportSchedulesRouter } = await import("../src/routes/reportSchedules.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/report-schedules", reportSchedulesRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const SCHEDULE_1 = "66666666-6666-6666-6666-666666666666";
const USER_1 = "user-1";
const USER_2 = "user-2";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "owner") {
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

describe("tenant isolation on report-schedules routes", () => {
  it("denies a user with no active membership in the target tenant", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }, undefined]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_B}/projects/${PROJECT_1}/report-schedules`)
      .set("X-Dev-User-Id", USER_2);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("FROM report_schedules"), expect.anything());
  });

  it("scopes the list query to the authenticated tenant_id + project_id", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/report-schedules`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.schedules).toEqual([]);

    const listCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM report_schedules"),
    );
    expect(listCall).toBeDefined();
    expect(listCall![1]).toEqual([TENANT_A, PROJECT_1]);
  });

  it("scopes schedule updates to the authenticated tenant_id — a stolen id from another tenant 404s", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // SELECT id FROM report_schedules WHERE id=$1 AND tenant_id=$2 — not found for TENANT_A
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/report-schedules/${SCHEDULE_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ enabled: false });

    expect(res.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE report_schedules"), expect.anything());
  });
});

describe("creating and updating a schedule", () => {
  it("creates a weekly schedule, storing recipients only (never sending anything)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: SCHEDULE_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            frequency: "weekly",
            recipients: ["client@example.com"],
            enabled: true,
            last_generated_at: null,
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/report-schedules`)
      .set("X-Dev-User-Id", USER_1)
      .send({ frequency: "weekly", recipients: ["client@example.com"] });

    expect(res.status).toBe(201);
    expect(res.body.schedule.frequency).toBe("weekly");
    expect(res.body.schedule.recipients).toEqual(["client@example.com"]);

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO report_schedules"),
    );
    expect(insertCall).toBeDefined();
  });

  it("rejects an invalid frequency", async () => {
    const app = buildApp();
    queueResponses([...mockMembership()]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/report-schedules`)
      .set("X-Dev-User-Id", USER_1)
      .send({ frequency: "daily" });

    expect(res.status).toBe(400);
  });

  it("disables an existing schedule via PATCH", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: SCHEDULE_1 }] }, // existing check
      {
        rowCount: 1,
        rows: [
          {
            id: SCHEDULE_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            frequency: "weekly",
            recipients: [],
            enabled: false,
            last_generated_at: null,
          },
        ],
      },
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/report-schedules/${SCHEDULE_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.schedule.enabled).toBe(false);
  });
});
