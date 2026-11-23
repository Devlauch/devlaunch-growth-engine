import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("competitorDiscoveryProvider", () => {
  const ORIGINAL_SERPAPI_KEY = process.env.SERPAPI_API_KEY;

  afterEach(() => {
    vi.resetModules();
    if (ORIGINAL_SERPAPI_KEY === undefined) {
      delete process.env.SERPAPI_API_KEY;
    } else {
      process.env.SERPAPI_API_KEY = ORIGINAL_SERPAPI_KEY;
    }
  });

  it("returns configured: false and no candidates when SERPAPI_API_KEY is not set", async () => {
    delete process.env.SERPAPI_API_KEY;
    vi.resetModules();
    const { discoverCompetitorCandidates } = await import("../src/lib/competitorDiscoveryProvider.js");

    const result = await discoverCompetitorCandidates({
      ownDomain: "example.com",
      searchTerms: ["invoicing", "payments"],
    });

    expect(result.configured).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.message).toMatch(/requires a configured search provider/i);
  });

  it("returns an honest empty result when there are no usable search terms, even if configured", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    vi.resetModules();
    const { discoverCompetitorCandidates } = await import("../src/lib/competitorDiscoveryProvider.js");

    const result = await discoverCompetitorCandidates({
      ownDomain: "example.com",
      searchTerms: ["ab", ""],
    });

    expect(result.configured).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.message).toMatch(/run a growth analysis/i);
  });

  it("returns real candidate domains from mocked SerpApi organic_results, excluding own domain/already-tracked/non-business hosts", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    vi.resetModules();
    const { discoverCompetitorCandidates } = await import("../src/lib/competitorDiscoveryProvider.js");

    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        organic_results: [
          { position: 1, title: "Example Invoicing Co", link: "https://example.com/pricing", snippet: "our own site" },
          { position: 2, title: "Wikipedia", link: "https://wikipedia.org/wiki/Invoicing", snippet: "encyclopedia" },
          { position: 3, title: "Already Tracked Inc", link: "https://already-tracked.com", snippet: "known" },
          {
            position: 4,
            title: "Acme Invoicing Alternative",
            link: "https://acme-invoicing.com/compare",
            snippet: "A real competitor offering invoicing software.",
          },
        ],
      }),
    })) as unknown as Parameters<typeof discoverCompetitorCandidates>[0]["fetcher"];

    const result = await discoverCompetitorCandidates({
      ownDomain: "example.com",
      searchTerms: ["invoicing"],
      excludeDomains: ["already-tracked.com"],
      fetcher,
    });

    expect(result.configured).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].domain).toBe("acme-invoicing.com");
    expect(result.candidates[0].title).toBe("Acme Invoicing Alternative");
    expect(result.candidates[0].snippet).toBe("A real competitor offering invoicing software.");
    expect(result.candidates[0].matchedQuery).toContain("invoicing");
    expect(result.queriesRun).toHaveLength(1);
  });

  it("skips a failed search query without throwing (per-query failure isolation)", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    vi.resetModules();
    const { discoverCompetitorCandidates } = await import("../src/lib/competitorDiscoveryProvider.js");

    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "upstream failure" }),
    })) as unknown as Parameters<typeof discoverCompetitorCandidates>[0]["fetcher"];

    const result = await discoverCompetitorCandidates({
      ownDomain: "example.com",
      searchTerms: ["invoicing"],
      fetcher,
    });

    expect(result.configured).toBe(true);
    expect(result.candidates).toEqual([]);
  });
});
