import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TavilySearchProvider,
  SerperSearchProvider,
  NotConfiguredWebSearchProvider,
  WebSearchApiError,
  WebSearchTimeoutError,
  WebSearchNetworkError,
  WebSearchNotConfiguredError,
  type WebSearchFetcher,
} from "../src/lib/webSearchProvider.js";

/**
 * All tests here exercise real request/response handling LOGIC (headers,
 * body shape, result mapping, error classification) against a fake,
 * injected `fetcher` — there is no real Tavily/Serper API key in this
 * environment, so no test ever talks to the real api.tavily.com /
 * google.serper.dev. Same convention as test/llmProvider.test.ts.
 */

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("NotConfiguredWebSearchProvider", () => {
  it("reports isConfigured: false and always throws WebSearchNotConfiguredError rather than fabricating results", async () => {
    const provider = new NotConfiguredWebSearchProvider();
    expect(provider.isConfigured).toBe(false);
    await expect(provider.search("test query")).rejects.toBeInstanceOf(WebSearchNotConfiguredError);
  });
});

describe("TavilySearchProvider", () => {
  it("sends the documented request shape: Authorization Bearer header, query/max_results/search_depth body", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        results: [
          { title: "Result One", url: "https://example.com/1", content: "snippet one", score: 0.9, published_date: "2026-01-01" },
        ],
        answer: "a synthesized answer",
      }),
    );
    const provider = new TavilySearchProvider("tvly-test-key", { fetcher });

    const results = await provider.search("growth marketing trends", { maxResults: 3 });

    expect(results).toEqual([
      { title: "Result One", url: "https://example.com/1", snippet: "snippet one", publishedDate: "2026-01-01" },
    ]);
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.headers.authorization).toBe("Bearer tvly-test-key");
    const body = JSON.parse(init.body);
    expect(body.query).toBe("growth marketing trends");
    expect(body.max_results).toBe(3);
    expect(body.search_depth).toBe("basic");
  });

  it("never fabricates a published date: maps a missing published_date to null", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { results: [{ title: "T", url: "https://example.com", content: "c", score: 0.5 }] }),
    );
    const provider = new TavilySearchProvider("key", { fetcher });
    const results = await provider.search("x");
    expect(results[0].publishedDate).toBeNull();
  });

  it("returns an empty array when results is somehow missing from a successful response", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const provider = new TavilySearchProvider("key", { fetcher });
    const results = await provider.search("x");
    expect(results).toEqual([]);
  });

  it("classifies a 401 (bad key) as a non-retryable WebSearchApiError", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockResolvedValue(jsonResponse(401, { message: "invalid api key" }));
    const provider = new TavilySearchProvider("bad-key", { fetcher });

    const err = await provider.search("x").catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchApiError);
    expect((err as WebSearchApiError).status).toBe(401);
    expect((err as WebSearchApiError).retryable).toBe(false);
  });

  it("classifies a 429 (rate limit) as a retryable WebSearchApiError", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    const provider = new TavilySearchProvider("key", { fetcher });

    const err = await provider.search("x").catch((e) => e);
    expect((err as WebSearchApiError).retryable).toBe(true);
  });

  it("classifies a 5xx as a retryable WebSearchApiError", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockResolvedValue(jsonResponse(503, {}));
    const provider = new TavilySearchProvider("key", { fetcher });

    const err = await provider.search("x").catch((e) => e);
    expect((err as WebSearchApiError).retryable).toBe(true);
  });

  it("converts an aborted (timed-out) request into WebSearchTimeoutError", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const provider = new TavilySearchProvider("key", { fetcher, timeoutMs: 10 });

    await expect(provider.search("x")).rejects.toBeInstanceOf(WebSearchTimeoutError);
  });

  it("converts any other fetch rejection into WebSearchNetworkError", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const provider = new TavilySearchProvider("key", { fetcher });

    await expect(provider.search("x")).rejects.toBeInstanceOf(WebSearchNetworkError);
  });
});

describe("SerperSearchProvider", () => {
  it("sends the documented request shape: X-API-KEY header, q/num body, hits google.serper.dev", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        organic: [{ title: "Serp Result", link: "https://example.com/serp", snippet: "a snippet", date: "Mar 10, 2026", position: 1 }],
      }),
    );
    const provider = new SerperSearchProvider("serper-test-key", { fetcher });

    const results = await provider.search("competitor pricing page", { maxResults: 5 });

    expect(results).toEqual([
      { title: "Serp Result", url: "https://example.com/serp", snippet: "a snippet", publishedDate: "Mar 10, 2026" },
    ]);
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://google.serper.dev/search");
    expect(init.headers["X-API-KEY"]).toBe("serper-test-key");
    const body = JSON.parse(init.body);
    expect(body.q).toBe("competitor pricing page");
    expect(body.num).toBe(5);
  });

  it("never fabricates a published date: maps a missing date to null", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { organic: [{ title: "T", link: "https://example.com", snippet: "s", position: 1 }] }),
    );
    const provider = new SerperSearchProvider("key", { fetcher });
    const results = await provider.search("x");
    expect(results[0].publishedDate).toBeNull();
  });

  it("returns an empty array when organic is somehow missing from a successful response", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const provider = new SerperSearchProvider("key", { fetcher });
    const results = await provider.search("x");
    expect(results).toEqual([]);
  });

  it("classifies a 401 as non-retryable and a 429 as retryable, same as Tavily", async () => {
    const unauthorized: WebSearchFetcher = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    const unauthorizedErr = await new SerperSearchProvider("bad", { fetcher: unauthorized }).search("x").catch((e) => e);
    expect((unauthorizedErr as WebSearchApiError).retryable).toBe(false);

    const rateLimited: WebSearchFetcher = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    const rateLimitedErr = await new SerperSearchProvider("key", { fetcher: rateLimited }).search("x").catch((e) => e);
    expect((rateLimitedErr as WebSearchApiError).retryable).toBe(true);
  });

  it("converts an aborted (timed-out) request into WebSearchTimeoutError", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const provider = new SerperSearchProvider("key", { fetcher, timeoutMs: 10 });

    await expect(provider.search("x")).rejects.toBeInstanceOf(WebSearchTimeoutError);
  });

  it("converts any other fetch rejection into WebSearchNetworkError", async () => {
    const fetcher: WebSearchFetcher = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const provider = new SerperSearchProvider("key", { fetcher });

    await expect(provider.search("x")).rejects.toBeInstanceOf(WebSearchNetworkError);
  });
});

describe("getWebSearchProvider resolver", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const noneConfigured = {
    tavilyApiKey: null,
    serperApiKey: null,
    webSearchProviderOverride: null,
  };

  it("returns NotConfiguredWebSearchProvider when no key is set at all", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: noneConfigured }));
    const { getWebSearchProvider } = await import("../src/lib/webSearchProvider.js");
    const provider = getWebSearchProvider();
    expect(provider.isConfigured).toBe(false);
    expect(provider.name).toBe("not_configured");
  });

  it("returns a real TavilySearchProvider when only TAVILY_API_KEY is set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { ...noneConfigured, tavilyApiKey: "a-real-key" } }));
    const { getWebSearchProvider } = await import("../src/lib/webSearchProvider.js");
    const provider = getWebSearchProvider();
    expect(provider.isConfigured).toBe(true);
    expect(provider.name).toBe("tavily");
  });

  it("returns a real SerperSearchProvider when only SERPER_API_KEY is set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { ...noneConfigured, serperApiKey: "a-serper-key" } }));
    const { getWebSearchProvider } = await import("../src/lib/webSearchProvider.js");
    const provider = getWebSearchProvider();
    expect(provider.isConfigured).toBe(true);
    expect(provider.name).toBe("serper");
  });

  it("prefers tavily > serper when both keys are set and no explicit WEB_SEARCH_PROVIDER override is given", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { ...noneConfigured, tavilyApiKey: "a", serperApiKey: "b" },
    }));
    const { getWebSearchProvider } = await import("../src/lib/webSearchProvider.js");
    expect(getWebSearchProvider().name).toBe("tavily");
  });

  it("honors an explicit WEB_SEARCH_PROVIDER override even when a higher-priority key is also set", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { ...noneConfigured, tavilyApiKey: "a", serperApiKey: "b", webSearchProviderOverride: "serper" },
    }));
    const { getWebSearchProvider } = await import("../src/lib/webSearchProvider.js");
    expect(getWebSearchProvider().name).toBe("serper");
  });

  it("throws rather than silently falling back when WEB_SEARCH_PROVIDER names a provider whose key isn't set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { ...noneConfigured, webSearchProviderOverride: "tavily" } }));
    const { getWebSearchProvider, WebSearchNotConfiguredError: Thrown } = await import("../src/lib/webSearchProvider.js");
    expect(() => getWebSearchProvider()).toThrow(Thrown);
  });
});
