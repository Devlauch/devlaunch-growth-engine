import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as competitors.test.ts: fake the pg pool for true
// unit tests with no real Postgres, and stub global fetch for the
// route-level Crawl4AI + sitemap/robots/site-audit calls (growthAnalyzer.ts's
// own pure heuristics have their own direct unit tests below too).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// SSRF guard (../src/lib/ssrfGuard.js) does real DNS resolution + a pinned
// http/https connection by design (see docs/SECURITY_HARDENING_MILESTONE_1.md)
// — neutralize it here so these route-level tests keep intercepting outbound
// requests at the global-`fetch` layer (stubHealthyDomainFetch below), same
// as before this hardening pass, instead of hitting a real network. Real
// DNS/rebinding/private-IP behavior is covered for real in
// test/ssrfGuard.test.ts.
vi.mock("../src/lib/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ssrfGuard.js")>();
  return {
    ...actual,
    assertSafeUrl: vi.fn(async () => {}),
    safeFetch: vi.fn((url: string, init?: unknown) => (globalThis.fetch as typeof fetch)(url, init as RequestInit)),
  };
});

// growthAnalyzer.ts's runGrowthAnalysis now runs every domain through
// ssrfGuard.ts's assertSafeUrl before crawling (Milestone 7 gap-close: this
// function is reachable from the unauthenticated public growth-audit
// endpoint). assertSafeUrl does a REAL DNS resolve4/resolve6 lookup, which
// would otherwise either fail (no network in CI) or nondeterministically
// depend on real DNS for this file's fake "acme.example.com"/"example.com"
// test domains. Stubbed here at the node:dns boundary — same unit-test
// isolation convention as the fetch stub below — to a real, public,
// non-reserved IP (same one example.com's own real DNS resolves to), so
// every existing test keeps exercising its own actual scenario rather than
// being blocked by this unrelated new guard.
vi.mock("node:dns", () => ({
  promises: {
    resolve4: vi.fn(async () => ["93.184.216.34"]),
    resolve6: vi.fn(async () => {
      throw Object.assign(new Error("no AAAA"), { code: "ENODATA" });
    }),
  },
}));

const { growthAnalyzerRouter } = await import("../src/routes/growthAnalyzer.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const {
  extractProductsServices,
  extractValuePropositions,
  extractTargetAudienceSignals,
  recommendIcp,
  computeContentGaps,
  buildGrowthPlanSummary,
} = await import("../src/lib/growthAnalyzer.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/growth-analyses", growthAnalyzerRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const ANALYSIS_1 = "77777777-7777-7777-7777-777777777777";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  delete process.env.CRAWL4AI_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
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

function fakeResponse(opts: { ok: boolean; status: number; json?: unknown; text?: string }) {
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: "",
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

/** Stubs global fetch for a healthy domain: a 2-URL sitemap, robots found, a
 * Crawl4AI /crawl endpoint returning real-looking page text, and clean
 * per-page metadata (so the site audit finds no issues). */
function stubHealthyDomainFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/crawl")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const target = (body.urls?.[0] as string | undefined) ?? "";
        if (target.endsWith("/pricing")) {
          return fakeResponse({
            ok: true,
            status: 200,
            json: {
              results: [
                {
                  html:
                    "<html><title>Pricing</title><body>Enterprise plans available. Built for marketing teams " +
                    "and growing startups.</body></html>",
                },
              ],
            },
          });
        }
        return fakeResponse({
          ok: true,
          status: 200,
          json: {
            results: [
              { html: "<html><title>Home</title><body>We help growing startups ship marketing campaigns faster.</body></html>" },
            ],
          },
        });
      }
      if (url.includes("/sitemap.xml")) {
        return fakeResponse({
          ok: true,
          status: 200,
          text:
            "<urlset><url><loc>https://acme.example.com/</loc></url>" +
            "<url><loc>https://acme.example.com/pricing</loc></url></urlset>",
        });
      }
      if (url.includes("/robots.txt")) {
        return fakeResponse({ ok: true, status: 200 });
      }
      // runSiteAudit's own per-page HEAD/GET + metadata fetch.
      return fakeResponse({
        ok: true,
        status: 200,
        text:
          '<html><title>A reasonably short page title</title>' +
          '<meta name="description" content="A perfectly reasonable meta description for this page."></html>',
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Pure heuristics (growthAnalyzer.ts)
// ---------------------------------------------------------------------------

describe("growthAnalyzer pure heuristics", () => {
  it("extractProductsServices takes the top keywords verbatim", () => {
    const result = extractProductsServices(
      [
        { keyword: "pipeline", frequency: 5 },
        { keyword: "growth", frequency: 3 },
      ],
      1,
    );
    expect(result).toEqual(["pipeline"]);
  });

  it("extractValuePropositions only returns sentences matching a known trigger phrase", () => {
    const pages = [
      {
        url: "https://x.com/",
        title: "Home",
        extractedText: "We help growing teams ship faster. This is just a plain filler sentence with no trigger.",
      },
    ];
    const result = extractValuePropositions(pages);
    expect(result).toEqual(["We help growing teams ship faster."]);
  });

  it("extractTargetAudienceSignals finds 'for X' phrases and fixed audience keywords", () => {
    const result = extractTargetAudienceSignals("Built for marketing teams. Trusted by enterprise customers.");
    expect(result).toEqual(expect.arrayContaining(["marketing teams", "enterprise"]));
  });

  it("recommendIcp matches fixed industry/geography/segment dictionaries, never fabricating unmatched ones", () => {
    const keywords = [{ keyword: "marketing", frequency: 4 }];
    const result = recommendIcp(
      "Built for marketing teams and startups in the United States.",
      keywords,
      ["marketing teams"],
    );
    expect(result.industries).toContain("Marketing / Agency");
    expect(result.segments).toContain("Startups");
    expect(result.geographies).toContain("United States");
    expect(result.rationale).toMatch(/Industry signal/);
  });

  it("recommendIcp returns an honest empty/default result when nothing matches", () => {
    const result = recommendIcp("completely unrelated filler text with no dictionary hits", [], []);
    expect(result.industries).toEqual([]);
    expect(result.segments).toEqual([]);
    expect(result.geographies).toEqual(["Global (no specific geography detected)"]);
  });

  it("computeContentGaps only returns keywords the competitor has that this site's own keywords lack", () => {
    const own = [{ keyword: "pricing", frequency: 2 }];
    const competitors = [
      { competitorName: "Acme", keywords: [{ keyword: "pricing", frequency: 3 }, { keyword: "onboarding", frequency: 2 }] },
    ];
    const gaps = computeContentGaps(own, competitors);
    expect(gaps).toEqual([{ competitorName: "Acme", gapKeywords: ["onboarding"] }]);
  });

  it("computeContentGaps omits a competitor with no gap", () => {
    const own = [{ keyword: "pricing", frequency: 2 }];
    const competitors = [{ competitorName: "Acme", keywords: [{ keyword: "pricing", frequency: 3 }] }];
    expect(computeContentGaps(own, competitors)).toEqual([]);
  });

  it("buildGrowthPlanSummary is a plain template over real counts, not a generated narrative", () => {
    const summary = buildGrowthPlanSummary({
      domain: "acme.example.com",
      pagesCrawled: 2,
      recommendedIcp: { industries: ["SaaS / Software"], geographies: ["Global"], segments: [], rationale: "r" },
      productsServices: ["pipeline"],
      valuePropositions: [],
      contentGapsCount: 3,
      conversionOpportunities: [],
    });
    expect(summary).toMatch(/acme\.example\.com/);
    expect(summary).toMatch(/2 crawled page/);
    expect(summary).toMatch(/3 content gap/);
  });
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("denies GET / when the caller has no active membership in the requested tenant", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });
});

describe("POST /growth-analyses/analyze", () => {
  it("rejects a malformed domain", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses/analyze`)
      .set("X-Dev-User-Id", USER_1)
      .send({ domain: "not a domain" });

    expect(res.status).toBe(400);
  });

  it("honestly persists a failed analysis (no fabricated content) when CRAWL4AI_BASE_URL is not configured", async () => {
    const app = buildApp();
    // Sitemap/robots checks still run via plain fetch (independent of Crawl4AI).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/sitemap.xml") || url.includes("/robots.txt")) {
          return fakeResponse({ ok: false, status: 404 });
        }
        return fakeResponse({ ok: false, status: 404 });
      }),
    );

    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 0, rows: [] }, // loadCompetitorKeywordSets
      {
        rowCount: 1,
        rows: [{ id: ANALYSIS_1, domain: "acme.example.com", status: "failed" }],
      }, // INSERT growth_analyses
      { rowCount: 1, rows: [{ id: "rec-icp", recommendation_type: "icp" }] }, // INSERT icp recommendation
      // The stubbed fetch 404s everything (including the root page for
      // runSiteAudit's own link-status check), so the technical site audit
      // honestly reports a high-severity broken_link issue even though the
      // Crawl4AI crawl itself failed — that's a real, separate finding, so
      // it still gets its own conversion_opportunity recommendation row.
      { rowCount: 1, rows: [{ id: "rec-conv", recommendation_type: "conversion_opportunity" }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses/analyze`)
      .set("X-Dev-User-Id", USER_1)
      .send({ domain: "acme.example.com" });

    expect(res.status).toBe(201);
    expect(res.body.analysis.status).toBe("failed");

    // Verify the actual INSERT INTO growth_analyses was given an honest
    // crawlError and empty extraction fields — never fabricated content.
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes("INSERT INTO growth_analyses"));
    expect(insertCall).toBeTruthy();
    const params = insertCall![1] as unknown[];
    expect(params[3]).toBe("failed"); // status
    expect(params[6]).toMatch(/CRAWL4AI_BASE_URL/); // crawl_error
    expect(JSON.parse(params[9] as string)).toEqual([]); // extracted_keywords
  });

  it("crawls a healthy domain, extracts real keyword/ICP signal, and stores a completed analysis + icp recommendation", async () => {
    const app = buildApp();
    process.env.CRAWL4AI_BASE_URL = "http://crawl4ai.local";
    stubHealthyDomainFetch();

    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 0, rows: [] }, // loadCompetitorKeywordSets (no competitors tracked)
      {
        rowCount: 1,
        rows: [{ id: ANALYSIS_1, domain: "acme.example.com", status: "completed" }],
      }, // INSERT growth_analyses
      { rowCount: 1, rows: [{ id: "rec-icp", recommendation_type: "icp" }] }, // INSERT icp recommendation
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses/analyze`)
      .set("X-Dev-User-Id", USER_1)
      .send({ domain: "acme.example.com" });

    expect(res.status).toBe(201);
    expect(res.body.analysis.status).toBe("completed");
    expect(res.body.recommendations).toHaveLength(1);
    expect(res.body.recommendations[0].recommendation_type).toBe("icp");

    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes("INSERT INTO growth_analyses"));
    const params = insertCall![1] as unknown[];
    expect(params[3]).toBe("completed");
    expect(params[5]).toBe(2); // pages_crawled: home + pricing
    const extractedKeywords = JSON.parse(params[9] as string) as Array<{ keyword: string }>;
    expect(extractedKeywords.map((k) => k.keyword)).toEqual(expect.arrayContaining(["marketing", "startups"]));
    const recommendedIcp = JSON.parse(params[13] as string) as { industries: string[]; segments: string[] };
    expect(recommendedIcp.industries).toContain("Marketing / Agency");
  });
});

describe("GET /growth-analyses", () => {
  it("lists past analyses for the project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ id: ANALYSIS_1, domain: "acme.example.com" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.analyses).toHaveLength(1);
  });
});

describe("GET /growth-analyses/:id", () => {
  it("404s for an analysis that doesn't belong to this project", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [] }, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses/${ANALYSIS_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("returns an analysis with its recommendations", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ id: ANALYSIS_1, domain: "acme.example.com" }] },
      { rowCount: 1, rows: [{ id: "rec-icp", recommendation_type: "icp" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses/${ANALYSIS_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.analysis.id).toBe(ANALYSIS_1);
    expect(res.body.recommendations).toHaveLength(1);
  });
});

describe("POST /growth-analyses/:id/accept-icp", () => {
  it("404s when there is no icp recommendation for this analysis", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 1, rows: [{ id: ANALYSIS_1, domain: "acme.example.com" }] }, // loadAnalysisOr404
      { rowCount: 0, rows: [] }, // no icp recommendation found
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses/${ANALYSIS_1}/accept-icp`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(404);
  });

  it("409s when the recommendation was already accepted", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ id: ANALYSIS_1, domain: "acme.example.com" }] },
      {
        rowCount: 1,
        rows: [{ id: "rec-icp", accepted: true, detail: { industries: [], geographies: [], segments: [], rationale: "r" } }],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses/${ANALYSIS_1}/accept-icp`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(409);
  });

  it("copies the icp recommendation into a new icp_profiles row and marks it accepted", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 1, rows: [{ id: ANALYSIS_1, domain: "acme.example.com" }] }, // loadAnalysisOr404
      {
        rowCount: 1,
        rows: [
          {
            id: "rec-icp",
            accepted: false,
            detail: {
              industries: ["Marketing / Agency"],
              geographies: ["United States"],
              segments: ["Startups"],
              rationale: "Industry signal from site copy: Marketing / Agency.",
            },
          },
        ],
      }, // recommendation lookup
      {
        rowCount: 1,
        rows: [{ id: "icp-1", name: "Growth Analyzer suggestion — acme.example.com", segment: "Startups" }],
      }, // INSERT icp_profiles
      { rowCount: 1, rows: [{ id: "rec-icp", accepted: true, accepted_icp_profile_id: "icp-1" }] }, // UPDATE recommendation
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analyses/${ANALYSIS_1}/accept-icp`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.icpProfile.id).toBe("icp-1");
    expect(res.body.recommendation.accepted).toBe(true);

    const icpInsertCall = queryMock.mock.calls.find((c) => String(c[0]).includes("INSERT INTO icp_profiles"));
    expect(icpInsertCall).toBeTruthy();
    const firmographics = JSON.parse((icpInsertCall![1] as unknown[])[7] as string);
    expect(firmographics.source).toBe("growth_analyzer");
    expect(firmographics.industries).toEqual(["Marketing / Agency"]);
  });
});
