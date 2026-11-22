import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocked-pg-client pattern as meetings.test.ts / leadActivity.test.ts:
// fake the pg pool so these are true unit tests, no real Postgres/RLS
// involved.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { meetingPrepRouter } = await import("../src/routes/meetingPrep.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/meetings/:meetingId/prep",
    meetingPrepRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const LEAD_2 = "77777777-7777-7777-7777-777777777777";
const MEETING_1 = "66666666-6666-6666-6666-666666666666";
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

function url(meetingId = MEETING_1, leadId = LEAD_1) {
  return `/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${leadId}/meetings/${meetingId}/prep`;
}

describe("GET /leads/:leadId/meetings/:meetingId/prep", () => {
  it("404s when the lead does not belong to this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead NOT found in project
    ]);

    const res = await request(app).get(url()).set("X-Dev-User-Id", USER_1);
    expect(res.status).toBe(404);
  });

  it("404s when the meeting does not exist in this tenant/project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists in project
      { rowCount: 0, rows: [] }, // meeting not found
    ]);

    const res = await request(app).get(url()).set("X-Dev-User-Id", USER_1);
    expect(res.status).toBe(404);
  });

  it("404s when the meeting exists but belongs to a different lead", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists in project
      { rowCount: 1, rows: [{ id: MEETING_1, lead_id: LEAD_2, tenant_id: TENANT_A, project_id: PROJECT_1 }] }, // meeting belongs to LEAD_2
    ]);

    const res = await request(app).get(url(MEETING_1, LEAD_1)).set("X-Dev-User-Id", USER_1);
    expect(res.status).toBe(404);
  });

  it("assembles a full brief, honestly labeling every empty section as unavailable", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists in project (route-level assertLeadInProject)
      {
        rowCount: 1,
        rows: [{ id: MEETING_1, tenant_id: TENANT_A, project_id: PROJECT_1, lead_id: LEAD_1, type: "demo", status: "scheduled" }],
      }, // meeting
      {
        rowCount: 1,
        rows: [{ id: LEAD_1, tenant_id: TENANT_A, project_id: PROJECT_1, company_id: null, name: "Test Lead", email: "a@b.com", company: "Acme" }],
      }, // lead
      // Promise.all order: contacts, icp, enrichment, deal, notes (company skipped: company_id null)
      { rowCount: 0, rows: [] }, // contacts
      { rowCount: 0, rows: [] }, // icp
      { rowCount: 0, rows: [] }, // enrichment
      { rowCount: 0, rows: [] }, // deal
      { rowCount: 0, rows: [] }, // recent notes
      // getLeadActivityTimeline's own Promise.all: assignments, deals, meetings, tasks, notes, replies
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ]);

    const res = await request(app).get(url()).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const brief = res.body.brief;
    expect(brief.meeting.id).toBe(MEETING_1);
    expect(brief.lead.id).toBe(LEAD_1);
    expect(brief.company.available).toBe(false);
    expect(brief.company.note).toMatch(/not linked/);
    expect(brief.contacts.available).toBe(false);
    expect(brief.icpMatch.available).toBe(false);
    expect(brief.companyEnrichment.available).toBe(false);
    expect(brief.deal.available).toBe(false);
    expect(brief.recentNotes.available).toBe(false);
    expect(brief.activityTimeline.available).toBe(false);
    expect(brief.activityTimeline.data).toBeNull();
  });

  it("surfaces real linked company/contact/deal data when present", async () => {
    const app = buildApp();
    const COMPANY_1 = "88888888-8888-8888-8888-888888888888";
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists in project
      {
        rowCount: 1,
        rows: [{ id: MEETING_1, tenant_id: TENANT_A, project_id: PROJECT_1, lead_id: LEAD_1, type: "call", status: "scheduled" }],
      }, // meeting
      {
        rowCount: 1,
        rows: [{ id: LEAD_1, tenant_id: TENANT_A, project_id: PROJECT_1, company_id: COMPANY_1, name: "Test Lead" }],
      }, // lead (has company_id)
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Corp", domain: "acme.com" }] }, // company
      { rowCount: 1, rows: [{ id: "contact-1", name: "Jane Buyer", email: "jane@acme.com" }] }, // contacts
      { rowCount: 1, rows: [{ id: "score-1", icp_profile_name: "Primary ICP", match_score: "75" }] }, // icp
      { rowCount: 1, rows: [{ id: "enrich-1", domain: "acme.com", source_confidence: "verified" }] }, // enrichment
      { rowCount: 1, rows: [{ id: "deal-1", stage: "proposal", value_amount: "1000.00" }] }, // deal
      { rowCount: 1, rows: [{ id: "note-1", body: "Great call", created_at: "2026-01-01T00:00:00Z" }] }, // notes
      // activity timeline's internal queries, one assignment only
      { rowCount: 1, rows: [{ id: "a1", assigned_user_id: "u1", assigned_by: null, assigned_at: "2026-01-01T00:00:00Z" }] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ]);

    const res = await request(app).get(url()).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const brief = res.body.brief;
    expect(brief.company.available).toBe(true);
    expect(brief.company.data.name).toBe("Acme Corp");
    expect(brief.contacts.available).toBe(true);
    expect(brief.contacts.data[0].name).toBe("Jane Buyer");
    expect(brief.icpMatch.available).toBe(true);
    expect(brief.companyEnrichment.available).toBe(true);
    expect(brief.deal.available).toBe(true);
    expect(brief.deal.data.stage).toBe("proposal");
    expect(brief.recentNotes.available).toBe(true);
    expect(brief.activityTimeline.available).toBe(true);
    expect(brief.activityTimeline.data).toHaveLength(1);
  });
});
