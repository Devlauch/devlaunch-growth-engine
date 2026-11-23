import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocking convention as apps/worker/test/competitorIntelligence.test.ts:
// neutralize the real SSRF guard's DNS resolution, and stub out the real
// HttpCrawl4AIBackend's network call so these are pure, network-free unit
// tests of the deterministic parsing heuristics (kept in sync with
// apps/api/test/structuredExtraction.test.ts's equivalent fixtures).
vi.mock("../src/lib/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ssrfGuard.js")>();
  return { ...actual, assertSafeUrl: vi.fn(async () => {}) };
});

const fetchPageMock = vi.fn();
vi.mock("../src/agents/websiteCrawler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/websiteCrawler.js")>();
  return {
    ...actual,
    HttpCrawl4AIBackend: vi.fn().mockImplementation(() => ({ fetchPage: fetchPageMock })),
  };
});

const { extractPricingPage, extractCaseStudies, hashExtractedData } = await import("../src/lib/structuredExtraction.js");

beforeEach(() => {
  fetchPageMock.mockReset();
  process.env.CRAWL4AI_BASE_URL = "http://crawl4ai.internal:11235";
});

function htmlPage(body: string) {
  return { url: "https://example.com/pricing", statusCode: 200, html: `<html><body>${body}</body></html>` };
}

describe("worker structuredExtraction.extractPricingPage", () => {
  it("extracts plans deterministically, matching the apps/api equivalent", async () => {
    fetchPageMock.mockResolvedValue(htmlPage("<h2>Starter</h2><p>$29/mo</p><p>5 seats  •  Email support</p>"));
    const result = await extractPricingPage("https://example.com/pricing");
    expect(result.ok).toBe(true);
    expect(result.data.plans[0].priceText).toBe("$29/mo");
    expect(result.data.plans[0].amount).toBe(29);
  });

  it("honestly reports when CRAWL4AI_BASE_URL is not configured", async () => {
    delete process.env.CRAWL4AI_BASE_URL;
    const result = await extractPricingPage("https://example.com/pricing");
    expect(result.ok).toBe(false);
    expect(result.fetchError).toMatch(/CRAWL4AI_BASE_URL is not configured/);
    expect(fetchPageMock).not.toHaveBeenCalled();
  });
});

describe("worker structuredExtraction.extractCaseStudies", () => {
  it("extracts a verbatim quoted testimonial with attribution", async () => {
    fetchPageMock.mockResolvedValue(htmlPage('<p>"We cut churn in half." - Sam Lee, Example Inc</p>'));
    const result = await extractCaseStudies("https://example.com/customers");
    expect(result.ok).toBe(true);
    expect(result.data.caseStudies[0].text).toBe("We cut churn in half.");
    expect(result.data.caseStudies[0].attribution).toMatch(/Sam Lee/);
  });
});

describe("worker structuredExtraction.hashExtractedData", () => {
  it("matches the apps/api copy's stability guarantee across key order", () => {
    expect(hashExtractedData({ a: 1, b: 2 })).toBe(hashExtractedData({ b: 2, a: 1 }));
  });
});
