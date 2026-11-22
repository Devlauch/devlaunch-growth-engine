import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit-tests lib/prospectingCampaigns.ts's own orchestration directly
// against a fake tenantDb — mocks lib/discoveryRun.js's waterfall/persist
// functions (already covered by their own tests in discoveryRun.test.ts) so
// this file focuses purely on what prospectingCampaigns.ts itself owns:
// loading a campaign's sources in priority order, resolving ICP targeting,
// the status lifecycle, and refusing to double-run/run-with-no-sources.
const runDiscoveryWaterfallMock = vi.fn();
const persistDiscoveryResultMock = vi.fn();

vi.mock("../src/lib/discoveryRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/discoveryRun.js")>();
  return {
    ...actual,
    runDiscoveryWaterfall: (...args: unknown[]) => runDiscoveryWaterfallMock(...args),
    persistDiscoveryResult: (...args: unknown[]) => persistDiscoveryResultMock(...args),
  };
});

const { startCampaignRun, getCampaignResultsSummary } = await import("../src/lib/prospectingCampaigns.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const CAMPAIGN_1 = "55555555-5555-5555-5555-555555555555";
const ICP_1 = "44444444-4444-4444-4444-444444444444";
const SOURCE_1 = "77777777-7777-7777-7777-777777777777";

beforeEach(() => {
  runDiscoveryWaterfallMock.mockReset();
  persistDiscoveryResultMock.mockReset();
});

function fakeTenantDb(responses: unknown[]) {
  const query = vi.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  return { query } as unknown as import("pg").PoolClient;
}

describe("startCampaignRun", () => {
  it("404s when the campaign doesn't exist", async () => {
    const tenantDb = fakeTenantDb([{ rowCount: 0, rows: [] }]);
    await expect(startCampaignRun(tenantDb, TENANT_A, PROJECT_1, CAMPAIGN_1, {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it("409s when the campaign is already running", async () => {
    const tenantDb = fakeTenantDb([{ rowCount: 1, rows: [{ id: CAMPAIGN_1, status: "running" }] }]);
    await expect(startCampaignRun(tenantDb, TENANT_A, PROJECT_1, CAMPAIGN_1, {})).rejects.toMatchObject({
      status: 409,
    });
  });

  it("400s when the campaign has no configured sources", async () => {
    const tenantDb = fakeTenantDb([
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, status: "draft", icp_profile_id: null }] }, // campaign
      { rowCount: 0, rows: [] }, // sources
    ]);
    await expect(startCampaignRun(tenantDb, TENANT_A, PROJECT_1, CAMPAIGN_1, {})).rejects.toMatchObject({
      status: 400,
    });
  });

  it("derives industry/geography from the campaign's accepted ICP profile when the caller doesn't override them", async () => {
    const tenantDb = fakeTenantDb([
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, status: "draft", icp_profile_id: ICP_1 }] }, // campaign
      {
        rowCount: 1,
        rows: [{ id: SOURCE_1, connector_type: "public_directory", name: "A", enabled: true, rate_limit_per_minute: 10, terms_note: null, config: {} }],
      }, // sources
      {
        rowCount: 1,
        rows: [{ firmographics: { industries: ["restaurant"], geographies: ["Global (no specific geography detected)"] } }],
      }, // icp_profiles
      undefined, // UPDATE -> running
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, status: "completed" }] }, // UPDATE -> completed, RETURNING *
    ]);

    runDiscoveryWaterfallMock.mockResolvedValueOnce({
      result: { organizations: [], contacts: {}, sourceId: SOURCE_1 },
      answeredBySourceId: SOURCE_1,
      answeredBySourceName: "A",
      attempts: [{ provider: "A", status: "success", durationMs: 1 }],
    });
    persistDiscoveryResultMock.mockResolvedValueOnce({
      organizationsFound: 0,
      organizationsCreated: 0,
      organizationsDuplicate: 0,
      contactsCreated: 0,
      contactsDuplicate: 0,
      organizations: [],
    });

    const result = await startCampaignRun(tenantDb, TENANT_A, PROJECT_1, CAMPAIGN_1, {});

    expect(runDiscoveryWaterfallMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ industry: "restaurant", geography: undefined }),
    );
    expect(result.campaign.status).toBe("completed");
    expect(persistDiscoveryResultMock).toHaveBeenCalledWith(
      tenantDb,
      TENANT_A,
      PROJECT_1,
      SOURCE_1,
      expect.anything(),
      { prospectingCampaignId: CAMPAIGN_1 },
    );
  });
});

describe("getCampaignResultsSummary", () => {
  it("returns real counts straight off the query result, never fabricated", async () => {
    const tenantDb = fakeTenantDb([
      { rowCount: 1, rows: [{ organizations_found: 4, contacts_found: 2, leads_created: 1, leads_qualified: 1 }] },
    ]);

    const summary = await getCampaignResultsSummary(tenantDb, TENANT_A, PROJECT_1, CAMPAIGN_1);

    expect(summary).toEqual({ organizationsFound: 4, contactsFound: 2, leadsCreated: 1, leadsQualified: 1 });
  });

  it("returns all zeros rather than throwing when a campaign has no activity yet", async () => {
    const tenantDb = fakeTenantDb([{ rowCount: 0, rows: [] }]);
    const summary = await getCampaignResultsSummary(tenantDb, TENANT_A, PROJECT_1, CAMPAIGN_1);
    expect(summary).toEqual({ organizationsFound: 0, contactsFound: 0, leadsCreated: 0, leadsQualified: 0 });
  });
});
