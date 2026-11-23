import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as discovery.test.ts/sendingSetup.test.ts: fake the
// pg pool so these are true unit tests with no real Postgres, and no real
// network calls either (siteAudit.ts/coreWebVitals.ts take an injectable
// fetchImpl for their own unit tests; route-level tests stub global fetch).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// SSRF guard (../src/lib/ssrfGuard.js) does real DNS resolution + a pinned
// http/https connection by design (see docs/SECURITY_HARDENING_MILESTONE_1.md)
// — neutralize it here so these tests keep intercepting outbound requests at
// the global-`fetch`/injected-fetchImpl layer, instead of hitting a real
// network. Real DNS/rebinding/private-IP behavior is covered for real in
// test/ssrfGuard.test.ts.
vi.mock("../src/lib/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ssrfGuard.js")>();
  return {
    ...actual,
    assertSafeUrl: vi.fn(async () => {}),
    safeFetch: vi.fn((url: string, init?: unknown) => (globalThis.fetch as typeof fetch)(url, init as RequestInit)),
  };
});

const { seoRouter } = await import("../src/routes/seo.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { fetchSitemap, checkRobotsTxt, checkLinkStatus, auditPageMetadata, runSiteAudit } = await import(
  "../src/lib/siteAudit.js"
);
const { checkCoreWebVitals } = await import("../src/lib/coreWebVitals.js");
const { NotConfiguredError, NotConfiguredRankingProvider, generateSeoRecommendations } = await import(
  "../src/lib/keywordRankingStub.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/seo", seoRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const AUDIT_1 = "77777777-7777-7777-7777-777777777777";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
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

function fakeResponse(opts: { ok: boolean; status: number; text?: string; json?: unknown }): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: "",
    text: async () => opts.text ?? "",
    json: async () => opts.json ?? {},
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// siteAudit.ts (broken links, metadata, sitemap/robots — fully real, no
// external accounts needed)
// ---------------------------------------------------------------------------

describe("siteAudit", () => {
  describe("fetchSitemap", () => {
    it("parses <loc> entries from a found sitemap.xml", async () => {
      const fetchImpl = vi.fn(async () =>
        fakeResponse({
          ok: true,
          status: 200,
          text: `<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about</loc></url></urlset>`,
        }),
      );
      const result = await fetchSitemap("example.com", fetchImpl as unknown as typeof fetch);
      expect(result.found).toBe(true);
      expect(result.urls).toEqual(["https://example.com/", "https://example.com/about"]);
    });

    it("reports not found when sitemap.xml 404s", async () => {
      const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 404 }));
      const result = await fetchSitemap("example.com", fetchImpl as unknown as typeof fetch);
      expect(result.found).toBe(false);
      expect(result.urls).toEqual([]);
    });

    it("reports not found (never throws) on a network error", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ENOTFOUND example.invalid");
      });
      const result = await fetchSitemap("example.invalid", fetchImpl as unknown as typeof fetch);
      expect(result.found).toBe(false);
    });

    it("caps the number of sitemap URLs at 50", async () => {
      const locs = Array.from({ length: 80 }, (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`).join("");
      const fetchImpl = vi.fn(async () => fakeResponse({ ok: true, status: 200, text: `<urlset>${locs}</urlset>` }));
      const result = await fetchSitemap("example.com", fetchImpl as unknown as typeof fetch);
      expect(result.urls).toHaveLength(50);
    });
  });

  describe("checkRobotsTxt", () => {
    it("returns true when robots.txt is found (200)", async () => {
      const fetchImpl = vi.fn(async () => fakeResponse({ ok: true, status: 200, text: "User-agent: *" }));
      expect(await checkRobotsTxt("example.com", fetchImpl as unknown as typeof fetch)).toBe(true);
    });

    it("returns false when robots.txt is missing", async () => {
      const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 404 }));
      expect(await checkRobotsTxt("example.com", fetchImpl as unknown as typeof fetch)).toBe(false);
    });
  });

  describe("checkLinkStatus", () => {
    it("detects a broken link via a non-2xx HEAD status", async () => {
      const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 404 }));
      const result = await checkLinkStatus("https://example.com/missing", fetchImpl as unknown as typeof fetch);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
    });

    it("falls back to GET when HEAD returns 405", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ ok: false, status: 405 }))
        .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200 }));
      const result = await checkLinkStatus("https://example.com/", fetchImpl as unknown as typeof fetch);
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("never throws on a network error — reports status 0", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("network down");
      });
      const result = await checkLinkStatus("https://unreachable.invalid/", fetchImpl as unknown as typeof fetch);
      expect(result).toEqual({ ok: false, status: 0 });
    });
  });

  describe("auditPageMetadata", () => {
    it("flags a missing title and missing meta description as high severity", () => {
      const issues = auditPageMetadata("<html><head></head><body>hi</body></html>", "https://example.com/");
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ issueType: "missing_title", severity: "high" }),
          expect.objectContaining({ issueType: "missing_meta_description", severity: "high" }),
        ]),
      );
    });

    it("flags a too-long title and meta description as low severity", () => {
      const longTitle = "A".repeat(80);
      const longDesc = "B".repeat(200);
      const html = `<html><head><title>${longTitle}</title><meta name="description" content="${longDesc}"></head></html>`;
      const issues = auditPageMetadata(html, "https://example.com/");
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ issueType: "title_too_long", severity: "low" }),
          expect.objectContaining({ issueType: "meta_description_too_long", severity: "low" }),
        ]),
      );
    });

    it("reports no issues for well-formed, reasonably sized metadata", () => {
      const html = `<html><head><title>Example</title><meta name="description" content="A short description."></head></html>`;
      expect(auditPageMetadata(html, "https://example.com/")).toEqual([]);
    });
  });

  describe("runSiteAudit", () => {
    it("records a broken_link issue instead of throwing when a page can't be fetched", async () => {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/sitemap.xml")) return fakeResponse({ ok: false, status: 404 });
        if (url.endsWith("/robots.txt")) return fakeResponse({ ok: true, status: 200 });
        if (init?.method === "HEAD") return fakeResponse({ ok: false, status: 500 });
        return fakeResponse({ ok: false, status: 500 });
      });

      const result = await runSiteAudit("example.com", { fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(result.sitemapFound).toBe(false);
      expect(result.robotsFound).toBe(true);
      expect(result.issues.some((i) => i.issueType === "broken_link")).toBe(true);
      expect(result.issues.some((i) => i.issueType === "missing_sitemap")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// coreWebVitals.ts — real PageSpeed Insights integration, honest when
// unconfigured
// ---------------------------------------------------------------------------

describe("coreWebVitals", () => {
  it("returns not_configured (no fake numbers) when no API key is set", async () => {
    const result = await checkCoreWebVitals("https://example.com", null);
    expect(result).toEqual({ status: "not_configured" });
  });

  it("parses a real PageSpeed v5 response shape into LCP/CLS/performance score", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        ok: true,
        status: 200,
        json: {
          lighthouseResult: {
            audits: {
              "largest-contentful-paint": { displayValue: "2.1 s", numericValue: 2100 },
              "cumulative-layout-shift": { displayValue: "0.02", numericValue: 0.02 },
            },
            categories: { performance: { score: 0.87 } },
          },
        },
      }),
    );
    const result = await checkCoreWebVitals("https://example.com", "fake-key", fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe("ok");
    expect(result.data?.lcp).toBe("2.1 s");
    expect(result.data?.cls).toBe("0.02");
    expect(result.data?.performanceScore).toBe(0.87);
    expect(result.data?.inp).toBeUndefined(); // omitted, never invented
  });

  it("maps an HTTP error response to status: error rather than throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ ok: false, status: 400, json: { error: { message: "Invalid URL" } } }),
    );
    const result = await checkCoreWebVitals("https://example.com", "fake-key", fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe("error");
    expect(result.error).toContain("Invalid URL");
  });

  it("maps a network failure to status: error rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await checkCoreWebVitals("https://example.com", "fake-key", fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe("error");
    expect(result.error).toContain("ECONNRESET");
  });
});

// ---------------------------------------------------------------------------
// keywordRankingStub.ts — honest pluggable stub, never a fabricated ranking
// ---------------------------------------------------------------------------

describe("keywordRankingStub", () => {
  it("NotConfiguredRankingProvider always throws NotConfiguredError, never returns a position", async () => {
    const provider = new NotConfiguredRankingProvider();
    await expect(provider.checkRanking("growth marketing", "example.com")).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("generateSeoRecommendations produces rule-based advice from real counts", () => {
    const recs = generateSeoRecommendations(
      {
        sitemap_found: false,
        robots_found: true,
        pages_checked: 3,
        broken_links_count: 2,
        missing_meta_count: 1,
        core_web_vitals_status: "not_configured",
        core_web_vitals: null,
      },
      [],
    );
    expect(recs.some((r) => r.includes("sitemap.xml"))).toBe(true);
    expect(recs.some((r) => r.includes("2 broken link"))).toBe(true);
    expect(recs.some((r) => r.toLowerCase().includes("core web vitals"))).toBe(true);
  });

  it("reports a healthy audit as having no issues", () => {
    const recs = generateSeoRecommendations(
      {
        sitemap_found: true,
        robots_found: true,
        pages_checked: 3,
        broken_links_count: 0,
        missing_meta_count: 0,
        core_web_vitals_status: "ok",
        core_web_vitals: { performanceScore: 0.95 },
      },
      [],
    );
    expect(recs).toEqual(["No issues found in this audit — technical SEO fundamentals look healthy."]);
  });
});

// ---------------------------------------------------------------------------
// route validation (mocked pg pool + mocked global fetch)
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("denies GET /seo/audits when the caller has no active membership in the requested tenant", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo/audits`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });
});

describe("POST /seo/audits", () => {
  it("runs a real audit (mocked fetch) and persists the audit + issues, honestly not_configured for Core Web Vitals", async () => {
    const app = buildApp();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/sitemap.xml")) return fakeResponse({ ok: false, status: 404 });
        if (url.endsWith("/robots.txt")) return fakeResponse({ ok: true, status: 200, text: "User-agent: *" });
        if (init?.method === "HEAD") return fakeResponse({ ok: true, status: 200 });
        // GET of the root page itself
        return fakeResponse({ ok: true, status: 200, text: "<html><head></head><body>no metadata here</body></html>" });
      }),
    );

    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      {
        rowCount: 1,
        rows: [
          {
            id: AUDIT_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            domain: "example.com",
            sitemap_found: false,
            robots_found: true,
            pages_checked: 1,
            broken_links_count: 0,
            missing_meta_count: 2,
            core_web_vitals: null,
            core_web_vitals_status: "not_configured",
          },
        ],
      }, // INSERT seo_audits
      { rowCount: 1, rows: [{ id: "issue-1", issue_type: "missing_sitemap" }] },
      { rowCount: 1, rows: [{ id: "issue-2", issue_type: "missing_robots" }] }, // not reached if robots found, placeholder unused
      { rowCount: 1, rows: [{ id: "issue-3", issue_type: "missing_title" }] },
      { rowCount: 1, rows: [{ id: "issue-4", issue_type: "missing_meta_description" }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo/audits`)
      .set("X-Dev-User-Id", USER_1)
      .send({ domain: "example.com" });

    expect(res.status).toBe(201);
    expect(res.body.audit.domain).toBe("example.com");
    expect(res.body.audit.core_web_vitals_status).toBe("not_configured");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(Array.isArray(res.body.recommendations)).toBe(true);
    expect(res.body.recommendations.some((r: string) => r.toLowerCase().includes("core web vitals"))).toBe(true);
  });

  it("rejects an invalid domain string", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo/audits`)
      .set("X-Dev-User-Id", USER_1)
      .send({ domain: "not a domain" });

    expect(res.status).toBe(400);
  });
});

describe("POST /seo/keyword-rankings", () => {
  it("never fakes a position — honestly records the request as not_configured (202)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [] }, // assertProjectInTenant
      {
        rowCount: 1,
        rows: [
          {
            id: "rank-1",
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            keyword: "growth marketing agency",
            position: null,
            source: "not_configured",
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo/keyword-rankings`)
      .set("X-Dev-User-Id", USER_1)
      .send({ keyword: "growth marketing agency" });

    expect(res.status).toBe(202);
    expect(res.body.ranking.position).toBeNull();
    expect(res.body.ranking.source).toBe("not_configured");
    expect(res.body.note).toContain("not configured");
  });
});
