import { z } from "zod";
import type { AgentDefinition } from "@devlaunch/agent-sdk";
import type { CrawlBackend, CrawledPage } from "./websiteCrawler.js";
import { crawlOrganizationSite } from "./websiteCrawler.js";

export const competitorIntelligenceInputSchema = z.object({
  competitorDomain: z.string().min(1).max(500),
  backend: z.enum(["http", "none"]).optional(),
});
export type CompetitorIntelligenceInput = z.infer<typeof competitorIntelligenceInputSchema>;

const crawledPageSchema = z.object({
  url: z.string(),
  pageType: z.enum(["contact", "about", "departments", "placement", "news", "other"]),
  title: z.string().optional(),
  extractedText: z.string(),
  extractedEmails: z.array(z.string()),
  extractedPhones: z.array(z.string()),
  fetchedAt: z.string(),
});

const extractedKeywordSchema = z.object({
  keyword: z.string(),
  frequency: z.number().int().positive(),
});

export const competitorIntelligenceOutputSchema = z.object({
  competitorDomain: z.string(),
  pages: z.array(crawledPageSchema),
  extractedKeywords: z.array(extractedKeywordSchema),
  crawledAt: z.string(),
});
export type CompetitorIntelligenceOutput = z.infer<typeof competitorIntelligenceOutputSchema>;

/**
 * AgentDefinition for `competitor-intelligence` v1.
 *
 * Phase 2 item 1 ("Competitor Intelligence Agent"). Reuses the REAL,
 * already-built `crawlOrganizationSite` (see ./websiteCrawler.ts) exactly
 * as-is — no re-implementation of crawling, robots.txt handling, or
 * rate-limiting here — pointed at a competitor's domain instead of a known
 * lead's organization domain. The only new logic this agent adds is a
 * simple, honest, term-frequency keyword extraction over the combined
 * crawled page text.
 *
 * Honesty contract: `extractedKeywords` is basic TF (term-frequency, lower-
 * cased, stopword-filtered word counts) over the organization's own public
 * pages. It is NOT a paid SEO/SERP tool — it carries no search-ranking
 * position, no search volume, no backlink data, and no competitor-ranking
 * comparison. Callers must not present it as one.
 */
export const competitorIntelligenceDefinition: AgentDefinition = {
  id: "competitor-intelligence",
  version: "1",
  name: "Competitor Intelligence",
  description:
    "Crawls a competitor's public website (reusing the same crawlOrganizationSite capability used for lead research) and " +
    "extracts a basic term-frequency keyword list from its pages. Not a paid SEO/SERP tool — no ranking or search-volume data.",
  inputSchema: competitorIntelligenceInputSchema,
  outputSchema: competitorIntelligenceOutputSchema,
  requiredPermissions: ["agent:competitor-intelligence:run"],
  tools: [],
};

// Small, hardcoded English stopword list — enough to keep common function
// words out of a basic term-frequency count without pretending to be a
// linguistically complete stopword corpus.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "so", "of", "to", "in", "on", "at", "for",
  "with", "without", "by", "from", "up", "down", "out", "about", "into", "over", "after", "is", "are",
  "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "as", "we", "you",
  "your", "our", "us", "they", "their", "he", "she", "his", "her", "them", "i", "my", "me", "do", "does",
  "did", "can", "could", "will", "would", "should", "may", "might", "must", "not", "no", "yes", "all",
  "any", "each", "more", "most", "other", "some", "such", "only", "own", "same", "than", "too", "very",
  "just", "also", "here", "there", "when", "where", "who", "whom", "which", "what", "how", "why", "has",
  "have", "had", "having", "shall", "get", "gets", "got", "one", "two", "new", "us", "us.", "inc", "llc",
]);

const WORD_RE = /[a-z][a-z0-9'-]*/g;

/**
 * Pure, testable term-frequency keyword extraction: lowercases, strips
 * stopwords and very short tokens, counts frequency, and returns the top N
 * terms sorted by frequency desc then alphabetically for a stable tiebreak.
 * This is intentionally simple — real but basic TF counting, not a paid
 * SEO/SERP keyword tool.
 */
export function extractKeywords(text: string, topN = 30): Array<{ keyword: string; frequency: number }> {
  const counts = new Map<string, number>();
  const matches = text.toLowerCase().match(WORD_RE) ?? [];
  for (const word of matches) {
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([keyword, frequency]) => ({ keyword, frequency }));
}

/**
 * Test-only hooks to swap in fakes instead of real network calls — mirrors
 * how `crawlOrganizationSite`'s own `opts.backend`/`opts.fetchImpl` are used
 * in websiteCrawler's own test suite. Not used in production call sites
 * (those always get a real HttpCrawl4AIBackend + real fetch for robots.txt).
 */
export interface CompetitorIntelligenceTestOverrides {
  backend?: CrawlBackend;
  fetchImpl?: typeof fetch;
  paths?: string[];
  requestsPerSecond?: number;
}

/**
 * @param rawInput parsed against competitorIntelligenceInputSchema.
 * @param testOverrides test-only crawl backend / fetch overrides.
 */
export async function runCompetitorIntelligence(
  rawInput: unknown,
  testOverrides?: CompetitorIntelligenceTestOverrides,
): Promise<CompetitorIntelligenceOutput> {
  const input = competitorIntelligenceInputSchema.parse(rawInput);

  let pages: CrawledPage[] = [];
  if (input.backend === "none") {
    // Explicit dry-run mode: honest "we did not crawl anything" result —
    // never fabricated pages/keywords standing in for a real crawl.
    pages = [];
  } else {
    const baseUrl = process.env.CRAWL4AI_BASE_URL;
    if (!testOverrides?.backend && !baseUrl) {
      throw new Error(
        "competitor-intelligence requires CRAWL4AI_BASE_URL to be configured (no backend override supplied " +
          "and backend !== 'none'). Refusing to fabricate a crawl result.",
      );
    }
    // Constructed the same way Crawl4AIResearchAdapter (./researchAdapter.ts)
    // builds its own backend: HttpCrawl4AIBackend reads CRAWL4AI_API_TOKEN
    // itself when no explicit token is passed; crawlOrganizationSite
    // constructs the real HttpCrawl4AIBackend internally from baseUrl when
    // no backend override is given.
    const crawlResult = await crawlOrganizationSite(baseUrl ?? "", input.competitorDomain, {
      backend: testOverrides?.backend,
      fetchImpl: testOverrides?.fetchImpl,
      paths: testOverrides?.paths,
      requestsPerSecond: testOverrides?.requestsPerSecond,
    });
    pages = crawlResult.pages;
  }

  const combinedText = pages.map((p) => p.extractedText).join(" ");
  const extractedKeywords = extractKeywords(combinedText, 30);

  const output: CompetitorIntelligenceOutput = {
    competitorDomain: input.competitorDomain,
    pages,
    extractedKeywords,
    crawledAt: new Date().toISOString(),
  };

  // Defensive: validate our own output before returning, so a bug here
  // fails loudly instead of persisting schema-invalid data.
  return competitorIntelligenceOutputSchema.parse(output);
}
