import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocked-PoolClient unit-test style as workflowApprovalAndExecutionStage.test.ts:
// this stage takes a PoolClient directly (StageInput.tenantDb), so we fake
// just enough of it (query) rather than standing up express/supertest.
const { runContentCampaignStage } = await import("../src/workflow/stages/contentCampaign.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const RUN_1 = "44444444-4444-4444-4444-444444444444";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const LEAD_2 = "66666666-6666-6666-6666-666666666666";
const CALENDAR_1 = "77777777-7777-7777-7777-777777777777";
const DRAFT_1 = "88888888-8888-8888-8888-888888888888";
const DRAFT_2 = "99999999-9999-9999-9999-999999999999";
const SEQUENCE_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const SAAS_PROFILE = {
  company_name: "Acme SaaS",
  industry: "saas",
  website_url: "https://acme.example",
  value_proposition: "A platform that helps revenue teams eliminate fragmented, manual reporting.",
  target_markets: ["north_america"],
};

function makeQueryMock(responses: unknown[]) {
  const queryMock = vi.fn();
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
  return queryMock;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    workflowRunId: RUN_1,
    priorStageResults: {},
    inputConfig: {},
    ...overrides,
  };
}

describe("runContentCampaignStage", () => {
  it("completes with an honest skip summary when the project has no project profile yet", async () => {
    const queryMock = makeQueryMock([
      { rowCount: 0, rows: [] }, // project_profiles lookup -> none
    ]);

    const result = await runContentCampaignStage(
      baseInput({ tenantDb: { query: queryMock } }) as any,
    );

    expect(result.stage).toBe("content_campaign");
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("No project profile");
    expect(result.data).toEqual({
      skipped: true,
      calendarId: null,
      itemCount: 0,
      messageDraftIds: [],
      sequenceId: null,
      enrollmentCount: 0,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("generates and persists a content calendar, and is honestly completed with no leads to draft", async () => {
    const queryMock = makeQueryMock([
      { rowCount: 1, rows: [SAAS_PROFILE] }, // project_profiles
      { rowCount: 0, rows: [] }, // icp_profiles (no primary ICP)
      { rowCount: 1, rows: [{ id: CALENDAR_1 }] }, // INSERT content_calendars
      // 1 INSERT content_calendar_items per generated item; just resolve
      // every remaining call with a generic success row.
    ]);
    queryMock.mockResolvedValue({ rowCount: 1, rows: [{}] });

    const result = await runContentCampaignStage(
      baseInput({ tenantDb: { query: queryMock }, priorStageResults: {} }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.data.skipped).toBe(false);
    expect(result.data.calendarId).toBe(CALENDAR_1);
    expect((result.data.itemCount as number)).toBeGreaterThan(0);
    expect(result.data.messageDraftIds).toEqual([]);
    expect(result.data.sequenceId).toBeNull();
    expect(result.summary).toContain("no leads were available");

    const calendarInsertCall = queryMock.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT INTO content_calendars"),
    );
    expect(calendarInsertCall).toBeDefined();
    const itemInsertCalls = queryMock.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT INTO content_calendar_items"),
    );
    expect(itemInsertCalls.length).toBe(result.data.itemCount);
  });

  it("drafts messages for each lead (with and without enrichment data) and creates + enrolls a new sequence", async () => {
    const queryMock = vi.fn();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM project_profiles")) return { rowCount: 1, rows: [SAAS_PROFILE] };
      if (sql.includes("FROM icp_profiles") && sql.includes("is_primary")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO content_calendars")) return { rowCount: 1, rows: [{ id: CALENDAR_1 }] };
      if (sql.includes("INSERT INTO content_calendar_items")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("FROM leads WHERE id = $1")) {
        // Called once per lead id, in order.
        const leadId = queryMock.mock.calls.filter((c: unknown[]) => (c[0] as string).includes("FROM leads WHERE id = $1")).length;
        if (leadId === 1) return { rowCount: 1, rows: [{ id: LEAD_1, name: "Jane Doe", email: "jane@acme.com" }] };
        return { rowCount: 1, rows: [{ id: LEAD_2, name: "John Roe", email: "john@beta.example" }] };
      }
      if (sql.includes("FROM company_enrichment")) {
        // LEAD_1 has real enrichment data; LEAD_2 has none.
        const calls = queryMock.mock.calls.filter((c: unknown[]) => (c[0] as string).includes("FROM company_enrichment"));
        if (calls.length === 1) {
          return { rowCount: 1, rows: [{ domain: "acme.com", firmographics: { employee_count: "50-200" } }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM icp_match_scores")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO message_drafts")) {
        const calls = queryMock.mock.calls.filter((c: unknown[]) => (c[0] as string).includes("INSERT INTO message_drafts"));
        return { rowCount: 1, rows: [{ id: calls.length === 1 ? DRAFT_1 : DRAFT_2 }] };
      }
      if (sql.includes("INSERT INTO message_draft_variants")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id FROM sequences")) return { rowCount: 0, rows: [] }; // no existing sequence
      if (sql.includes("INSERT INTO sequences")) return { rowCount: 1, rows: [{ id: SEQUENCE_1 }] };
      if (sql.includes("INSERT INTO sequence_steps")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("FROM sequence_enrollments")) return { rowCount: 0, rows: [] }; // not already enrolled
      if (sql.includes("INSERT INTO sequence_enrollments")) return { rowCount: 1, rows: [{}] };
      return { rowCount: 0, rows: [] };
    });

    const result = await runContentCampaignStage(
      baseInput({
        tenantDb: { query: queryMock },
        priorStageResults: {
          lead_generation: { data: { leadsCreated: [LEAD_1, LEAD_2] }, summary: "found 2 leads" },
        },
      }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.data.messageDraftIds).toEqual([DRAFT_1, DRAFT_2]);
    expect(result.data.sequenceId).toBe(SEQUENCE_1);
    expect(result.data.enrollmentCount).toBe(2);
    expect(result.summary).toContain("drafted messages for 2 of 2 lead(s)");

    const sequenceStepInsertCalls = queryMock.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT INTO sequence_steps"),
    );
    expect(sequenceStepInsertCalls.length).toBe(3); // day 0 email / day 3 call_task / day 7 follow_up_email

    const enrollmentInsertCalls = queryMock.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT INTO sequence_enrollments"),
    );
    expect(enrollmentInsertCalls.length).toBe(2);
  });

  it("caps lead processing at 10 and skips drafting for a lead id that no longer resolves", async () => {
    const manyLeadIds = Array.from({ length: 12 }, (_, i) => `lead-${i}`);
    const queryMock = vi.fn();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM project_profiles")) return { rowCount: 1, rows: [SAAS_PROFILE] };
      if (sql.includes("FROM icp_profiles") && sql.includes("is_primary")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO content_calendars")) return { rowCount: 1, rows: [{ id: CALENDAR_1 }] };
      if (sql.includes("INSERT INTO content_calendar_items")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("FROM leads WHERE id = $1")) return { rowCount: 0, rows: [] }; // none resolve
      return { rowCount: 0, rows: [] };
    });

    const result = await runContentCampaignStage(
      baseInput({
        tenantDb: { query: queryMock },
        priorStageResults: { lead_generation: { data: { leadsCreated: manyLeadIds }, summary: "found 12" } },
      }) as any,
    );

    const leadLookupCalls = queryMock.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("FROM leads WHERE id = $1"),
    );
    expect(leadLookupCalls.length).toBe(10); // capped at MAX_LEADS_TO_DRAFT
    expect(result.data.messageDraftIds).toEqual([]);
    expect(result.status).toBe("completed");
  });

  it("treats a missing/empty lead_generation result as honestly 'no leads yet' rather than failing", async () => {
    const queryMock = makeQueryMock([
      { rowCount: 1, rows: [SAAS_PROFILE] }, // project_profiles
      { rowCount: 0, rows: [] }, // icp_profiles
      { rowCount: 1, rows: [{ id: CALENDAR_1 }] }, // INSERT content_calendars
    ]);
    queryMock.mockResolvedValue({ rowCount: 1, rows: [{}] });

    const result = await runContentCampaignStage(
      baseInput({ tenantDb: { query: queryMock }, priorStageResults: {} }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.data.messageDraftIds).toEqual([]);
    expect(result.data.sequenceId).toBeNull();
    expect(result.data.enrollmentCount).toBe(0);
  });

  it("reuses an existing sequence by name on re-run and skips an already-enrolled lead silently", async () => {
    const queryMock = vi.fn();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM project_profiles")) return { rowCount: 1, rows: [SAAS_PROFILE] };
      if (sql.includes("FROM icp_profiles") && sql.includes("is_primary")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO content_calendars")) return { rowCount: 1, rows: [{ id: CALENDAR_1 }] };
      if (sql.includes("INSERT INTO content_calendar_items")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("FROM leads WHERE id = $1")) return { rowCount: 1, rows: [{ id: LEAD_1, name: "Jane Doe", email: "jane@acme.com" }] };
      if (sql.includes("FROM company_enrichment")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM icp_match_scores")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO message_drafts")) return { rowCount: 1, rows: [{ id: DRAFT_1 }] };
      if (sql.includes("INSERT INTO message_draft_variants")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id FROM sequences")) return { rowCount: 1, rows: [{ id: SEQUENCE_1 }] }; // already exists
      if (sql.includes("FROM sequence_enrollments")) return { rowCount: 1, rows: [{}] }; // already enrolled
      return { rowCount: 0, rows: [] };
    });

    const result = await runContentCampaignStage(
      baseInput({
        tenantDb: { query: queryMock },
        priorStageResults: { lead_generation: { data: { leadsCreated: [LEAD_1] }, summary: "found 1" } },
      }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.data.sequenceId).toBe(SEQUENCE_1);
    expect(result.data.enrollmentCount).toBe(0); // already enrolled, skipped silently

    const sequenceInsertCalls = queryMock.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT INTO sequences"),
    );
    expect(sequenceInsertCalls.length).toBe(0); // no new sequence created
    const enrollmentInsertCalls = queryMock.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT INTO sequence_enrollments"),
    );
    expect(enrollmentInsertCalls.length).toBe(0);
  });
});
