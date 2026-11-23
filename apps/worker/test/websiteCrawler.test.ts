import { describe, it, expect, vi } from "vitest";

// SSRF guard (../src/lib/ssrfGuard.js) does real DNS resolution + a pinned
// http/https connection by design (see
// docs/SECURITY_HARDENING_MILESTONE_1.md) — neutralize it here so these
// tests keep using their injected fake fetch/backend against fictitious
// ".test" domains instead of hitting a real network. Real DNS/rebinding/
// private-IP behavior is covered for real in apps/api/test/ssrfGuard.test.ts
// (this worker copy is intentionally identical logic).
vi.mock("../src/lib/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ssrfGuard.js")>();
  return {
    ...actual,
    assertSafeUrl: vi.fn(async () => {}),
  };
});

import {
  classifyPageType,
  extractEmails,
  extractPhones,
  stripHtml,
  extractTitle,
  extractHeadingText,
  crawlOrganizationSite,
  CrawlServiceUnreachableError,
  type CrawlBackend,
  type CrawlFetchResult,
} from "../src/agents/websiteCrawler.js";

describe("classifyPageType", () => {
  it("classifies by URL path keywords", () => {
    expect(classifyPageType("https://example.com/contact-us", "")).toBe("contact");
    expect(classifyPageType("https://example.com/about-us", "")).toBe("about");
    expect(classifyPageType("https://example.com/departments", "")).toBe("departments");
    expect(classifyPageType("https://example.com/training-and-placement", "")).toBe("placement");
    expect(classifyPageType("https://example.com/news", "")).toBe("news");
    expect(classifyPageType("https://example.com/random-page", "")).toBe("other");
  });

  it("falls back to heading/title text when the path is uninformative", () => {
    expect(classifyPageType("https://example.com/p/1", "Contact Our Team")).toBe("contact");
    expect(classifyPageType("https://example.com/p/2", "Latest Press Announcements")).toBe("news");
  });
});

describe("extractEmails", () => {
  it("extracts and dedupes emails, lowercased", () => {
    const text = "Reach us at Info@Example.com or sales@example.com. Also info@example.com again.";
    expect(extractEmails(text)).toEqual(["info@example.com", "sales@example.com"]);
  });

  it("returns an empty array when there are no emails", () => {
    expect(extractEmails("no contact info here")).toEqual([]);
  });
});

describe("extractPhones", () => {
  it("extracts plausible phone numbers", () => {
    const text = "Call us at +1 415-555-0132 or (022) 2345 6789.";
    const phones = extractPhones(text);
    expect(phones.length).toBeGreaterThan(0);
  });

  it("ignores short numeric noise", () => {
    expect(extractPhones("Room 42, floor 3")).toEqual([]);
  });
});

describe("stripHtml / extractTitle / extractHeadingText", () => {
  const html = `<html><head><title>Acme Contact</title></head><body><script>var x=1;</script><h1>Contact Acme Corp</h1><p>Email us at hello@acme.test</p></body></html>`;

  it("strips tags and scripts into plain text", () => {
    const text = stripHtml(html);
    expect(text).not.toContain("<");
    expect(text).toContain("Contact Acme Corp");
    expect(text).not.toContain("var x=1");
  });

  it("extracts the <title>", () => {
    expect(extractTitle(html)).toBe("Acme Contact");
  });

  it("extracts h1/h2 heading text", () => {
    expect(extractHeadingText(html)).toContain("Contact Acme Corp");
  });
});

describe("crawlOrganizationSite", () => {
  it("skips paths disallowed by robots.txt without fetching them", async () => {
    const fetchedUrls: string[] = [];
    const backend: CrawlBackend = {
      async fetchPage(url: string): Promise<CrawlFetchResult> {
        fetchedUrls.push(url);
        return { url, statusCode: 200, html: "<h1>About Acme</h1>", title: "About" };
      },
    };
    const fakeFetch = (async (url: string | URL) => {
      if (String(url).endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /contact\n", { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await crawlOrganizationSite("http://crawl4ai.invalid", "acme.test", {
      paths: ["/contact", "/about"],
      backend,
      fetchImpl: fakeFetch,
      requestsPerSecond: 1000,
    });

    expect(fetchedUrls.some((u) => u.includes("/contact"))).toBe(false);
    expect(result.pages.some((p) => p.url.includes("/about"))).toBe(true);
    expect(result.skipped.some((s) => s.url.includes("/contact") && s.reason.includes("robots.txt"))).toBe(true);
  });

  it("extracts emails/phones and classifies page type for fetched pages", async () => {
    const backend: CrawlBackend = {
      async fetchPage(url: string): Promise<CrawlFetchResult> {
        return {
          url,
          statusCode: 200,
          html: "<h1>Contact Us</h1><p>Email: contact@acme.test Phone: +1 415-555-0100</p>",
          title: "Contact",
        };
      },
    };
    const fakeFetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    const result = await crawlOrganizationSite("http://crawl4ai.invalid", "acme.test", {
      paths: ["/contact"],
      backend,
      fetchImpl: fakeFetch,
      requestsPerSecond: 1000,
    });

    expect(result.pages).toHaveLength(1);
    const [page] = result.pages;
    expect(page.pageType).toBe("contact");
    expect(page.extractedEmails).toContain("contact@acme.test");
    expect(page.extractedPhones.length).toBeGreaterThan(0);
  });

  it("surfaces a clear error instead of returning fake data when the crawl backend is unreachable", async () => {
    const backend: CrawlBackend = {
      async fetchPage(): Promise<CrawlFetchResult> {
        throw new CrawlServiceUnreachableError("http://crawl4ai.invalid", new Error("fetch failed"));
      },
    };
    const fakeFetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    await expect(
      crawlOrganizationSite("http://crawl4ai.invalid", "acme.test", {
        paths: ["/contact"],
        backend,
        fetchImpl: fakeFetch,
        requestsPerSecond: 1000,
      }),
    ).rejects.toThrow(/unreachable/i);
  });
});
