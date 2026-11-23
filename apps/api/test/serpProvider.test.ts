import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SerpApiRankingProvider,
  SerpApiError,
  getRankingProvider,
} from "../src/lib/serpProvider.js";
import { NotConfiguredError, NotConfiguredRankingProvider } from "../src/lib/keywordRankingStub.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("SerpApiRankingProvider", () => {
  it("returns the position of the first organic_results entry matching the domain", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        search_metadata: { status: "Success" },
        organic_results: [
          { position: 1, link: "https://competitor.com/" },
          { position: 2, link: "https://www.example.com/pricing" },
        ],
      }),
    );
    const provider = new SerpApiRankingProvider("test-key", { fetcher });
    const result = await provider.checkRanking("widgets", "example.com");
    expect(result).toEqual({ position: 2, source: "serpapi", checkedAt: expect.any(String) });

    const calledUrl = new URL(fetcher.mock.calls[0][0] as string);
    expect(calledUrl.origin + calledUrl.pathname).toBe("https://serpapi.com/search.json");
    expect(calledUrl.searchParams.get("q")).toBe("widgets");
    expect(calledUrl.searchParams.get("api_key")).toBe("test-key");
  });

  it("returns position: null (never guessed) when the domain isn't in the results", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ organic_results: [{ position: 1, link: "https://other.com/" }] }),
    );
    const provider = new SerpApiRankingProvider("test-key", { fetcher });
    const result = await provider.checkRanking("widgets", "example.com");
    expect(result.position).toBeNull();
    expect(result.source).toBe("serpapi");
  });

  it("throws SerpApiError on a non-2xx response", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: "Invalid API key" }, 401));
    const provider = new SerpApiRankingProvider("bad-key", { fetcher });
    await expect(provider.checkRanking("widgets", "example.com")).rejects.toThrow(SerpApiError);
  });

  it("throws SerpApiError when search_metadata.status is 'Error' even on HTTP 200", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ search_metadata: { status: "Error" }, error: "something broke" }));
    const provider = new SerpApiRankingProvider("test-key", { fetcher });
    await expect(provider.checkRanking("widgets", "example.com")).rejects.toThrow(SerpApiError);
  });
});

describe("getRankingProvider", () => {
  const ORIGINAL = process.env.SERPAPI_API_KEY;
  beforeEach(() => {
    delete process.env.SERPAPI_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SERPAPI_API_KEY;
    else process.env.SERPAPI_API_KEY = ORIGINAL;
  });

  it("returns the NotConfigured stub when SERPAPI_API_KEY is not set (this environment's real state)", () => {
    expect(getRankingProvider()).toBeInstanceOf(NotConfiguredRankingProvider);
  });

  it("NotConfiguredRankingProvider always throws, never fabricates a position", async () => {
    const provider = getRankingProvider();
    await expect(provider.checkRanking("widgets", "example.com")).rejects.toThrow(NotConfiguredError);
  });

  it("returns a real SerpApiRankingProvider once SERPAPI_API_KEY is set", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    vi.resetModules();
    const fresh = await import("../src/lib/serpProvider.js");
    expect(fresh.getRankingProvider()).toBeInstanceOf(fresh.SerpApiRankingProvider);
    vi.resetModules();
  });
});
