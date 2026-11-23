import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  evaluateQualification,
  pickRoundRobinAssignee,
  computeCadenceMultiplier,
  getQualificationThreshold,
  QUALIFIED_SCORE_THRESHOLD,
  HIGH_PRIORITY_SCORE_THRESHOLD,
} from "../src/lib/leadPromotion.js";

// --- Pure-function unit tests (no DB) -------------------------------------

describe("evaluateQualification", () => {
  it("is met when leads.status is already 'qualified', regardless of score", () => {
    const result = evaluateQualification({ status: "qualified" }, null);
    expect(result.met).toBe(true);
    expect(result.reason).toBe("status_qualified");
  });

  it("is met when the lead's score crosses the threshold even if status is 'new'", () => {
    const result = evaluateQualification({ status: "new" }, { total_score: 72 });
    expect(result.met).toBe(true);
    expect(result.reason).toBe("score_threshold");
    expect(result.totalScore).toBe(72);
  });

  it("is met at exactly the threshold boundary", () => {
    const result = evaluateQualification({ status: "new" }, { total_score: QUALIFIED_SCORE_THRESHOLD });
    expect(result.met).toBe(true);
  });

  it("is not met below the threshold with no 'qualified' status", () => {
    const result = evaluateQualification({ status: "new" }, { total_score: 49.99 });
    expect(result.met).toBe(false);
    expect(result.reason).toBe("not_qualified");
  });

  it("is not met when there is no score at all and status isn't 'qualified'", () => {
    const result = evaluateQualification({ status: "new" }, null);
    expect(result.met).toBe(false);
    expect(result.totalScore).toBeNull();
  });

  // Ported qualification_settings feature: the threshold source is
  // configurable per project, but the default (no 3rd arg) is unchanged.
  it("defaults to QUALIFIED_SCORE_THRESHOLD when no explicit threshold is passed", () => {
    const result = evaluateQualification({ status: "new" }, { total_score: 50 });
    expect(result.met).toBe(true);
    expect(result.threshold).toBe(QUALIFIED_SCORE_THRESHOLD);
  });

  it("honors an explicit, lower project-configured threshold", () => {
    const result = evaluateQualification({ status: "new" }, { total_score: 30 }, 25);
    expect(result.met).toBe(true);
    expect(result.reason).toBe("score_threshold");
    expect(result.threshold).toBe(25);
  });

  it("honors an explicit, higher project-configured threshold (score that would qualify at the default no longer does)", () => {
    const result = evaluateQualification({ status: "new" }, { total_score: 60 }, 80);
    expect(result.met).toBe(false);
    expect(result.reason).toBe("not_qualified");
    expect(result.threshold).toBe(80);
  });

  it("status_qualified still wins regardless of a custom threshold", () => {
    const result = evaluateQualification({ status: "qualified" }, { total_score: 1 }, 90);
    expect(result.met).toBe(true);
    expect(result.reason).toBe("status_qualified");
  });
});

describe("getQualificationThreshold", () => {
  const TENANT = "11111111-1111-1111-1111-111111111111";
  const PROJECT = "33333333-3333-3333-3333-333333333333";

  it("falls back to QUALIFIED_SCORE_THRESHOLD when the project has no configured row", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const threshold = await getQualificationThreshold({ query } as never, TENANT, PROJECT);
    expect(threshold).toBe(QUALIFIED_SCORE_THRESHOLD);
  });

  it("returns the project's configured min_score_to_qualify when a row exists", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ min_score_to_qualify: 65 }] });
    const threshold = await getQualificationThreshold({ query } as never, TENANT, PROJECT);
    expect(threshold).toBe(65);
  });
});

describe("pickRoundRobinAssignee", () => {
  const members = [{ user_id: "a" }, { user_id: "b" }, { user_id: "c" }];

  it("picks the first member when there is no prior assignment", () => {
    expect(pickRoundRobinAssignee(members, null)).toBe("a");
  });

  it("picks the next member after the last-assigned one", () => {
    expect(pickRoundRobinAssignee(members, "a")).toBe("b");
    expect(pickRoundRobinAssignee(members, "b")).toBe("c");
  });

  it("wraps around after the last member", () => {
    expect(pickRoundRobinAssignee(members, "c")).toBe("a");
  });

  it("restarts at the first member if the last-assigned user is no longer active", () => {
    expect(pickRoundRobinAssignee(members, "deactivated-user")).toBe("a");
  });

  it("returns null when there are no active members", () => {
    expect(pickRoundRobinAssignee([], null)).toBeNull();
  });
});

describe("computeCadenceMultiplier", () => {
  it("accelerates to half cadence (0.5x) at/above the high-priority score threshold", () => {
    const qualification = evaluateQualification({ status: "new" }, { total_score: HIGH_PRIORITY_SCORE_THRESHOLD });
    const cadence = computeCadenceMultiplier(qualification);
    expect(cadence.multiplier).toBe(0.5);
    expect(cadence.tier).toBe("accelerated_high_priority");
  });

  it("accelerates to 0.75x for a lead that merely meets the qualification threshold", () => {
    const qualification = evaluateQualification({ status: "new" }, { total_score: QUALIFIED_SCORE_THRESHOLD });
    const cadence = computeCadenceMultiplier(qualification);
    expect(cadence.multiplier).toBe(0.75);
    expect(cadence.tier).toBe("accelerated_qualified");
  });

  it("accelerates to 0.75x for a human-marked 'qualified' lead even with no score yet", () => {
    const qualification = evaluateQualification({ status: "qualified" }, null);
    const cadence = computeCadenceMultiplier(qualification);
    expect(cadence.multiplier).toBe(0.75);
  });

  it("keeps the standard (1x) cadence for a not-yet-qualified or unscored lead", () => {
    const qualification = evaluateQualification({ status: "new" }, null);
    const cadence = computeCadenceMultiplier(qualification);
    expect(cadence.multiplier).toBe(1);
    expect(cadence.tier).toBe("standard");
  });

  it("keeps the standard (1x) cadence just below the qualification threshold", () => {
    const qualification = evaluateQualification({ status: "new" }, { total_score: QUALIFIED_SCORE_THRESHOLD - 0.01 });
    const cadence = computeCadenceMultiplier(qualification);
    expect(cadence.multiplier).toBe(1);
  });
});

// --- Route-level tests (mocked pg, same pattern as deals.test.ts) --------

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { leadPromotionRouter } = await import("../src/routes/leadPromotion.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/promote-to-crm",
    leadPromotionRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const COMPANY_1 = "66666666-6666-6666-6666-666666666666";
const CONTACT_1 = "77777777-7777-7777-7777-777777777777";
const USER_1 = "user-1";
const REP_1 = "88888888-8888-8888-8888-888888888888";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership() {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role: "sales", status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

function qualifiedLeadRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    rowCount: 1,
    rows: [
      {
        id: LEAD_1,
        tenant_id: TENANT_A,
        project_id: PROJECT_1,
        name: "Jane Doe",
        email: "jane@acme.com",
        company: "Acme Inc",
        company_id: null,
        status: "qualified",
        custom_fields: {},
        ...overrides,
      },
    ],
  };
}

describe("POST .../leads/:leadId/promote-to-crm", () => {
  it("400s a not-yet-qualified lead with no override", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      qualifiedLeadRow({ status: "new" }), // lead
      { rowCount: 0, rows: [] }, // no lead_scores row
      { rowCount: 0, rows: [] }, // no qualification_settings row -> default threshold
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO companies")),
    ).toBe(false);
  });

  it("promotes a qualified lead: creates a new company (no existing match) and a new contact", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      qualifiedLeadRow(), // lead (status already 'qualified')
      { rowCount: 0, rows: [] }, // no lead_scores row
      { rowCount: 0, rows: [] }, // no qualification_settings row -> default threshold
      { rowCount: 0, rows: [] }, // existing companies in project (none match)
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Inc", domain: "acme.com" }] }, // INSERT companies
      { rowCount: 1, rows: [] }, // UPDATE leads SET company_id
      { rowCount: 0, rows: [] }, // existing contact for this lead_id — none
      { rowCount: 0, rows: [] }, // existing contact by normalized email — none
      { rowCount: 1, rows: [{ id: CONTACT_1, name: "Jane Doe", email: "jane@acme.com", company_id: COMPANY_1 }] }, // INSERT contacts
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.promotion.company.id).toBe(COMPANY_1);
    expect(res.body.promotion.companyCreated).toBe(true);
    expect(res.body.promotion.contact.id).toBe(CONTACT_1);
    expect(res.body.promotion.contactCreated).toBe(true);
    expect(res.body.promotion.assignment).toBeNull();
    expect(res.body.promotion.qualification.met).toBe(true);
  });

  it("is idempotent: a second promote call reuses the existing company (lead.company_id already set) and contact", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      qualifiedLeadRow({ company_id: COMPANY_1 }), // lead already linked
      { rowCount: 0, rows: [] }, // no lead_scores row
      { rowCount: 0, rows: [] }, // no qualification_settings row -> default threshold
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Inc" }] }, // load existing company by id
      // no UPDATE leads query expected since company_id was already set
      { rowCount: 1, rows: [{ id: CONTACT_1, name: "Jane Doe", lead_id: LEAD_1 }] }, // existing contact found by lead_id
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.promotion.companyCreated).toBe(false);
    expect(res.body.promotion.contactCreated).toBe(false);
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("UPDATE leads")),
    ).toBe(false);
  });

  it("explicitly assigns to a given active tenant member", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      qualifiedLeadRow({ company_id: COMPANY_1 }),
      { rowCount: 0, rows: [] }, // no lead_scores row
      { rowCount: 0, rows: [] }, // no qualification_settings row -> default threshold
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Inc" }] }, // load existing company
      { rowCount: 1, rows: [{ id: CONTACT_1, name: "Jane Doe" }] }, // existing contact by lead_id
      { rowCount: 1, rows: [{ status: "active" }] }, // assertActiveTenantMember(assignedUserId)
      { rowCount: 1, rows: [{ id: "assign-1", assigned_user_id: REP_1 }] }, // INSERT lead_assignments
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({ assignedUserId: REP_1 });

    expect(res.status).toBe(200);
    expect(res.body.promotion.assignment.assigned_user_id).toBe(REP_1);
    expect(res.body.promotion.assignmentCreated).toBe(true);
  });

  it("auto-assigns round-robin when the lead has no current assignment", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      qualifiedLeadRow({ company_id: COMPANY_1 }),
      { rowCount: 0, rows: [] }, // no lead_scores row
      { rowCount: 0, rows: [] }, // no qualification_settings row -> default threshold
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Inc" }] }, // load existing company
      { rowCount: 1, rows: [{ id: CONTACT_1, name: "Jane Doe" }] }, // existing contact by lead_id
      { rowCount: 0, rows: [] }, // current assignment for this lead — none
      { rowCount: 2, rows: [{ user_id: "a" }, { user_id: "b" }] }, // active members
      { rowCount: 0, rows: [] }, // last project assignment — none, so starts at "a"
      { rowCount: 1, rows: [{ id: "assign-2", assigned_user_id: "a" }] }, // INSERT lead_assignments
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({ autoAssign: true });

    expect(res.status).toBe(200);
    expect(res.body.promotion.assignment.assigned_user_id).toBe("a");
    expect(res.body.promotion.assignmentCreated).toBe(true);
  });

  it("auto-assign is a no-op (honestly reported) when no active tenant members exist", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      qualifiedLeadRow({ company_id: COMPANY_1 }),
      { rowCount: 0, rows: [] }, // no lead_scores row
      { rowCount: 0, rows: [] }, // no qualification_settings row -> default threshold
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Inc" }] },
      { rowCount: 1, rows: [{ id: CONTACT_1, name: "Jane Doe" }] }, // existing contact by lead_id
      { rowCount: 0, rows: [] }, // current assignment — none
      { rowCount: 0, rows: [] }, // active members — none
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({ autoAssign: true });

    expect(res.status).toBe(200);
    expect(res.body.promotion.assignment).toBeNull();
    expect(res.body.promotion.assignmentSkippedReason).toBe("no_active_members");
  });

  it("rejects assignedUserId + autoAssign together", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({ assignedUserId: REP_1, autoAssign: true });

    expect(res.status).toBe(400);
  });

  it("allows overriding a not-yet-qualified lead and records that on the audit event", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      qualifiedLeadRow({ status: "new", company: null, company_id: null }), // no company text at all
      { rowCount: 0, rows: [] }, // no lead_scores row
      { rowCount: 0, rows: [] }, // no qualification_settings row -> default threshold
      // findOrCreateCompanyForLead: candidateName is empty -> no query at all, returns null immediately
      { rowCount: 0, rows: [] }, // existing contact for this lead_id — none
      { rowCount: 0, rows: [] }, // existing contact by normalized email — none
      { rowCount: 1, rows: [{ id: CONTACT_1, name: "Jane Doe", company_id: null }] }, // INSERT contacts
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({ override: true, overrideReason: "Sales manager approved manually" });

    expect(res.status).toBe(200);
    expect(res.body.promotion.company).toBeNull();
    expect(res.body.promotion.qualification.met).toBe(false);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall).toBeDefined();
    const metadata = JSON.parse(auditCall![1][3]);
    expect(metadata.overridden).toBe(true);
    expect(metadata.overrideReason).toBe("Sales manager approved manually");
  });

  it("reuses an existing contact matched by email instead of creating a duplicate across leads", async () => {
    const app = buildApp();
    const OTHER_LEAD = "99999999-9999-9999-9999-999999999999";
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      qualifiedLeadRow({ company_id: COMPANY_1 }), // this lead, already linked to the company
      { rowCount: 0, rows: [] }, // no lead_scores row
      { rowCount: 0, rows: [] }, // no qualification_settings row -> default threshold
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Inc" }] }, // load existing company
      { rowCount: 0, rows: [] }, // existing contact for THIS lead_id — none
      // A contact already exists for jane@acme.com, but tied to a different lead
      // (e.g. created earlier from a discovery-sourced lead for the same person).
      {
        rowCount: 1,
        rows: [{ id: CONTACT_1, name: "Jane Doe", email: "jane@acme.com", lead_id: OTHER_LEAD, company_id: COMPANY_1 }],
      },
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.promotion.contact.id).toBe(CONTACT_1);
    expect(res.body.promotion.contactCreated).toBe(false);
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO contacts")),
    ).toBe(false);
  });

  it("promotes against a project-configured threshold instead of the hardcoded default", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      qualifiedLeadRow({ status: "new", company_id: COMPANY_1 }), // not status-qualified
      { rowCount: 1, rows: [{ total_score: 30 }] }, // score below the hardcoded default (50)...
      { rowCount: 1, rows: [{ min_score_to_qualify: 25 }] }, // ...but this project configured 25
      { rowCount: 1, rows: [{ id: COMPANY_1, name: "Acme Inc" }] }, // load existing company by id
      { rowCount: 0, rows: [] }, // existing contact for this lead_id — none
      { rowCount: 0, rows: [] }, // existing contact by normalized email — none
      { rowCount: 1, rows: [{ id: CONTACT_1, name: "Jane Doe", company_id: COMPANY_1 }] }, // INSERT contacts
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.promotion.qualification.met).toBe(true);
    expect(res.body.promotion.qualification.reason).toBe("score_threshold");
    expect(res.body.promotion.qualification.threshold).toBe(25);

    // Score-triggered promotion (via a configured threshold or the
    // hardcoded default) must still never, by itself, create a `deals` row
    // — qualification/promotion only ever creates companies/contacts/
    // lead_assignments. See leadPromotion.ts's header comment.
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO deals"))).toBe(
      false,
    );
  });

  it("404s when the lead does not belong to this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead not found
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/promote-to-crm`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(404);
  });
});
