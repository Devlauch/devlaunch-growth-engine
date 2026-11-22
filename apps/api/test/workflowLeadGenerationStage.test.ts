import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocking pattern as discovery.test.ts / leadIntelligence.test.ts: a
// fake tenantDb (just { query }) and fully-mocked collaborator modules, so
// this is a true unit test of the stage's own orchestration glue — no real
// Postgres, no real DNS, and no dependence on the real enrich/match/score
// math (which already have their own dedicated test suites).
const queryMock = vi.fn();

const discoverMock = vi.fn();
vi.mock("@devlaunch/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devlaunch/agent-sdk")>();
  return {
    ...actual,
    getConnector: vi.fn((id: string) =>
      id === "public-directory"
        ? {
            id: "public-directory",
            type: "public_directory",
            termsNote: "test terms",
            defaultRateLimitPerMinute: 10,
            discover: discoverMock,
          }
        : undefined,
    ),
  };
});

const enrichLeadMock = vi.fn(async () => ({ enrichment: { id: "enrich-1" }, matchedOrganization: null }));
vi.mock("../src/lib/companyEnrichment.js", () => ({
  enrichLead: enrichLeadMock,
}));

const matchLeadToAllIcpsMock = vi.fn(async () => [] as { match_score: number }[]);
vi.mock("../src/lib/icpMatching.js", () => ({
  matchLeadToAllIcps: matchLeadToAllIcpsMock,
}));

const { runLeadGenerationStage } = await import("../src/workflow/stages/leadGeneration.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const WORKFLOW_RUN_1 = "44444444-4444-4444-4444-444444444444";
const SOURCE_1 = "77777777-7777-7777-7777-777777777777";
const ORG_1 = "66666666-6666-6666-6666-666666666666";
const ORG_2 = "99999999-9999-9999-9999-999999999999";

beforeEach(() => {
  queryMock.mockReset();
  discoverMock.mockReset();
  enrichLeadMock.mockClear();
  matchLeadToAllIcpsMock.mockReset();
  matchLeadToAllIcpsMock.mockResolvedValue([]);
});

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

function buildInput(inputConfig: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    workflowRunId: WORKFLOW_RUN_1,
    tenantDb: { query: queryMock } as never,
    priorStageResults: {},
    inputConfig,
  };
}

describe("runLeadGenerationStage", () => {
  it("reuses an existing public_directory discovery source and runs the full enrich/match/score chain for a new lead", async () => {
    discoverMock.mockResolvedValueOnce({
      organizations: [
        {
          name: "Acme Co",
          domain: "acme.example",
          sourceUrl: "https://acme.example",
          discoveredAt: new Date().toISOString(),
          rawMetadata: { source: "openstreetmap-overpass" },
        },
      ],
      contacts: {
        "Acme Co": [{ email: "jane@acme.example", contactChannel: "named_person" }],
      },
    });
    matchLeadToAllIcpsMock.mockResolvedValueOnce([{ match_score: 50 }, { match_score: 30 }]);

    queueResponses([
      // getOrCreateDiscoverySource: existing row found
      {
        rowCount: 1,
        rows: [
          {
            id: SOURCE_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            connector_type: "public_directory",
            name: "Existing source",
            enabled: true,
            rate_limit_per_minute: 10,
            terms_note: null,
            config: {},
          },
        ],
      },
      // findDuplicateOrganization: by domain -> none, by name -> none
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      // INSERT discovered_organizations
      {
        rowCount: 1,
        rows: [
          {
            id: ORG_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            discovery_source_id: SOURCE_1,
            name: "Acme Co",
            domain: "acme.example",
            normalized_domain: "acme.example",
            normalized_name: "acme co",
            source_url: "https://acme.example",
            raw_metadata: {},
            status: "new",
          },
        ],
      },
      // findDuplicateContact: by email -> none (contact has no name, so no byName query)
      { rowCount: 0, rows: [] },
      // INSERT discovered_contacts
      {
        rowCount: 1,
        rows: [
          {
            id: "contact-1",
            tenant_id: TENANT_A,
            organization_id: ORG_1,
            name: null,
            role_title: null,
            email: "jane@acme.example",
            normalized_email: "jane@acme.example",
            phone: null,
            contact_channel: "named_person",
            verification_status: "unverified",
            email_verification: {},
            source_url: null,
          },
        ],
      },
      // existing-lead-by-email lookup -> none
      { rowCount: 0, rows: [] },
      // INSERT leads
      { rowCount: 1, rows: [{ id: "lead-1" }] },
      // recomputeRubricScore: no active rubric
      { rowCount: 0, rows: [] },
    ]);

    const result = await runLeadGenerationStage(buildInput());

    expect(result.stage).toBe("lead_generation");
    expect(result.status).toBe("completed");
    expect(result.data.discoverySourceCreated).toBe(false);
    expect(result.data.discoveredCount).toBe(1);
    expect(result.data.organizationsCreated).toBe(1);
    expect(result.data.leadsCreated).toEqual(["lead-1"]);
    expect(result.data.scores).toEqual([{ leadId: "lead-1", icpAverage: 40, rubricScore: null }]);
    expect(result.summary).toContain("Discovered 1 organization(s)");
    expect(result.summary).toContain("created 1 new lead(s)");
    expect(result.summary).toContain("Average ICP match 40%");
    expect(result.summary).toContain("No active scoring rubric");

    // Discovery wasn't re-created since an existing source was found.
    const insertSourceCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO discovery_sources"),
    );
    expect(insertSourceCall).toBeUndefined();

    // The enrich/match/score chain ran exactly once, for the one new lead.
    expect(enrichLeadMock).toHaveBeenCalledTimes(1);
    expect(enrichLeadMock).toHaveBeenCalledWith({ query: queryMock }, TENANT_A, PROJECT_1, "lead-1");
    expect(matchLeadToAllIcpsMock).toHaveBeenCalledTimes(1);
    expect(matchLeadToAllIcpsMock).toHaveBeenCalledWith({ query: queryMock }, TENANT_A, PROJECT_1, "lead-1");
  });

  it("creates a new public_directory discovery source when the project has none yet", async () => {
    discoverMock.mockResolvedValueOnce({ organizations: [], contacts: {} });

    queueResponses([
      // getOrCreateDiscoverySource: none found
      { rowCount: 0, rows: [] },
      // INSERT discovery_sources
      {
        rowCount: 1,
        rows: [
          {
            id: SOURCE_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            connector_type: "public_directory",
            name: "Workflow lead generation (public directory)",
            enabled: true,
            rate_limit_per_minute: 10,
            terms_note: null,
            config: { industry: "restaurant", geography: "Springfield" },
          },
        ],
      },
    ]);

    const result = await runLeadGenerationStage(
      buildInput({ industry: "restaurant", geography: "Springfield" }),
    );

    expect(result.status).toBe("completed");
    expect(result.data.discoverySourceCreated).toBe(true);
    expect(result.data.leadsCreated).toEqual([]);
    expect(result.summary).toContain("No new leads were created this run.");

    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ industry: "restaurant", geography: "Springfield" }),
      expect.objectContaining({ enabled: true }),
    );

    const insertSourceCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO discovery_sources"),
    );
    expect(insertSourceCall).toBeDefined();
    expect(JSON.parse(insertSourceCall![1][3] as string)).toEqual({
      industry: "restaurant",
      geography: "Springfield",
    });
  });

  it("skips creating a lead for a contact whose email already matches an existing lead, but still creates one for a genuinely new contact", async () => {
    discoverMock.mockResolvedValueOnce({
      organizations: [
        {
          name: "Acme Co",
          domain: "acme.example",
          sourceUrl: "https://acme.example",
          discoveredAt: new Date().toISOString(),
          rawMetadata: {},
        },
        {
          name: "Beta Inc",
          domain: "beta.example",
          sourceUrl: "https://beta.example",
          discoveredAt: new Date().toISOString(),
          rawMetadata: {},
        },
      ],
      contacts: {
        "Acme Co": [{ email: "existing@acme.example", contactChannel: "named_person" }],
        "Beta Inc": [{ email: "new@beta.example", contactChannel: "named_person" }],
      },
    });

    queueResponses([
      // getOrCreateDiscoverySource: existing row found
      {
        rowCount: 1,
        rows: [
          {
            id: SOURCE_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            connector_type: "public_directory",
            name: "Existing source",
            enabled: true,
            rate_limit_per_minute: 10,
            terms_note: null,
            config: {},
          },
        ],
      },
      // Org 1 (Acme Co): dedup by domain/name -> none, insert
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: ORG_1, name: "Acme Co", domain: "acme.example", source_url: "https://acme.example" }] },
      // Contact dedup by email -> none, insert
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [{ id: "contact-1", organization_id: ORG_1, name: null, role_title: null, email: "existing@acme.example" }],
      },
      // Org 2 (Beta Inc): dedup by domain/name -> none, insert
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: ORG_2, name: "Beta Inc", domain: "beta.example", source_url: "https://beta.example" }] },
      // Contact dedup by email -> none, insert
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [{ id: "contact-2", organization_id: ORG_2, name: null, role_title: null, email: "new@beta.example" }],
      },
      // Lead loop: Acme's contact already has a lead by email -> skip
      { rowCount: 1, rows: [{ id: "existing-lead-id" }] },
      // Lead loop: Beta's contact is new -> no existing lead, insert
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: "lead-2" }] },
      // recomputeRubricScore: no active rubric
      { rowCount: 0, rows: [] },
    ]);

    const result = await runLeadGenerationStage(buildInput());

    expect(result.status).toBe("completed");
    expect(result.data.discoveredCount).toBe(2);
    expect(result.data.organizationsCreated).toBe(2);
    expect(result.data.leadsCreated).toEqual(["lead-2"]);

    const insertLeadCalls = queryMock.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO leads"),
    );
    expect(insertLeadCalls).toHaveLength(1);
    expect(insertLeadCalls[0][1]).toContain("new@beta.example");

    // The enrich/match/score chain only ran for the one genuinely new lead.
    expect(enrichLeadMock).toHaveBeenCalledTimes(1);
    expect(enrichLeadMock).toHaveBeenCalledWith({ query: queryMock }, TENANT_A, PROJECT_1, "lead-2");
  });

  it("is still 'completed' (not 'failed') when discovery finds nothing new", async () => {
    discoverMock.mockResolvedValueOnce({ organizations: [], contacts: {} });

    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: SOURCE_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            connector_type: "public_directory",
            name: "Existing source",
            enabled: true,
            rate_limit_per_minute: 10,
            terms_note: null,
            config: {},
          },
        ],
      },
    ]);

    const result = await runLeadGenerationStage(buildInput());

    expect(result.status).toBe("completed");
    expect(result.data.discoveredCount).toBe(0);
    expect(result.data.organizationsCreated).toBe(0);
    expect(result.data.leadsCreated).toEqual([]);
    expect(result.summary).toContain("No new leads were created this run.");
    expect(enrichLeadMock).not.toHaveBeenCalled();
    expect(matchLeadToAllIcpsMock).not.toHaveBeenCalled();
  });

  it("reports a disabled discovery source as a completed no-op rather than erroring", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: SOURCE_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            connector_type: "public_directory",
            name: "Disabled source",
            enabled: false,
            rate_limit_per_minute: 10,
            terms_note: null,
            config: {},
          },
        ],
      },
    ]);

    const result = await runLeadGenerationStage(buildInput());

    expect(result.status).toBe("completed");
    expect(result.data.leadsCreated).toEqual([]);
    expect(discoverMock).not.toHaveBeenCalled();
  });
});
