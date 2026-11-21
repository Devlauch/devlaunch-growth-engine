import { describe, it, expect } from "vitest";
import { Crawl4AIResearchAdapter } from "../src/agents/researchAdapter.js";
import { HttpCrawl4AIBackend, CrawlServiceUnreachableError } from "../src/agents/websiteCrawler.js";

describe("Crawl4AIResearchAdapter", () => {
  it("requires a baseUrl to construct", () => {
    // @ts-expect-error intentionally omitting required opts for the test
    expect(() => new Crawl4AIResearchAdapter({})).toThrow();
  });

  it("honestly refuses the generic research() method instead of fabricating industry text", async () => {
    const adapter = new Crawl4AIResearchAdapter({ baseUrl: "http://crawl4ai.invalid" });
    await expect(
      adapter.research({
        industry: "education",
        geography: "United States",
        segment: "career_switchers",
        question: "What channels convert best?",
      }),
    ).rejects.toThrow(/organization domain/i);
  });

  it("crawlOrganizationSite surfaces a clear error when the crawl4ai service is unreachable", async () => {
    const adapter = new Crawl4AIResearchAdapter({ baseUrl: "http://crawl4ai.invalid" });
    const fakeFetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND crawl4ai.invalid");
    }) as unknown as typeof fetch;

    await expect(
      adapter.crawlOrganizationSite("acme.test", {
        paths: ["/contact"],
        fetchImpl: fakeFetch,
        requestsPerSecond: 1000,
      }),
    ).rejects.toThrow(/unreachable/i);
  });
});

describe("HttpCrawl4AIBackend", () => {
  it("throws CrawlServiceUnreachableError when the underlying fetch rejects", async () => {
    const backend = new HttpCrawl4AIBackend(
      "http://crawl4ai.invalid",
      (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    await expect(backend.fetchPage("http://acme.test/contact")).rejects.toBeInstanceOf(CrawlServiceUnreachableError);
  });

  it("throws CrawlServiceUnreachableError on a 5xx response", async () => {
    const backend = new HttpCrawl4AIBackend(
      "http://crawl4ai.invalid",
      (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch,
    );
    await expect(backend.fetchPage("http://acme.test/contact")).rejects.toBeInstanceOf(CrawlServiceUnreachableError);
  });

  it("returns a per-page result (not a thrown error) for a 404", async () => {
    const backend = new HttpCrawl4AIBackend(
      "http://crawl4ai.invalid",
      (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
    );
    const result = await backend.fetchPage("http://acme.test/missing");
    expect(result.statusCode).toBe(404);
  });

  it("parses a successful crawl4ai-shaped response", async () => {
    const backend = new HttpCrawl4AIBackend(
      "http://crawl4ai.invalid",
      (async () =>
        new Response(
          JSON.stringify({
            results: [{ url: "http://acme.test/about", success: true, html: "<h1>About</h1>", metadata: { title: "About Acme" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    );
    const result = await backend.fetchPage("http://acme.test/about");
    expect(result.statusCode).toBe(200);
    expect(result.html).toContain("About");
    expect(result.title).toBe("About Acme");
  });
});
