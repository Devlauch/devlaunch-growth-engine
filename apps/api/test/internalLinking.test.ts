import { describe, it, expect, vi } from "vitest";

// Pure-function tests don't need the ssrfGuard mock; the crawl-level tests
// below inject a fake fetchImpl directly (same convention as
// siteAudit.test.ts), and stub assertSafeUrl so a fake test domain doesn't
// hit real DNS.
vi.mock("../src/lib/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ssrfGuard.js")>();
  return {
    ...actual,
    assertSafeUrl: vi.fn(async () => {}),
  };
});

const {
  extractInternalLinks,
  computeInternalLinkSuggestions,
  crawlPagesForLinking,
  analyzeInternalLinking,
} = await import("../src/lib/internalLinking.js");

describe("extractInternalLinks", () => {
  it("extracts same-domain links as absolute, normalized URLs", () => {
    const html = `
      <a href="/pricing">Pricing</a>
      <a href="/about/">About</a>
      <a href="https://example.com/contact">Contact</a>
      <a href="https://other-domain.com/page">External</a>
      <a href="mailto:hi@example.com">Email</a>
    `;
    const links = extractInternalLinks(html, "https://example.com/home");
    expect(links.has("https://example.com/pricing")).toBe(true);
    expect(links.has("https://example.com/about")).toBe(true); // trailing slash stripped
    expect(links.has("https://example.com/contact")).toBe(true);
    expect(Array.from(links).some((l) => l.includes("other-domain"))).toBe(false);
    expect(Array.from(links).some((l) => l.includes("mailto"))).toBe(false);
  });

  it("drops query strings and hash fragments when normalizing", () => {
    const html = `<a href="/blog?utm_source=x#section">Blog</a>`;
    const links = extractInternalLinks(html, "https://example.com/");
    expect(links.has("https://example.com/blog")).toBe(true);
  });

  it("ignores malformed hrefs instead of throwing", () => {
    const html = `<a href="not a url \u0000">bad</a>`;
    expect(() => extractInternalLinks(html, "https://example.com/")).not.toThrow();
  });
});

describe("computeInternalLinkSuggestions", () => {
  it("suggests a missing link between two pages sharing a keyword cluster", () => {
    const pages = [
      {
        url: "https://example.com/pricing",
        outboundLinks: new Set<string>(),
        topKeywords: [{ keyword: "invoicing", frequency: 5 }],
      },
      {
        url: "https://example.com/features",
        outboundLinks: new Set<string>(),
        topKeywords: [{ keyword: "invoices", frequency: 4 }],
      },
    ];
    const suggestions = computeInternalLinkSuggestions(pages);
    expect(suggestions.length).toBeGreaterThan(0);
    const pair = suggestions.find(
      (s) => s.fromUrl === "https://example.com/pricing" && s.toUrl === "https://example.com/features",
    );
    expect(pair).toBeDefined();
    expect(pair!.sharedKeywords.length).toBeGreaterThan(0);
  });

  it("does not suggest a link that already exists", () => {
    const pages = [
      {
        url: "https://example.com/pricing",
        outboundLinks: new Set<string>(["https://example.com/features"]),
        topKeywords: [{ keyword: "invoicing", frequency: 5 }],
      },
      {
        url: "https://example.com/features",
        outboundLinks: new Set<string>(),
        topKeywords: [{ keyword: "invoices", frequency: 4 }],
      },
    ];
    const suggestions = computeInternalLinkSuggestions(pages);
    expect(
      suggestions.some(
        (s) => s.fromUrl === "https://example.com/pricing" && s.toUrl === "https://example.com/features",
      ),
    ).toBe(false);
    // The reverse direction (features -> pricing) is still a real gap.
    expect(
      suggestions.some(
        (s) => s.fromUrl === "https://example.com/features" && s.toUrl === "https://example.com/pricing",
      ),
    ).toBe(true);
  });

  it("returns nothing for pages with no keyword overlap", () => {
    const pages = [
      { url: "https://example.com/a", outboundLinks: new Set<string>(), topKeywords: [{ keyword: "alpha", frequency: 1 }] },
      { url: "https://example.com/b", outboundLinks: new Set<string>(), topKeywords: [{ keyword: "zebra", frequency: 1 }] },
    ];
    expect(computeInternalLinkSuggestions(pages)).toEqual([]);
  });

  it("returns nothing for fewer than 2 pages", () => {
    expect(
      computeInternalLinkSuggestions([
        { url: "https://example.com/a", outboundLinks: new Set<string>(), topKeywords: [] },
      ]),
    ).toEqual([]);
  });
});

function fakeFetchImpl(pagesByUrl: Record<string, { html: string; ok?: boolean }>) {
  return vi.fn(async (url: string) => {
    const page = pagesByUrl[url];
    if (!page || page.ok === false) {
      return { ok: false, status: 404, text: async () => "" } as Response;
    }
    return { ok: true, status: 200, text: async () => page.html } as Response;
  });
}

describe("crawlPagesForLinking / analyzeInternalLinking (crawl-level)", () => {
  it("crawls the homepage when no sitemap is found and extracts links + keywords", async () => {
    const html = `<html><head><title>Home</title></head><body>
      <p>We offer real invoicing and invoices software for small business invoicing needs.</p>
      <a href="/features">Features</a>
    </body></html>`;
    const fetchImpl = fakeFetchImpl({
      "https://example.com/sitemap.xml": { html: "", ok: false },
      "https://example.com/robots.txt": { html: "", ok: false },
      "https://example.com": { html, ok: true },
    });

    const pages = await crawlPagesForLinking("example.com", { fetchImpl });
    expect(pages).toHaveLength(1);
    expect(pages[0].outboundLinks.has("https://example.com/features")).toBe(true);
    expect(pages[0].topKeywords.some((k) => k.keyword.startsWith("invoic"))).toBe(true);
  });

  it("never throws for an unreachable domain — returns 0 pages/suggestions", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network error");
    });
    const result = await analyzeInternalLinking("unreachable.example", { fetchImpl });
    expect(result.pagesCrawled).toBe(0);
    expect(result.suggestions).toEqual([]);
  });
});
