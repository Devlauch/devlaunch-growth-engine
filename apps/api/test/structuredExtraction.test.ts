import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocking convention as competitors.test.ts: neutralize the real SSRF
// guard's DNS resolution (tested for real in test/ssrfGuard.test.ts) and
// stub crawl4aiClient's fetchCompetitorPage so these are pure, network-free
// unit tests of the deterministic parsing heuristics.
vi.mock("../src/lib/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ssrfGuard.js")>();
  return { ...actual, assertSafeUrl: vi.fn(async () => {}) };
});

const fetchCompetitorPageMock = vi.fn();
vi.mock("../src/lib/crawl4aiClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/crawl4aiClient.js")>();
  return { ...actual, fetchCompetitorPage: fetchCompetitorPageMock };
});

const { extractPricingPage, extractProductCatalog, extractCaseStudies, hashExtractedData } = await import(
  "../src/lib/structuredExtraction.js"
);

beforeEach(() => {
  fetchCompetitorPageMock.mockReset();
});

function htmlPage(body: string): { url: string; statusCode: number; html: string } {
  return { url: "https://example.com/pricing", statusCode: 200, html: `<html><body>${body}</body></html>` };
}

describe("extractPricingPage", () => {
  it("extracts real plan names, prices, and features from fixture HTML", async () => {
    fetchCompetitorPageMock.mockResolvedValue(
      htmlPage(
        "<h2>Starter</h2><p>$29/mo</p><p>5 seats  •  Email support  •  Basic reports</p>" +
          "<h2>Growth</h2><p>$99/mo</p><p>Unlimited seats  •  Priority support  •  Advanced reports</p>",
      ),
    );

    const result = await extractPricingPage("https://example.com/pricing");
    expect(result.ok).toBe(true);
    expect(result.data.plans.length).toBe(2);
    expect(result.data.plans[0].priceText).toBe("$29/mo");
    expect(result.data.plans[0].amount).toBe(29);
    expect(result.data.plans[0].currency).toBe("$");
    expect(result.data.plans[0].interval).toBe("month");
    expect(result.data.plans[1].priceText).toBe("$99/mo");
    // Evidence always points at the real source URL + a fetchedAt timestamp.
    expect(result.evidence.length).toBe(2);
    expect(result.evidence[0].sourceUrl).toBe("https://example.com/pricing");
    expect(typeof result.evidence[0].fetchedAt).toBe("string");
  });

  it("honestly reports no plans found rather than fabricating one", async () => {
    fetchCompetitorPageMock.mockResolvedValue(htmlPage("<p>We love our customers but have no pricing listed.</p>"));
    const result = await extractPricingPage("https://example.com/pricing");
    expect(result.ok).toBe(false);
    expect(result.data.plans).toEqual([]);
    expect(result.fetchError).toMatch(/no recognizable price pattern/);
  });

  it("honestly reports a fetch failure without inventing data", async () => {
    fetchCompetitorPageMock.mockResolvedValue({ url: "https://example.com/pricing", statusCode: 404, html: "" });
    const result = await extractPricingPage("https://example.com/pricing");
    expect(result.ok).toBe(false);
    expect(result.data.plans).toEqual([]);
    expect(result.fetchError).toMatch(/No content returned/);
    expect(result.evidence).toEqual([]);
  });
});

describe("extractProductCatalog", () => {
  it("extracts catalog entries under a recognized section trigger", async () => {
    fetchCompetitorPageMock.mockResolvedValue(
      htmlPage(
        "<h2>Our Products</h2>" +
          "<h3>Analytics Suite</h3><p>Real-time dashboards for growth teams.</p>" +
          "<h3>Automation Engine</h3><p>Rules-based workflow automation.</p>",
      ),
    );
    const result = await extractProductCatalog("https://example.com/products");
    expect(result.ok).toBe(true);
    expect(result.data.products.length).toBeGreaterThan(0);
    expect(result.data.products.some((p) => p.name === "Analytics Suite")).toBe(true);
    expect(result.evidence.length).toBe(result.data.products.length);
  });

  it("honestly reports no catalog section found", async () => {
    fetchCompetitorPageMock.mockResolvedValue(htmlPage("<p>Just a generic page with no catalog section.</p>"));
    const result = await extractProductCatalog("https://example.com/about");
    expect(result.ok).toBe(false);
    expect(result.data.products).toEqual([]);
    expect(result.fetchError).toMatch(/no recognizable product\/service catalog/);
  });
});

describe("extractCaseStudies", () => {
  it("extracts quoted testimonials with attribution, verbatim", async () => {
    fetchCompetitorPageMock.mockResolvedValue(
      htmlPage(
        '<p>"This platform doubled our pipeline in 90 days." - Jane Doe, Acme Co</p>' +
          "<p>Read our new customer success story about scaling outreach.</p>",
      ),
    );
    const result = await extractCaseStudies("https://example.com/customers");
    expect(result.ok).toBe(true);
    expect(result.data.caseStudies.some((c) => c.text.includes("doubled our pipeline"))).toBe(true);
    const quote = result.data.caseStudies.find((c) => c.text.includes("doubled our pipeline"));
    expect(quote?.attribution).toMatch(/Jane Doe/);
    expect(result.data.caseStudies.some((c) => c.text.toLowerCase().includes("success story"))).toBe(true);
  });

  it("honestly reports no testimonials/case studies found", async () => {
    fetchCompetitorPageMock.mockResolvedValue(htmlPage("<p>Nothing quotable here at all.</p>"));
    const result = await extractCaseStudies("https://example.com/customers");
    expect(result.ok).toBe(false);
    expect(result.data.caseStudies).toEqual([]);
  });
});

describe("hashExtractedData", () => {
  it("is stable across key-insertion-order differences", () => {
    const a = { b: 2, a: 1, nested: { x: 1, y: 2 } };
    const b = { a: 1, nested: { y: 2, x: 1 }, b: 2 };
    expect(hashExtractedData(a)).toBe(hashExtractedData(b));
  });

  it("changes when a real value changes", () => {
    expect(hashExtractedData({ plans: [{ price: 29 }] })).not.toBe(hashExtractedData({ plans: [{ price: 39 }] }));
  });
});
