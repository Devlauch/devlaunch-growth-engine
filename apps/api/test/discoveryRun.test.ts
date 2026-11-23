import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors discovery.test.ts's mocking pattern: fake the connector registry
// so these are true unit tests of the waterfall/persistence orchestration,
// independent of any one connector's real implementation. Every
// public_directory source maps to the same connector id, so a single
// discoverMock is queued (mockResolvedValueOnce/mockRejectedValueOnce) in
// the order the waterfall is actually expected to invoke it — a disabled or
// unsupported source never reaches connector.discover at all (it throws
// inside buildDiscoveryWaterfallProviders before that call), so it never
// consumes a slot in that queue.
const discoverMock = vi.fn();

vi.mock("@devlaunch/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devlaunch/agent-sdk")>();
  return {
    ...actual,
    getConnector: vi.fn((id: string) => {
      if (id === "public-directory") {
        return {
          id: "public-directory",
          type: "public_directory",
          termsNote: "test terms",
          defaultRateLimitPerMinute: 10,
          discover: discoverMock,
        };
      }
      return undefined;
    }),
  };
});

const {
  buildDiscoveryWaterfallProviders,
  runDiscoveryWaterfall,
  persistDiscoveryResult,
  DiscoverySourceUnavailableError,
} = await import("../src/lib/discoveryRun.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const SOURCE_1 = "77777777-7777-7777-7777-777777777777";
const SOURCE_2 = "88888888-8888-8888-8888-888888888888";
const CAMPAIGN_1 = "55555555-5555-5555-5555-555555555555";
const ORG_1 = "66666666-6666-6666-6666-666666666666";

beforeEach(() => {
  discoverMock.mockReset();
});

function baseSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SOURCE_1,
    connector_type: "public_directory",
    name: "Public directory A",
    enabled: true,
    rate_limit_per_minute: 10,
    terms_note: null,
    config: {},
    ...overrides,
  };
}

describe("buildDiscoveryWaterfallProviders / runDiscoveryWaterfall", () => {
  it("falls through to the second source when the first returns no organizations", async () => {
    discoverMock
      .mockResolvedValueOnce({ organizations: [], contacts: {} })
      .mockResolvedValueOnce({
        organizations: [
          {
            name: "Acme Inc",
            domain: "acme.com",
            sourceUrl: "https://acme.com",
            discoveredAt: new Date().toISOString(),
            rawMetadata: {},
          },
        ],
        contacts: {},
      });

    const sources = [baseSource(), baseSource({ id: SOURCE_2, name: "Public directory B" })];
    const outcome = await runDiscoveryWaterfall(sources, { industry: "restaurant" });

    expect(outcome.answeredBySourceId).toBe(SOURCE_2);
    expect(outcome.answeredBySourceName).toBe("Public directory B");
    expect(outcome.result?.organizations).toHaveLength(1);
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]).toMatchObject({ provider: "Public directory A", status: "no_result" });
    expect(outcome.attempts[1]).toMatchObject({ provider: "Public directory B", status: "success" });
  });

  it("records a disabled source as an error attempt and keeps going", async () => {
    discoverMock.mockResolvedValueOnce({
      organizations: [
        { name: "Acme Inc", sourceUrl: "https://acme.com", discoveredAt: new Date().toISOString(), rawMetadata: {} },
      ],
      contacts: {},
    });

    const sources = [
      baseSource({ enabled: false }),
      baseSource({ id: SOURCE_2, name: "Public directory B" }),
    ];
    const outcome = await runDiscoveryWaterfall(sources, {});

    expect(outcome.attempts[0].status).toBe("error");
    expect(outcome.answeredBySourceId).toBe(SOURCE_2);
    // The disabled source never reaches connector.discover at all — only
    // one call was made, and it was for the second (enabled) source.
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });

  it("returns null/empty attempts-exhausted when every source is unsupported", async () => {
    const sources = [baseSource({ connector_type: "licensed_api" })];
    const outcome = await runDiscoveryWaterfall(sources, {});

    expect(outcome.result).toBeNull();
    expect(outcome.answeredBySourceId).toBeNull();
    expect(outcome.attempts[0].status).toBe("error");
  });

  it("merges request overrides over a source's own stored config, overrides winning", async () => {
    discoverMock.mockResolvedValueOnce({ organizations: [], contacts: {} });
    const sources = [baseSource({ config: { industry: "stored-industry", geography: "stored-geo" } })];

    await runDiscoveryWaterfall(sources, { industry: "override-industry" });

    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ industry: "override-industry", geography: "stored-geo" }),
      expect.anything(),
    );
  });
});

describe("persistDiscoveryResult", () => {
  function fakeTenantDb(responses: unknown[]) {
    const query = vi.fn();
    for (const r of responses) query.mockResolvedValueOnce(r);
    return { query } as unknown as import("pg").PoolClient;
  }

  it("tags a newly-created organization with prospectingCampaignId when supplied", async () => {
    const tenantDb = fakeTenantDb([
      { rowCount: 0, rows: [] }, // findDuplicateOrganization: by domain
      { rowCount: 0, rows: [] }, // findDuplicateOrganization: by name fallback
      { rowCount: 1, rows: [{ id: ORG_1, name: "Acme Inc", domain: "acme.com" }] }, // INSERT discovered_organizations
      { rowCount: 0, rows: [] }, // getIntegrationCredential (apollo) -- no tenant credential configured
      { rowCount: 1, rows: [{ id: "dmc-1", status: "not_configured" }] }, // decision_maker_cache upsert
    ]);

    const discovery = {
      organizations: [
        { name: "Acme Inc", domain: "acme.com", sourceUrl: "https://acme.com", discoveredAt: new Date().toISOString(), rawMetadata: {} },
      ],
      contacts: {},
    };

    const summary = await persistDiscoveryResult(tenantDb, TENANT_A, PROJECT_1, SOURCE_1, discovery, {
      prospectingCampaignId: CAMPAIGN_1,
    });

    expect(summary.organizationsCreated).toBe(1);
    const insertCall = (tenantDb.query as ReturnType<typeof vi.fn>).mock.calls.find(
      ([sql]: [string]) => sql.includes("INSERT INTO discovered_organizations"),
    );
    expect(insertCall?.[1]).toContain(CAMPAIGN_1);
  });

  it("passes null for prospectingCampaignId when not running under a campaign", async () => {
    const tenantDb = fakeTenantDb([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: ORG_1, name: "Acme Inc", domain: "acme.com" }] },
      { rowCount: 0, rows: [] }, // getIntegrationCredential (apollo) -- no tenant credential configured
      { rowCount: 1, rows: [{ id: "dmc-1", status: "not_configured" }] },
    ]);

    const discovery = {
      organizations: [
        { name: "Acme Inc", domain: "acme.com", sourceUrl: "https://acme.com", discoveredAt: new Date().toISOString(), rawMetadata: {} },
      ],
      contacts: {},
    };

    await persistDiscoveryResult(tenantDb, TENANT_A, PROJECT_1, SOURCE_1, discovery);

    const insertCall = (tenantDb.query as ReturnType<typeof vi.fn>).mock.calls.find(
      ([sql]: [string]) => sql.includes("INSERT INTO discovered_organizations"),
    );
    expect(insertCall?.[1]?.[insertCall[1].length - 1]).toBeNull();
  });
});

describe("DiscoverySourceUnavailableError", () => {
  it("is exported for callers that want to distinguish it from a genuine connector failure", () => {
    expect(new DiscoverySourceUnavailableError("x")).toBeInstanceOf(Error);
  });
});
