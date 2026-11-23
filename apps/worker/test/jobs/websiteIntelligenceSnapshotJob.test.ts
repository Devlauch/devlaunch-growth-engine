import { describe, it, expect, vi, beforeEach } from "vitest";

// Same DB-mocking pattern as stalledDealCron.test.ts/sequenceSchedulerCron.test.ts.
const queryMock = vi.fn();
const withTenantContextMock = vi.fn(async (_tenantId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
  fn({ query: queryMock }),
);
vi.mock("../../src/db.js", () => ({
  withTenantContext: withTenantContextMock,
  pool: {},
}));

const extractPricingPageMock = vi.fn();
const extractProductCatalogMock = vi.fn();
const extractCaseStudiesMock = vi.fn();
vi.mock("../../src/lib/structuredExtraction.js", () => ({
  extractPricingPage: (...args: unknown[]) => extractPricingPageMock(...args),
  extractProductCatalog: (...args: unknown[]) => extractProductCatalogMock(...args),
  extractCaseStudies: (...args: unknown[]) => extractCaseStudiesMock(...args),
  hashExtractedData: (data: unknown) => `hash(${JSON.stringify(data)})`,
}));

const { processWebsiteIntelligenceSnapshot } = await import("../../src/jobs/websiteIntelligenceSnapshotJob.js");

function fakeJob(data: Record<string, unknown>) {
  return { id: "job-1", data } as unknown as import("bullmq").Job;
}

beforeEach(() => {
  queryMock.mockReset();
  withTenantContextMock.mockClear();
  extractPricingPageMock.mockReset();
  extractProductCatalogMock.mockReset();
  extractCaseStudiesMock.mockReset();
});

describe("processWebsiteIntelligenceSnapshot", () => {
  it("writes a real snapshot row on a successful pricing extraction", async () => {
    extractPricingPageMock.mockResolvedValue({
      ok: true,
      data: { plans: [{ name: "Starter", priceText: "$29/mo", features: [] }] },
      evidence: [{ selectorOrText: "$29/mo", sourceUrl: "https://example.com/pricing", fetchedAt: "2026-01-01T00:00:00Z" }],
    });

    await processWebsiteIntelligenceSnapshot(
      fakeJob({
        tenantId: "tenant-1",
        projectId: "project-1",
        targetUrl: "https://example.com/pricing",
        snapshotType: "pricing",
        requestedBy: "user-1",
      }),
    );

    expect(extractPricingPageMock).toHaveBeenCalledWith("https://example.com/pricing");
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO website_intelligence_snapshots/);
    expect(params[0]).toBe("tenant-1");
    expect(params[3]).toBe("pricing");
    expect(JSON.parse(params[4])).toEqual({ plans: [{ name: "Starter", priceText: "$29/mo", features: [] }] });
  });

  it("honestly writes an {error: ...} row rather than fabricating data when extraction fails", async () => {
    extractProductCatalogMock.mockResolvedValue({
      ok: false,
      data: { products: [] },
      evidence: [],
      fetchError: "CRAWL4AI_BASE_URL is not configured",
    });

    await processWebsiteIntelligenceSnapshot(
      fakeJob({
        tenantId: "tenant-1",
        projectId: "project-1",
        targetUrl: "https://example.com/products",
        snapshotType: "product_catalog",
        requestedBy: "user-1",
      }),
    );

    const [, params] = queryMock.mock.calls[0];
    expect(JSON.parse(params[4])).toEqual({ error: "CRAWL4AI_BASE_URL is not configured" });
  });
});
