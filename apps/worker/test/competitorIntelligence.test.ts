import { describe, it, expect } from "vitest";
import {
  runCompetitorIntelligence,
  competitorIntelligenceOutputSchema,
  extractKeywords,
} from "../src/agents/competitorIntelligence.js";
import type { CrawlBackend, CrawlFetchResult } from "../src/agents/websiteCrawler.js";

class FakeBackend implements CrawlBackend {
  constructor(private readonly pages: Record<string, string>) {}
  async fetchPage(url: string): Promise<CrawlFetchResult> {
    const path = new URL(url).pathname;
    const html = this.pages[path];
    if (html === undefined) {
      return { url, statusCode: 404, html: "" };
    }
    return { url, statusCode: 200, html };
  }
}

describe("extractKeywords", () => {
  it("lowercases, strips stopwords, and counts term frequency", () => {
    const text = "Pricing Pricing growth growth growth platform and the a plan";
    const result = extractKeywords(text, 10);
    expect(result[0]).toEqual({ keyword: "growth", frequency: 3 });
    expect(result.find((k) => k.keyword === "pricing")).toEqual({ keyword: "pricing", frequency: 2 });
    // Stopwords never appear.
    expect(result.find((k) => k.keyword === "and")).toBeUndefined();
    expect(result.find((k) => k.keyword === "the")).toBeUndefined();
    expect(result.find((k) => k.keyword === "a")).toBeUndefined();
  });

  it("drops very short tokens and caps at topN", () => {
    const text = Array.from({ length: 40 }, (_, i) => `keyword${i}`).join(" ") + " ab cd";
    const result = extractKeywords(text, 5);
    expect(result.length).toBe(5);
    expect(result.find((k) => k.keyword === "ab")).toBeUndefined();
  });

  it("returns an empty array for empty text", () => {
    expect(extractKeywords("")).toEqual([]);
  });
});

describe("competitor-intelligence agent", () => {
  it("returns an honest empty result in dry-run ('none' backend) mode without crawling", async () => {
    const output = await runCompetitorIntelligence({ competitorDomain: "example.com", backend: "none" });
    expect(competitorIntelligenceOutputSchema.safeParse(output).success).toBe(true);
    expect(output.pages).toEqual([]);
    expect(output.extractedKeywords).toEqual([]);
    expect(output.competitorDomain).toBe("example.com");
  });

  it("crawls via an injected backend and extracts keywords from combined page text", async () => {
    const backend = new FakeBackend({
      "/": "<html><title>Acme Growth Platform</title><body><h1>Acme</h1><p>Acme growth platform for marketing growth teams.</p></body></html>",
      "/about": "<html><title>About Acme</title><body><p>Acme helps marketing teams grow pipeline fast.</p></body></html>",
    });

    // Fake fetch for the robots.txt pre-flight request (crawlOrganizationSite
    // fetches it over the real `fetch` by default) — 404 means "proceed as
    // allow-all", same as a real site with no robots.txt.
    const fetchImpl = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    const output = await runCompetitorIntelligence(
      { competitorDomain: "acme.example.com", backend: "http" },
      { backend, fetchImpl, paths: ["/", "/about"], requestsPerSecond: 1000 },
    );

    const parsed = competitorIntelligenceOutputSchema.safeParse(output);
    expect(parsed.success).toBe(true);
    expect(output.pages.length).toBeGreaterThan(0);
    expect(output.extractedKeywords.length).toBeGreaterThan(0);
    expect(output.extractedKeywords.some((k) => k.keyword === "growth")).toBe(true);
    expect(typeof output.crawledAt).toBe("string");
  });

  it("throws rather than fabricating a crawl when no backend/CRAWL4AI_BASE_URL is available", async () => {
    const original = process.env.CRAWL4AI_BASE_URL;
    delete process.env.CRAWL4AI_BASE_URL;
    try {
      await expect(
        runCompetitorIntelligence({ competitorDomain: "example.com", backend: "http" }),
      ).rejects.toThrow(/CRAWL4AI_BASE_URL/);
    } finally {
      if (original !== undefined) process.env.CRAWL4AI_BASE_URL = original;
    }
  });

  it("rejects invalid input", async () => {
    await expect(runCompetitorIntelligence({ competitorDomain: "" })).rejects.toThrow();
  });
});
