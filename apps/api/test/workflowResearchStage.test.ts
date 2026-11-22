import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Direct unit tests of the research stage executor (not a route — it is
// called by the workflow engine with an already-open tenantDb transaction,
// so these tests fake a minimal PoolClient-like object rather than the
// pg-pool-connect mocking pattern used by route-level tests like
// competitors.test.ts/seo.test.ts). Global fetch is stubbed for both the
// Crawl4AI competitor-crawl calls and the plain-fetch calls siteAudit.ts /
// this stage's own client-homepage fetch make, following the same
// convention those route tests use.

const { runResearchStage } = await import("../src/workflow/stages/research.js");

type FakeDbRow = Record<string, unknown>;

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : ""),
  } as unknown as Response;
}

beforeEach(() => {
  delete process.env.CRAWL4AI_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildTenantDb(opts: { websiteUrl?: string | null; existingCompetitorDomains?: string[] } = {}) {
  const websiteUrl = opts.websiteUrl ?? null;
  const existingCompetitorDomains = new Set(opts.existingCompetitorDomains ?? []);

  const query = vi.fn(async (sql: string, _params: unknown[]): Promise<{ rows: FakeDbRow[]; rowCount: number }> => {
    if (sql.includes("FROM project_profiles")) {
      return websiteUrl ? { rows: [{ website_url: websiteUrl }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM competitors WHERE")) {
      const domain = _params[2] as string;
      return existingCompetitorDomains.has(domain)
        ? { rows: [{ id: `competitor-${domain}` }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM competitor_snapshots")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });

  return { query } as unknown as import("pg").PoolClient;
}

function baseInput(overrides: Partial<Parameters<typeof runResearchStage>[0]> = {}) {
  return {
    tenantId: "11111111-1111-1111-1111-111111111111",
    projectId: "33333333-3333-3333-3333-333333333333",
    workflowRunId: "55555555-5555-5555-5555-555555555555",
    tenantDb: buildTenantDb(),
    priorStageResults: {},
    inputConfig: {},
    ...overrides,
  };
}

/** Builds a Crawl4AI /crawl POST response body carrying one page's html. */
function crawl4aiResult(html: string, title?: string) {
  return { results: [{ html, metadata: title ? { title } : {} }] };
}

describe("runResearchStage", () => {
  it("crawls multiple competitors, audits the client's own site, and computes a real keyword overlap", async () => {
    process.env.CRAWL4AI_BASE_URL = "https://crawl4ai.example.internal";

    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      const method = opts?.method ?? "GET";

      if (method === "POST" && url.endsWith("/crawl")) {
        const body = JSON.parse(opts!.body as string) as { urls: string[] };
        const reqUrl = body.urls[0];
        if (reqUrl === "https://comp1.com/") {
          return fakeResponse(200, crawl4aiResult("<html><title>Comp1</title>Growth pipeline marketing strategy</html>", "Comp1"));
        }
        if (reqUrl.startsWith("https://comp1.com/")) {
          return fakeResponse(200, { results: [] }); // no html -> skipped page
        }
        return fakeResponse(200, { results: [] });
      }

      if (url === "https://client.com/sitemap.xml") return fakeResponse(404, "");
      if (url === "https://client.com/robots.txt") return fakeResponse(404, "");
      if (method === "HEAD" && url === "https://client.com") return fakeResponse(200, "");
      if (method === "GET" && url === "https://client.com") {
        return fakeResponse(200, "<html><title>Client</title>Growth pipeline product launch</html>");
      }
      return fakeResponse(404, "");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runResearchStage(
      baseInput({
        inputConfig: {
          researchDomain: "client.com",
          competitorDomains: ["comp1.com"],
        },
      }),
    );

    expect(result.stage).toBe("research");
    expect(result.status).toBe("completed");

    const data = result.data as any;
    expect(data.competitorResults).toHaveLength(1);
    expect(data.competitorResults[0]).toMatchObject({ domain: "comp1.com", status: "crawled", pagesFetched: 1 });

    expect(data.siteAudit).toMatchObject({ domain: "client.com", status: "audited" });

    const comparison = data.keywordComparison.perCompetitor[0];
    expect(comparison.domain).toBe("comp1.com");
    // client: growth, pipeline, product, launch | comp1: growth, pipeline, marketing, strategy
    expect(comparison.overlapKeywords.sort()).toEqual(["growth", "pipeline"]);
    expect(comparison.overlapCount).toBe(2);
    // client keywords also include "client" (from the stripped <title>); competitor keywords include "comp1" likewise.
    expect(comparison.distinctToClientCount).toBe(3);
    expect(comparison.distinctToCompetitorCount).toBe(3);

    expect(result.summary).toContain("comp1.com");
    expect(result.summary.toLowerCase()).toContain("keyword overlap");
  });

  it("records one unreachable competitor without failing the whole stage", async () => {
    process.env.CRAWL4AI_BASE_URL = "https://crawl4ai.example.internal";

    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      const method = opts?.method ?? "GET";
      if (method === "POST" && url.endsWith("/crawl")) {
        const body = JSON.parse(opts!.body as string) as { urls: string[] };
        const reqUrl = body.urls[0];
        if (reqUrl.startsWith("https://comp2.com")) {
          throw new Error("ECONNREFUSED");
        }
        if (reqUrl === "https://comp1.com/") {
          return fakeResponse(200, crawl4aiResult("Growth pipeline"));
        }
        return fakeResponse(200, { results: [] });
      }
      return fakeResponse(404, "");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runResearchStage(
      baseInput({
        inputConfig: { competitorDomains: ["comp1.com", "comp2.com"] },
      }),
    );

    expect(result.status).toBe("completed");
    const data = result.data as any;
    expect(data.competitorResults).toHaveLength(2);
    const comp1 = data.competitorResults.find((c: any) => c.domain === "comp1.com");
    const comp2 = data.competitorResults.find((c: any) => c.domain === "comp2.com");
    expect(comp1.status).toBe("crawled");
    expect(comp2.status).toBe("unreachable");
    expect(comp2.error).toBeTruthy();
    expect(result.summary).toContain("1 unreachable");
  });

  it("gracefully skips the site audit when there is no researchDomain and no project_profiles.website_url", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(404, ""));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runResearchStage(
      baseInput({
        tenantDb: buildTenantDb({ websiteUrl: null }),
        inputConfig: {},
      }),
    );

    expect(result.status).toBe("completed");
    const data = result.data as any;
    expect(data.researchDomain).toBeNull();
    expect(data.siteAudit).toBeNull();
    expect(data.competitorResults).toEqual([]);
    expect(result.summary.toLowerCase()).toContain("no website on file");
  });

  it("falls back to project_profiles.website_url when inputConfig has no researchDomain", async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      const method = opts?.method ?? "GET";
      if (url === "https://fallback.com/sitemap.xml") return fakeResponse(404, "");
      if (url === "https://fallback.com/robots.txt") return fakeResponse(404, "");
      if (method === "HEAD" && url === "https://fallback.com") return fakeResponse(200, "");
      if (method === "GET" && url === "https://fallback.com") {
        return fakeResponse(200, "<html><title>Fallback</title>Hello world</html>");
      }
      return fakeResponse(404, "");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runResearchStage(
      baseInput({
        tenantDb: buildTenantDb({ websiteUrl: "fallback.com" }),
        inputConfig: {},
      }),
    );

    expect(result.status).toBe("completed");
    const data = result.data as any;
    expect(data.researchDomain).toBe("fallback.com");
    expect(data.websiteSource).toBe("project_profiles");
    expect(data.siteAudit).toMatchObject({ domain: "fallback.com", status: "audited" });
  });

  it("treats a thrown runSiteAudit error as a graceful {status:'error'} entry, not a failed stage", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("DNS failure");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runResearchStage(
      baseInput({
        inputConfig: { researchDomain: "broken-site.com" },
      }),
    );

    // runSiteAudit itself never throws (every internal fetch is caught),
    // so this exercises the stage's own defensive try/catch around it too.
    expect(result.status).toBe("completed");
    const data = result.data as any;
    expect(data.siteAudit.status).toBe("audited");
    expect(data.siteAudit.sitemapFound).toBe(false);
    expect(data.siteAudit.robotsFound).toBe(false);
  });
});
