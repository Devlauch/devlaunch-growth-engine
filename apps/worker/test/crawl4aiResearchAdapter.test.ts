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

  // Verified against a real running unclecode/crawl4ai:0.9.6 container
  // (see docs/CRAWL4AI_VERIFICATION.md): a successful /crawl response's
  // real shape is richer than the two fields this class reads — `markdown`
  // in particular is a structured object, not a string — but `html` and
  // `metadata.title` are read exactly as the mocked shape above models them.
  it("parses the full real crawl4ai 0.9.6 response shape (markdown as an object, extra fields ignored)", async () => {
    const backend = new HttpCrawl4AIBackend(
      "http://crawl4ai.invalid",
      (async () =>
        new Response(
          JSON.stringify({
            success: true,
            results: [
              {
                url: "https://example.com",
                html: "<!DOCTYPE html><html><head><title>Example Domain</title></head><body><h1>Example Domain</h1></body></html>",
                success: true,
                cleaned_html: "<html><head><title>Example Domain</title></head><body></body></html>",
                markdown: { raw_markdown: "# Example Domain", markdown_with_citations: "# Example Domain" },
                metadata: { title: "Example Domain", description: null, keywords: null, author: null },
                status_code: 200,
                error_message: null,
              },
            ],
            server_processing_time_s: 0.4,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    );
    const result = await backend.fetchPage("https://example.com");
    expect(result.statusCode).toBe(200);
    expect(result.html).toContain("Example Domain");
    expect(result.title).toBe("Example Domain");
  });

  it("sends an Authorization: Bearer header when constructed with an apiToken", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const backend = new HttpCrawl4AIBackend(
      "http://crawl4ai.invalid",
      (async (_url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ results: [{ html: "<p>ok</p>" }] }), { status: 200 });
      }) as unknown as typeof fetch,
      "my-secret-token",
    );
    await backend.fetchPage("http://acme.test/about");
    expect(capturedHeaders?.Authorization).toBe("Bearer my-secret-token");
  });

  // Verified against a live instance: /crawl returns 401
  // {"detail":"Authentication required"} without a valid bearer token —
  // this is a service misconfiguration, not a single page 404, so it must
  // surface as CrawlServiceUnreachableError (abort), never a silent
  // per-page skip.
  it("throws CrawlServiceUnreachableError on a 401 (missing/invalid CRAWL4AI_API_TOKEN)", async () => {
    const backend = new HttpCrawl4AIBackend(
      "http://crawl4ai.invalid",
      (async () =>
        new Response(JSON.stringify({ detail: "Authentication required" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );
    await expect(backend.fetchPage("http://acme.test/about")).rejects.toBeInstanceOf(CrawlServiceUnreachableError);
  });
});
