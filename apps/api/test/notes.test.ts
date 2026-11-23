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

const { notesRouter } = await import("../src/routes/notes.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/notes", notesRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const DEAL_1 = "66666666-6666-6666-6666-666666666666";
const NOTE_1 = "77777777-7777-7777-7777-777777777777";
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

describe("POST /notes", () => {
  it("creates a note attached to a lead", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists in project
      {
        rowCount: 1,
        rows: [
          {
            id: NOTE_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: LEAD_1,
            deal_id: null,
            company_id: null,
            contact_id: null,
            body: "Spoke with the champion, looks promising.",
          },
        ],
      }, // INSERT notes
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/notes`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1, body: "Spoke with the champion, looks promising." });

    expect(res.status).toBe(201);
    expect(res.body.note.lead_id).toBe(LEAD_1);
    expect(res.body.note.body).toContain("champion");
  });

  it("creates a note attached to a deal", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // deal exists in project
      {
        rowCount: 1,
        rows: [{ id: NOTE_1, tenant_id: TENANT_A, project_id: PROJECT_1, lead_id: null, deal_id: DEAL_1, body: "Pricing discussed." }],
      }, // INSERT notes
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/notes`)
      .set("X-Dev-User-Id", USER_1)
      .send({ dealId: DEAL_1, body: "Pricing discussed." });

    expect(res.status).toBe(201);
    expect(res.body.note.deal_id).toBe(DEAL_1);
  });

  it("rejects a note with no lead/deal/company/contact target", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/notes`)
      .set("X-Dev-User-Id", USER_1)
      .send({ body: "Floating note with nothing to attach to." });

    expect(res.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO notes"))).toBe(
      false,
    );
  });

  it("404s when the lead does not belong to this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead NOT found in project
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/notes`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1, body: "Note body" });

    expect(res.status).toBe(404);
  });
});

describe("GET /notes", () => {
  it("lists notes filtered by leadId", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: NOTE_1, lead_id: LEAD_1, body: "Note body" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/notes?leadId=${LEAD_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
  });
});

describe("PATCH /notes/:id", () => {
  it("updates the note body", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: NOTE_1, tenant_id: TENANT_A, project_id: PROJECT_1 }] }, // loadNoteOr404
      { rowCount: 1, rows: [{ id: NOTE_1, body: "Updated body" }] }, // UPDATE notes
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/notes/${NOTE_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ body: "Updated body" });

    expect(res.status).toBe(200);
    expect(res.body.note.body).toBe("Updated body");
  });

  it("404s for a note that doesn't exist in this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // loadNoteOr404: not found
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/notes/${NOTE_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ body: "Updated body" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /notes/:id", () => {
  it("deletes a note", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: NOTE_1, tenant_id: TENANT_A, project_id: PROJECT_1 }] }, // loadNoteOr404
      { rowCount: 1, rows: [] }, // DELETE
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/notes/${NOTE_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(204);
  });
});
