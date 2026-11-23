import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

// Same mocking pattern as discovery.test.ts/seo.test.ts: fake the pg pool
// so these are true unit tests with no real Postgres, and stub global
// fetch for the route-level Crawl4AI calls (crawl4aiClient.ts/
// competitorChangeDetection.ts have their own pure-function unit tests
// below too).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// SSRF guard (../src/lib/ssrfGuard.js) does real DNS resolution + a pinned
// http/https connection by design (see docs/SECURITY_HARDENING_MILESTONE_1.md)
// — neutralize it here so these route-level tests keep intercepting outbound
// requests at the global-`fetch` layer, instead of hitting a real network.
// Real DNS/rebinding/private-IP behavior is covered for real in
// test/ssrfGuard.test.ts.
vi.mock("../src/lib/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ssrfGuard.js")>();
  return {
    ...actual,
    assertSafeUrl: vi.fn(async () => {}),
    safeFetch: vi.fn((url: string, init?: unknown) => (globalThis.fetch as typeof fetch)(url, init as RequestInit)),
  };
});

const { competitorsRouter } = await import("../src/routes/competitors.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { extractKeywords } = await import("../src/lib/keywordExtraction.js");
const { detectCompetitorChanges } = await import("../src/lib/competitorChangeDetection.js");
const { fetchCompetitorPage, Crawl4AINotConfiguredError, Crawl4AIUnreachableError } = await import(
  "../src/lib/crawl4aiClient.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/competitors", competitorsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const COMPETITOR_1 = "66666666-6666-6666-6666-666666666666";
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

function fakeResponse(opts: { ok: boolean; status: number; json?: unknown }) {
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: "",
    json: async () => opts.json ?? {},
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// extractKeywords (pure)
// ---------------------------------------------------------------------------

describe("keywordExtraction.extractKeywords", () => {
  it("lowercases, strips stopwords, and ranks by frequency", () => {
    const result = extractKeywords("Pipeline pipeline Growth growth growth and the a plan", 10);
    expect(result[0]).toEqual({ keyword: "growth", frequency: 3 });
    expect(result.find((k) => k.keyword === "the")).toBeUndefined();
  });

  it("returns an empty array for empty text", () => {
    expect(extractKeywords("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectCompetitorChanges (pure)
// ---------------------------------------------------------------------------

describe("competitorChangeDetection.detectCompetitorChanges", () => {
  it("flags every current page as new_page when there is no prior snapshot", () => {
    const current = [{ url: "https://x.com/", pageType: "home", extractedText: "hello world", contentHash: "h1" }];
    const changes = detectCompetitorChanges(null, current);
    expect(changes).toEqual([
      expect.objectContaining({ changeType: "new_page", pageUrl: "https://x.com/" }),
    ]);
  });

  it("flags content_changed when a known page's contentHash differs", () => {
    const previous = [
      { url: "https://x.com/pricing", pageType: "pricing", extractedText: "old pricing text here", contentHash: "h1" },
    ];
    const current = [
      {
        url: "https://x.com/pricing",
        pageType: "pricing",
        extractedText: "brand new pricing text with different words entirely",
        contentHash: "h2",
      },
    ];
    const changes = detectCompetitorChanges(previous, current);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("content_changed");
    expect(changes[0].diffSummary).toMatch(/word count/);
  });

  it("does not flag anything when contentHash is unchanged", () => {
    const page = { url: "https://x.com/about", pageType: "about", extractedText: "same text", contentHash: "h1" };
    const changes = detectCompetitorChanges([page], [page]);
    expect(changes).toEqual([]);
  });

  it("flags page_removed when a previously-seen URL is missing from the new crawl", () => {
    const previous = [{ url: "https://x.com/blog", pageType: "blog", extractedText: "blog text", contentHash: "h1" }];
    const changes = detectCompetitorChanges(previous, []);
    expect(changes).toEqual([
      expect.objectContaining({ changeType: "page_removed", pageUrl: "https://x.com/blog" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// crawl4aiClient (pure, injectable fetchImpl)
// ---------------------------------------------------------------------------

describe("crawl4aiClient.fetchCompetitorPage", () => {
  it("throws Crawl4AINotConfiguredError when no baseUrl/CRAWL4AI_BASE_URL is set", async () => {
    await expect(fetchCompetitorPage("https://x.com/")).rejects.toBeInstanceOf(Crawl4AINotConfiguredError);
  });

  it("throws Crawl4AIUnreachableError on a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      fetchCompetitorPage("https://x.com/", { baseUrl: "http://crawl4ai.local", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(Crawl4AIUnreachableError);
  });

  it("returns html+title on success", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ ok: true, status: 200, json: { results: [{ html: "<p>hi</p>", metadata: { title: "Hi" } }] } }),
    );
    const result = await fetchCompetitorPage("https://x.com/", {
      baseUrl: "http://crawl4ai.local",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.html).toBe("<p>hi</p>");
    expect(result.title).toBe("Hi");
  });
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("denies GET /competitors when the caller has no active membership in the requested tenant", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });
});

describe("competitors CRUD", () => {
  it("lists competitors for a project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 1, rows: [{ id: COMPETITOR_1, name: "Acme", domain: "acme.example.com" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.competitors).toHaveLength(1);
  });

  it("creates a competitor", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      {
        rowCount: 1,
        rows: [{ id: COMPETITOR_1, name: "Acme", domain: "acme.example.com", is_active: true }],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Acme", domain: "acme.example.com" });

    expect(res.status).toBe(201);
    expect(res.body.competitor.domain).toBe("acme.example.com");
  });

  it("rejects creating a competitor with no domain", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Acme" });

    expect(res.status).toBe(400);
  });

  it("updates a competitor", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 1, rows: [{ id: COMPETITOR_1 }] }, // loadCompetitorOr404
      { rowCount: 1, rows: [{ id: COMPETITOR_1, name: "Acme Inc", domain: "acme.example.com" }] },
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/${COMPETITOR_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Acme Inc" });

    expect(res.status).toBe(200);
    expect(res.body.competitor.name).toBe("Acme Inc");
  });

  it("404s updating a competitor that doesn't belong to this project", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [] }, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/${COMPETITOR_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "x" });

    expect(res.status).toBe(404);
  });

  it("deletes a competitor", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ id: COMPETITOR_1 }] },
      undefined, // DELETE
    ]);

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/${COMPETITOR_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(204);
  });
});

describe("POST /competitors/:id/crawl", () => {
  it("fails honestly with 502 when Crawl4AI is unreachable", async () => {
    const app = buildApp();
    process.env.CRAWL4AI_BASE_URL = "http://crawl4ai.local";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 1, rows: [{ id: COMPETITOR_1, domain: "acme.example.com" }] }, // loadCompetitorOr404
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/${COMPETITOR_1}/crawl`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(502);
  });

  it("fails honestly with 502 when CRAWL4AI_BASE_URL is not configured", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ id: COMPETITOR_1, domain: "acme.example.com" }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/${COMPETITOR_1}/crawl`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(502);
  });

  it("crawls, stores a snapshot, and detects new_page/content_changed/page_removed against the prior snapshot", async () => {
    const app = buildApp();
    process.env.CRAWL4AI_BASE_URL = "http://crawl4ai.local";

    // Fixed candidate paths are /, /about, /pricing, /blog. Simulate:
    //  - "/" unchanged content (same html both times isn't tested here, we
    //    only crawl once per request) — first crawl, so from the
    //    perspective of this single request, the "previous snapshot" fixture
    //    below stands in for an earlier crawl's pages.
    //  - "/about" 404s (not found this crawl) -> combined with it being in
    //    the "previous" snapshot fixture, produces page_removed.
    //  - "/pricing" returns new content -> content_changed vs. the fixture's
    //    stored contentHash.
    //  - "/blog" 404s and was never in the previous snapshot -> no change.
    // fetchCompetitorPage always POSTs to `${baseUrl}/crawl` — the actual
    // target page URL being crawled is inside the request body
    // ({ urls: [url] }), not the fetch request's own URL, so the mock must
    // inspect `init.body` to tell pages apart.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const requestedUrl = JSON.parse(String(init?.body ?? "{}")).urls?.[0] as string | undefined;
        if (requestedUrl?.endsWith("/about")) return fakeResponse({ ok: false, status: 404 });
        if (requestedUrl?.endsWith("/blog")) return fakeResponse({ ok: false, status: 404 });
        if (requestedUrl?.endsWith("/pricing")) {
          return fakeResponse({
            ok: true,
            status: 200,
            json: { results: [{ html: "<html><title>Pricing</title><body>brand new pricing copy</body></html>" }] },
          });
        }
        // "/"
        return fakeResponse({
          ok: true,
          status: 200,
          json: { results: [{ html: "<html><title>Home</title><body>welcome home page</body></html>" }] },
        });
      }),
    );

    const previousSnapshot = {
      id: "snap-prev",
      pages: [
        {
          // Matches exactly what stripHtml(..) produces for the "/" fixture
          // HTML below (title text is included in the stripped text), so
          // this page's contentHash is unchanged across the two crawls.
          url: "https://acme.example.com/",
          pageType: "home",
          title: "Home",
          extractedText: "Home welcome home page",
          contentHash: createHash("sha256").update("Home welcome home page").digest("hex"),
        },
        {
          url: "https://acme.example.com/about",
          pageType: "about",
          title: "About",
          extractedText: "about us text",
          contentHash: "old-about-hash",
        },
        {
          url: "https://acme.example.com/pricing",
          pageType: "pricing",
          title: "Pricing",
          extractedText: "old pricing copy",
          contentHash: "old-pricing-hash",
        },
      ],
    };

    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 1, rows: [{ id: COMPETITOR_1, domain: "acme.example.com" }] }, // loadCompetitorOr404
      { rowCount: 1, rows: [previousSnapshot] }, // previous snapshot lookup
      { rowCount: 1, rows: [{ id: "snap-new", competitor_id: COMPETITOR_1, pages: [] }] }, // INSERT snapshot
      { rowCount: 1, rows: [{ id: "chg-1", change_type: "content_changed", page_url: "https://acme.example.com/pricing" }] },
      { rowCount: 1, rows: [{ id: "chg-2", change_type: "page_removed", page_url: "https://acme.example.com/about" }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/${COMPETITOR_1}/crawl`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(201);
    expect(res.body.snapshot.id).toBe("snap-new");
    expect(res.body.changesDetected).toHaveLength(2);
    const types = res.body.changesDetected.map((c: { change_type: string }) => c.change_type).sort();
    expect(types).toEqual(["content_changed", "page_removed"]);
  });
});

describe("GET /competitors/:id/report", () => {
  it("returns an honest no-crawl-yet report when there is no snapshot", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 1, rows: [{ id: COMPETITOR_1, domain: "acme.example.com" }] }, // loadCompetitorOr404
      { rowCount: 0, rows: [] }, // no latest snapshot
      { rowCount: 0, rows: [] }, // no recent changes
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/${COMPETITOR_1}/report`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.positioningSummary).toMatch(/No crawl has been run yet/);
    expect(res.body.topKeywords).toEqual([]);
  });

  it("builds a templated positioning summary from real keyword + change counts", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ id: COMPETITOR_1, domain: "acme.example.com" }] },
      {
        rowCount: 1,
        rows: [
          {
            id: "snap-1",
            extracted_keywords: [
              { keyword: "growth", frequency: 5 },
              { keyword: "pipeline", frequency: 4 },
              { keyword: "pricing", frequency: 3 },
            ],
          },
        ],
      },
      { rowCount: 2, rows: [{ id: "chg-1" }, { id: "chg-2" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/${COMPETITOR_1}/report`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.positioningSummary).toMatch(/growth, pipeline, pricing/);
    expect(res.body.positioningSummary).toMatch(/2 change\(s\) detected in the last 30 days/);
  });

  it("extracts real pricing signals from the latest snapshot's crawled pages", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ id: COMPETITOR_1, domain: "acme.example.com" }] },
      {
        rowCount: 1,
        rows: [
          {
            id: "snap-1",
            extracted_keywords: [],
            pages: [
              {
                url: "https://acme.example.com/pricing",
                pageType: "pricing",
                extractedText: "Our Pro plan starts at $49/month per user. We ship fast.",
                contentHash: "h1",
              },
            ],
          },
        ],
      },
      { rowCount: 0, rows: [] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/${COMPETITOR_1}/report`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.pricingSignals).toHaveLength(1);
    expect(res.body.pricingSignals[0].sentence).toContain("$49/month");
    expect(res.body.positioningSummary).toMatch(/1 pricing\/plan sentence\(s\) found/);
  });
});

// ---------------------------------------------------------------------------
// Business intelligence: auto-discovery + keyword opportunities (Phase 4b)
// ---------------------------------------------------------------------------

describe("POST /competitors/discover", () => {
  it("reports an honest not-configured result when no growth analysis exists yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      { rowCount: 0, rows: [] }, // no growth_analyses row
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/discover`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
    expect(res.body.message).toMatch(/no growth analysis has been run/i);
  });

  it("reports configured: false (never fabricated candidates) when SERPAPI_API_KEY is unset", async () => {
    delete process.env.SERPAPI_API_KEY;
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      {
        rowCount: 1,
        rows: [{ domain: "acme.example.com", products_services: ["invoicing"], extracted_keywords: [] }],
      }, // latest growth_analyses
      { rowCount: 0, rows: [] }, // existing competitor domains
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/discover`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.candidates).toEqual([]);
    expect(res.body.message).toMatch(/requires a configured search provider/i);
  });
});

describe("GET /competitors/keyword-opportunities", () => {
  it("returns real competitor keywords absent from the project's own extracted keywords", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      {
        rowCount: 1,
        rows: [{ extracted_keywords: [{ keyword: "invoicing", frequency: 10 }] }],
      }, // latest growth_analyses
      {
        rowCount: 1,
        rows: [
          {
            competitor_name: "Acme",
            extracted_keywords: [
              { keyword: "invoicing", frequency: 8 },
              { keyword: "payroll", frequency: 6 },
            ],
          },
        ],
      }, // competitor keyword sets
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/keyword-opportunities`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.hasOwnSiteData).toBe(true);
    expect(res.body.hasCompetitorData).toBe(true);
    expect(res.body.opportunities).toEqual([
      expect.objectContaining({ keyword: "payroll", competitorCount: 1, combinedFrequency: 6 }),
    ]);
  });

  it("honestly reports no own-site data when no growth analysis has been run", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] },
      { rowCount: 0, rows: [] }, // no growth_analyses row
      { rowCount: 0, rows: [] }, // no tracked competitors
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/competitors/keyword-opportunities`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.hasOwnSiteData).toBe(false);
    expect(res.body.hasCompetitorData).toBe(false);
    expect(res.body.opportunities).toEqual([]);
  });
});
