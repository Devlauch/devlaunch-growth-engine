import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { meetingsRouter } = await import("../src/routes/meetings.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/meetings", meetingsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const MEETING_1 = "66666666-6666-6666-6666-666666666666";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  delete process.env.CALENDLY_API_KEY;
});

afterEach(() => {
  delete process.env.CALENDLY_API_KEY;
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

describe("POST /meetings (manual entry)", () => {
  it("records a manually-entered meeting for a real lead", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists
      {
        rowCount: 1,
        rows: [
          {
            id: MEETING_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: LEAD_1,
            type: "demo",
            status: "scheduled",
            booking_provider: "manual",
          },
        ],
      }, // INSERT meetings
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/meetings`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1, type: "demo", scheduledAt: "2026-12-01T10:00:00.000Z" });

    expect(res.status).toBe(201);
    expect(res.body.meeting.booking_provider).toBe("manual");
    expect(res.body.meeting.status).toBe("scheduled");
  });

  it("rejects bookingProvider 'calendly' with an honest not_configured error, never fabricating a booking", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/meetings`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1, type: "call", scheduledAt: "2026-12-01T10:00:00.000Z", bookingProvider: "calendly" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("not_configured");
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO meetings")),
    ).toBe(false);
  });
});

describe("GET /meetings/booking-provider-status", () => {
  it("reports not_configured when no CALENDLY_API_KEY is set", async () => {
    const app = buildApp();
    queueResponses([...mockMembership()]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/meetings/booking-provider-status`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.provider).toEqual(
      expect.objectContaining({ provider: "calendly", configured: false, status: "not_configured" }),
    );
  });
});

describe("PATCH /meetings/:id/outcome", () => {
  it("records a 'no_show' outcome and auto-creates exactly one follow-up task", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: MEETING_1, tenant_id: TENANT_A, project_id: PROJECT_1, lead_id: LEAD_1 }] }, // loadMeetingOr404
      {
        rowCount: 1,
        rows: [
          {
            id: MEETING_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: LEAD_1,
            deal_id: null,
            status: "no_show",
            next_step: null,
          },
        ],
      }, // UPDATE meetings
      { rowCount: 1, rows: [] }, // audit_events
      { rowCount: 0, rows: [] }, // existing follow_up_tasks check for this meeting: none
      { rowCount: 1, rows: [{ id: "crm-task-1" }] }, // INSERT crm_tasks
      { rowCount: 1, rows: [{ id: "follow-up-1" }] }, // INSERT follow_up_tasks
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/meetings/${MEETING_1}/outcome`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "no_show" });

    expect(res.status).toBe(200);
    expect(res.body.meeting.status).toBe("no_show");
    expect(res.body.followUpCreated).toEqual({
      dealId: "",
      leadId: LEAD_1,
      crmTaskId: "crm-task-1",
      followUpTaskId: "follow-up-1",
    });
  });

  it("does not create a follow-up for a 'completed' outcome with no next_step recorded", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: MEETING_1, tenant_id: TENANT_A, project_id: PROJECT_1, lead_id: LEAD_1 }] }, // loadMeetingOr404
      {
        rowCount: 1,
        rows: [
          {
            id: MEETING_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: LEAD_1,
            deal_id: null,
            status: "completed",
            next_step: null,
          },
        ],
      }, // UPDATE meetings
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/meetings/${MEETING_1}/outcome`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "completed" });

    expect(res.status).toBe(200);
    expect(res.body.followUpCreated).toBeNull();
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO crm_tasks")),
    ).toBe(false);
  });
});
