import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as deals.test.ts / meetings.test.ts: fake the pg
// pool so these are true unit tests, no real Postgres/RLS involved.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { leadActivityRouter } = await import("../src/routes/leadActivity.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/activity", leadActivityRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
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

describe("GET /leads/:leadId/activity", () => {
  it("404s when the lead does not belong to this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead NOT found in project
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/activity`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("returns a merged, chronologically-sorted timeline across assignments, deals, meetings, tasks, notes and replies", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists in project
      // getLeadActivityTimeline's own lead row read (source/origin/custom_fields/created_at)
      {
        rowCount: 1,
        rows: [{ source: "internal", origin: null, custom_fields: {}, created_at: "2025-12-20T00:00:00Z" }],
      },
      // Promise.all order: assignments, deals, meetings, tasks, notes, replies, scores
      {
        rowCount: 1,
        rows: [
          { id: "assign-1", assigned_user_id: "user-2", assigned_by: "user-1", assigned_at: "2026-01-01T00:00:00Z" },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            id: "deal-1",
            stage: "proposal",
            value_amount: "500.00",
            stage_changed_at: "2026-01-05T00:00:00Z",
            created_at: "2025-12-22T00:00:00Z",
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            id: "meeting-1",
            type: "demo",
            status: "completed",
            scheduled_at: "2026-01-03T00:00:00Z",
            outcome_notes: "Went well",
            next_step: "Send proposal",
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            id: "task-1",
            task_type: "call",
            title: "Follow up call",
            status: "completed",
            due_at: "2026-01-04T00:00:00Z",
            updated_at: "2026-01-04T12:00:00Z",
            created_at: "2025-12-23T00:00:00Z",
          },
        ],
      },
      {
        rowCount: 1,
        rows: [{ id: "note-1", body: "Great conversation", created_at: "2026-01-06T00:00:00Z" }],
      },
      {
        rowCount: 1,
        rows: [
          {
            id: "reply-1",
            channel: "email",
            classification: "interested",
            classification_confidence: "high",
            received_at: "2026-01-02T00:00:00Z",
          },
        ],
      },
      { rowCount: 0, rows: [] }, // scores (no lead_scores row yet)
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/activity`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    // 6 original items + lead_created + deal_created + crm_task_created
    expect(res.body.activity).toHaveLength(9);
    // Sorted newest first: note (01-06) > deal stage_change (01-05) >
    // task (01-04 12:00) > meeting (01-03) > reply (01-02) > assignment (01-01)
    // > task created (12-23) > deal created (12-22) > lead created (12-20)
    expect(res.body.activity.map((item: { type: string }) => item.type)).toEqual([
      "note",
      "stage_change",
      "task",
      "meeting",
      "reply",
      "assignment",
      "crm_task_created",
      "deal_created",
      "lead_created",
    ]);
    expect(res.body.activity[0].sourceId).toBe("note-1");
    expect(res.body.activity[0].summary).toBe("Note added");
  });

  it("returns an empty timeline when nothing has happened on this lead yet (and the lead row itself is missing)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists in project
      { rowCount: 0, rows: [] }, // lead row read returns nothing (defense in depth — never throws)
      { rowCount: 0, rows: [] }, // assignments
      { rowCount: 0, rows: [] }, // deals
      { rowCount: 0, rows: [] }, // meetings
      { rowCount: 0, rows: [] }, // tasks
      { rowCount: 0, rows: [] }, // notes
      { rowCount: 0, rows: [] }, // replies
      { rowCount: 0, rows: [] }, // scores
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/activity`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.activity).toEqual([]);
  });

  it("surfaces lead_scored and discovery_sourced entries ported from Phase 2 (Agent C2), adapted to this tree's real schema", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists in project
      {
        rowCount: 1,
        rows: [
          {
            source: "discovery",
            origin: "https://example.com",
            custom_fields: { discoveredOrganizationId: "org-1" },
            created_at: "2025-12-01T00:00:00Z",
          },
        ],
      },
      { rowCount: 0, rows: [] }, // assignments
      { rowCount: 0, rows: [] }, // deals
      { rowCount: 0, rows: [] }, // meetings
      { rowCount: 0, rows: [] }, // tasks
      { rowCount: 0, rows: [] }, // notes
      { rowCount: 0, rows: [] }, // replies
      {
        rowCount: 1,
        rows: [{ id: "score-1", total_score: "72", why_summary: "Strong ICP fit", computed_at: "2025-12-10T00:00:00Z" }],
      },
      // discovery provenance query (only issued because custom_fields carried discoveredOrganizationId)
      {
        rowCount: 1,
        rows: [
          {
            id: "org-1",
            name: "Acme Co",
            source_url: "https://acme.example.com",
            discovered_at: "2025-12-01T00:00:00Z",
            discovery_source_name: "Public Directory",
            discovery_source_connector_type: "public_directory",
            campaign_name: "Q4 outbound",
          },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/activity`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    // lead_created and discovery_sourced share the same timestamp here
    // (2025-12-01T00:00:00Z, the lead's creation == the org's discovered_at
    // in this fixture) — only lead_scored's distinct, later computed_at
    // (2025-12-10) is asserted to sort first; the relative order of the two
    // same-timestamp items is not a behavior this test pins down.
    expect(res.body.activity[0].type).toBe("lead_scored");
    expect(res.body.activity.map((item: { type: string }) => item.type)).toEqual(
      expect.arrayContaining(["lead_scored", "discovery_sourced", "lead_created"]),
    );
    expect(res.body.activity[0].summary).toBe("Lead scored 72/100");
    const discoveryItem = res.body.activity.find((item: { type: string }) => item.type === "discovery_sourced");
    expect(discoveryItem.summary).toBe("Discovered via Public Directory");
    expect(discoveryItem.detail).toBe("Campaign: Q4 outbound | Org: Acme Co");
  });
});
