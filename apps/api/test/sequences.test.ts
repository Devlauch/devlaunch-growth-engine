import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the DB pool so route tests are true unit tests: no real Postgres
// needed (same pattern as campaigns.test.ts / priorityQueue.test.ts).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// Mock suppression.ts's checkSendEligibility (roadmap item 18, owned by a
// parallel effort) so advanceDueEnrollments tests can control eligibility
// per-case without a real suppression_list/consent_records table.
const checkSendEligibilityMock = vi.fn();
vi.mock("../src/lib/suppression.js", () => ({
  checkSendEligibility: (...args: unknown[]) => checkSendEligibilityMock(...args),
}));

const { sequencesRouter } = await import("../src/routes/sequences.js");
const { advanceDueEnrollments } = await import("../src/lib/advanceSequences.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

// sequenceEnrollmentsRouter is nested inside sequencesRouter (see
// routes/sequences.ts's header comment on why: mounting it as a sibling at
// an overlapping prefix would run the auth/tenant middleware twice per
// request), so only sequencesRouter needs mounting here.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/sequences", sequencesRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const SEQUENCE_1 = "44444444-4444-4444-4444-444444444444";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const ENROLLMENT_1 = "66666666-6666-6666-6666-666666666666";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  checkSendEligibilityMock.mockReset();
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

describe("sequence + steps creation", () => {
  it("creates a sequence and inserts its steps transactionally", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: SEQUENCE_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Outbound v1", is_active: true }],
      }, // INSERT sequences
      { rowCount: 1, rows: [] }, // DELETE sequence_steps (no-op on create, still issued)
      { rowCount: 1, rows: [{ id: "s0", step_order: 0, day_offset: 0, step_type: "email" }] }, // INSERT step 0
      { rowCount: 1, rows: [{ id: "s1", step_order: 1, day_offset: 3, step_type: "call_task" }] }, // INSERT step 1
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sequences`)
      .set("X-Dev-User-Id", USER_1)
      .send({
        name: "Outbound v1",
        steps: [
          { stepOrder: 0, dayOffset: 0, stepType: "email", messageDraftVariantChannel: "email" },
          { stepOrder: 1, dayOffset: 3, stepType: "call_task", taskInstructions: "Call and ask about budget" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.sequence.name).toBe("Outbound v1");
    expect(res.body.steps).toHaveLength(2);

    const insertStepCalls = queryMock.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO sequence_steps"),
    );
    expect(insertStepCalls).toHaveLength(2);
  });
});

describe("sequence enrollment", () => {
  it("enrolls a lead as 'active' at current_step_order 0", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: SEQUENCE_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Outbound v1" }] }, // loadSequenceOr404
      { rowCount: 1, rows: [{}] }, // lead exists
      { rowCount: 0, rows: [] }, // existing enrollment check: none
      {
        rowCount: 1,
        rows: [
          {
            id: ENROLLMENT_1,
            tenant_id: TENANT_A,
            sequence_id: SEQUENCE_1,
            lead_id: LEAD_1,
            status: "active",
            current_step_order: 0,
          },
        ],
      }, // INSERT enrollment
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sequences/${SEQUENCE_1}/enrollments`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1 });

    expect(res.status).toBe(201);
    expect(res.body.enrollment.status).toBe("active");
    expect(res.body.enrollment.current_step_order).toBe(0);
  });

  it("rejects (409) re-enrolling a lead already enrolled in the same sequence, respecting the unique constraint, without issuing the INSERT", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: SEQUENCE_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Outbound v1" }] }, // loadSequenceOr404
      { rowCount: 1, rows: [{}] }, // lead exists
      { rowCount: 1, rows: [{}] }, // existing enrollment check: found
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sequences/${SEQUENCE_1}/enrollments`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1 });

    expect(res.status).toBe(409);
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO sequence_enrollments"),
      expect.anything(),
    );
  });
});

describe("manual stop transitions", () => {
  it("stops an active enrollment with the reason-matched status and sets stopped_at", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: SEQUENCE_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Outbound v1" }] }, // loadSequenceOr404
      { rowCount: 1, rows: [{ id: ENROLLMENT_1, status: "active" }] }, // existing enrollment lookup
      { rowCount: 1, rows: [{ id: ENROLLMENT_1, status: "stopped_replied", stopped_at: "2026-01-01T00:00:00Z" }] }, // UPDATE
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sequences/${SEQUENCE_1}/enrollments/${ENROLLMENT_1}/stop`)
      .set("X-Dev-User-Id", USER_1)
      .send({ reason: "replied" });

    expect(res.status).toBe(200);
    expect(res.body.enrollment.status).toBe("stopped_replied");

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE sequence_enrollments") && sql.includes("SET status"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual([ENROLLMENT_1, TENANT_A, SEQUENCE_1, "stopped_replied"]);
  });

  it("rejects stopping an enrollment that is not currently active", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: SEQUENCE_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Outbound v1" }] }, // loadSequenceOr404
      { rowCount: 1, rows: [{ id: ENROLLMENT_1, status: "completed" }] }, // existing enrollment lookup
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sequences/${SEQUENCE_1}/enrollments/${ENROLLMENT_1}/stop`)
      .set("X-Dev-User-Id", USER_1)
      .send({ reason: "manual" });

    expect(res.status).toBe(409);
  });
});

describe("advanceDueEnrollments", () => {
  function fakeTenantDb() {
    return { query: queryMock };
  }

  it("queries due enrollments by enrolled_at + day_offset, and no-ops when nothing is due", async () => {
    queueResponses([
      { rowCount: 0, rows: [] }, // UPDATE ... completed
      { rowCount: 0, rows: [] }, // SELECT due enrollments: none due
    ]);

    const result = await advanceDueEnrollments(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(result).toEqual({ advanced: 0, tasksCreated: 0, skipped: [] });
    const dueCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("now() >= se.enrolled_at + (ss.day_offset"),
    );
    expect(dueCall).toBeDefined();
    expect(dueCall![1]).toEqual([TENANT_A, PROJECT_1]);
  });

  it("creates a crm_tasks row for a due call_task step (when eligible) and advances the enrollment", async () => {
    checkSendEligibilityMock.mockResolvedValueOnce({ eligible: true, blockReasons: [] });
    queueResponses([
      { rowCount: 0, rows: [] }, // UPDATE ... completed
      {
        rowCount: 1,
        rows: [
          {
            enrollment_id: ENROLLMENT_1,
            sequence_id: SEQUENCE_1,
            lead_id: LEAD_1,
            current_step_order: 1,
            step_order: 1,
            step_type: "call_task",
            message_draft_variant_channel: null,
            task_instructions: "Call and ask about budget",
            lead_email: "lead@example.com",
          },
        ],
      }, // SELECT due
      { rowCount: 1, rows: [] }, // INSERT crm_tasks
      { rowCount: 1, rows: [] }, // UPDATE current_step_order
    ]);

    const result = await advanceDueEnrollments(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(result.tasksCreated).toBe(1);
    expect(result.advanced).toBe(1);
    expect(result.skipped).toEqual([]);

    expect(checkSendEligibilityMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_A,
      expect.objectContaining({ leadId: LEAD_1, email: "lead@example.com", channel: "phone" }),
    );

    const insertTaskCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO crm_tasks"),
    );
    expect(insertTaskCall).toBeDefined();
    expect(insertTaskCall![1]).toEqual([
      TENANT_A,
      PROJECT_1,
      LEAD_1,
      "call",
      "Sequence step: call_task (step 1)",
      "Call and ask about budget",
      ENROLLMENT_1,
    ]);
  });

  it("skips (does not advance) a due step when checkSendEligibility reports ineligible, and records why", async () => {
    checkSendEligibilityMock.mockResolvedValueOnce({ eligible: false, blockReasons: ["suppressed:unsubscribed"] });
    queueResponses([
      { rowCount: 0, rows: [] }, // UPDATE ... completed
      {
        rowCount: 1,
        rows: [
          {
            enrollment_id: ENROLLMENT_1,
            sequence_id: SEQUENCE_1,
            lead_id: LEAD_1,
            current_step_order: 0,
            step_order: 0,
            step_type: "email",
            message_draft_variant_channel: "email",
            task_instructions: null,
            lead_email: "lead@example.com",
          },
        ],
      }, // SELECT due
    ]);

    const result = await advanceDueEnrollments(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(result.advanced).toBe(0);
    expect(result.tasksCreated).toBe(0);
    expect(result.skipped).toEqual([{ enrollmentId: ENROLLMENT_1, reason: "ineligible:suppressed:unsubscribed" }]);

    // No crm_tasks / message_draft_variants / enrollment UPDATE query issued
    // after the ineligible result — the whole batch is never failed, just
    // this one step is left un-advanced.
    expect(queryMock.mock.calls.length).toBe(2);
  });

  it("advances an eligible email step once a matching message_draft_variants row exists", async () => {
    checkSendEligibilityMock.mockResolvedValueOnce({ eligible: true, blockReasons: [] });
    queueResponses([
      { rowCount: 0, rows: [] }, // UPDATE ... completed
      {
        rowCount: 1,
        rows: [
          {
            enrollment_id: ENROLLMENT_1,
            sequence_id: SEQUENCE_1,
            lead_id: LEAD_1,
            current_step_order: 0,
            step_order: 0,
            step_type: "email",
            message_draft_variant_channel: "email",
            task_instructions: null,
            lead_email: "lead@example.com",
          },
        ],
      }, // SELECT due
      { rowCount: 1, rows: [{ id: "variant-1" }] }, // SELECT message_draft_variants: found
      { rowCount: 1, rows: [] }, // UPDATE current_step_order
    ]);

    const result = await advanceDueEnrollments(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(result.advanced).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it("leaves an email step un-advanced (and records why) when no matching draft variant exists, rather than fabricating content", async () => {
    checkSendEligibilityMock.mockResolvedValueOnce({ eligible: true, blockReasons: [] });
    queueResponses([
      { rowCount: 0, rows: [] }, // UPDATE ... completed
      {
        rowCount: 1,
        rows: [
          {
            enrollment_id: ENROLLMENT_1,
            sequence_id: SEQUENCE_1,
            lead_id: LEAD_1,
            current_step_order: 0,
            step_order: 0,
            step_type: "email",
            message_draft_variant_channel: "email",
            task_instructions: null,
            lead_email: "lead@example.com",
          },
        ],
      }, // SELECT due
      { rowCount: 0, rows: [] }, // SELECT message_draft_variants: none found
    ]);

    const result = await advanceDueEnrollments(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(result.advanced).toBe(0);
    expect(result.skipped).toEqual([{ enrollmentId: ENROLLMENT_1, reason: "no_matching_draft_variant" }]);
  });

  it("advances a due final_note step directly, with no eligibility check and no task/draft lookup", async () => {
    queueResponses([
      { rowCount: 0, rows: [] }, // UPDATE ... completed
      {
        rowCount: 1,
        rows: [
          {
            enrollment_id: ENROLLMENT_1,
            sequence_id: SEQUENCE_1,
            lead_id: LEAD_1,
            current_step_order: 3,
            step_order: 3,
            step_type: "final_note",
            message_draft_variant_channel: null,
            task_instructions: null,
            lead_email: "lead@example.com",
          },
        ],
      }, // SELECT due
      { rowCount: 1, rows: [] }, // UPDATE current_step_order
    ]);

    const result = await advanceDueEnrollments(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(result.advanced).toBe(1);
    expect(checkSendEligibilityMock).not.toHaveBeenCalled();
  });
});
