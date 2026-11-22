import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Route-level tests for crmTasksRouter (mocked pg client, same convention
// as dealHealth.test.ts / deals.test.ts / leadAssignmentsRoute.test.ts).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { crmTasksRouter } = await import("../src/routes/crmTasks.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/crm-tasks", crmTasksRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "99999999-9999-9999-9999-999999999999";
const PROJECT_1 = "22222222-2222-2222-2222-222222222222";
const LEAD_1 = "33333333-3333-3333-3333-333333333333";
const TASK_1 = "66666666-6666-6666-6666-666666666666";
const USER_1 = "44444444-4444-4444-4444-444444444444";
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

describe("crmTasksRouter — cross-tenant isolation", () => {
  it("denies access with 403 when the caller has no active membership for the requested tenant", async () => {
    const app = buildApp();
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 0, rows: [] }, // membership lookup fails
      undefined, // ROLLBACK
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks`)
      .set("X-Dev-User-Id", DEV_USER);

    expect(res.status).toBe(403);
  });

  it("404s on GET /:taskId when the task belongs to a different tenant/project (scoped query finds nothing)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists in tenant
      { rowCount: 0, rows: [] }, // task not found scoped to this tenant/project
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks/${TASK_1}`)
      .set("X-Dev-User-Id", DEV_USER);

    expect(res.status).toBe(404);
  });

  it("every task query scopes by tenant_id so a task from TENANT_B is never returned under TENANT_A", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }, { rowCount: 0, rows: [] }]);

    await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks/${TASK_1}`)
      .set("X-Dev-User-Id", DEV_USER);

    const taskQueryCall = queryMock.mock.calls.find((c) => String(c[0]).includes("FROM crm_tasks WHERE id"));
    expect(taskQueryCall).toBeDefined();
    expect(taskQueryCall?.[1]).toEqual([TASK_1, TENANT_A, PROJECT_1]);
    expect(taskQueryCall?.[1]).not.toContain(TENANT_B);
  });
});

describe("GET /crm-tasks", () => {
  it("lists tasks scoped to tenant/project, filterable by status", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: TASK_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: LEAD_1,
            task_type: "call",
            title: "Call lead",
            instructions: null,
            status: "open",
            due_at: null,
            assigned_user_id: USER_1,
            sequence_enrollment_id: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks?status=open`)
      .set("X-Dev-User-Id", DEV_USER);

    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].id).toBe(TASK_1);
  });

  it("rejects an invalid status filter with 400", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks?status=bogus`)
      .set("X-Dev-User-Id", DEV_USER);

    expect(res.status).toBe(400);
  });
});

describe("POST /crm-tasks", () => {
  it("creates a task and returns 201", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: TASK_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: null,
            task_type: "follow_up",
            title: "Follow up next week",
            instructions: null,
            status: "open",
            due_at: null,
            assigned_user_id: null,
            sequence_enrollment_id: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({ taskType: "follow_up", title: "Follow up next week" });

    expect(res.status).toBe(201);
    expect(res.body.task.id).toBe(TASK_1);
  });

  it("404s when leadId is given but the lead does not belong to this tenant/project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead not found scoped to this tenant/project
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({ taskType: "call", title: "Call", leadId: LEAD_1 });

    expect(res.status).toBe(404);
  });

  it("rejects an invalid taskType with 400", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({ taskType: "not-a-real-type", title: "x" });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /crm-tasks/:taskId/complete", () => {
  it("marks an open task completed", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: TASK_1, status: "open" }] }, // loadTaskOr404
      {
        rowCount: 1,
        rows: [
          {
            id: TASK_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: null,
            task_type: "call",
            title: "Call lead",
            instructions: null,
            status: "completed",
            due_at: null,
            assigned_user_id: null,
            sequence_enrollment_id: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks/${TASK_1}/complete`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe("completed");
  });

  it("409s when the task is already completed", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: TASK_1, status: "completed" }] }, // already completed
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks/${TASK_1}/complete`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({});

    expect(res.status).toBe(409);
  });

  it("404s when the task does not exist in this tenant/project (e.g. belongs to another tenant)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // not found scoped to this tenant/project
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-tasks/${TASK_1}/complete`)
      .set("X-Dev-User-Id", DEV_USER)
      .send({});

    expect(res.status).toBe(404);
  });
});
