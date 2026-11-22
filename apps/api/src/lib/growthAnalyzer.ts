/**
 * AI Website Growth Analyzer (DevLaunch Growth Engine, feature 1): crawl a
 * client's whole website, extract products/services, value propositions and
 * target-audience signals, and produce a recommended ICP + a deterministic,
 * templated growth plan.
 *
 * Reuses, rather than reinvents:
 *  - ../lib/crawl4aiClient.ts for the actual page fetch (same client already
 *    verified against a live `unclecode/crawl4ai:0.9.6` container and used by
 *    routes/competitors.ts).
 *  - ../lib/siteAudit.ts for sitemap/robots discovery and real technical-SEO
 *    issues (broken links, missing metadata) — used both to discover which
 *    pages to crawl and as the basis for "conversion opportunity" notes.
 *  - ../lib/keywordExtraction.ts for keyword frequency (same TF algorithm as
 *    competitorIntelligence.ts).
 *  - ../lib/htmlText.ts for stripHtml/extractTitle.
 *
 * Honesty contract: every "extraction" and "recommendation" below is
 * DETERMINISTIC regex/dictionary/frequency heuristics over the crawled
 * page text — NOT natural-language understanding, and NOT an LLM call (no
 * LLM API is invoked anywhere in this file). Industries/geographies/segments
 * are suggested from small, fixed keyword dictionaries, not inferred
 * "intelligently" — a human should always review the suggestion before
 * accepting it into icp_profiles. If the site can't be crawled at all, this
 * returns an honest failed/partial result (status + crawlError) — it never
 * fabricates page content, keywords, or recommendations to paper over a
 * crawl failure.
 */

import {
  Crawl4AINotConfiguredError,
  Crawl4AIUnreachableError,
  fetchCompetitorPage,
} from "./crawl4aiClient.js";
import { fetchSitemap, checkRobotsTxt, runSiteAudit, type SiteAuditIssue } from "./siteAudit.js";
import { extractKeywords, type ExtractedKeyword } from "./keywordExtraction.js";
import { stripHtml, extractTitle } from "./htmlText.js";

const MAX_PAGES_TO_CRAWL = 15;
const MAX_CONCURRENCY = 5;

export interface CrawledGrowthPage {
  url: string;
  title?: string;
  extractedText: string;
}

export interface GrowthPlanIcpSuggestion {
  industries: string[];
  geographies: string[];
  segments: string[];
  rationale: string;
}

export interface GrowthAnalysisResult {
  domain: string;
  status: "completed" | "partial" | "failed";
  pagesDiscovered: number;
  pagesCrawled: number;
  crawlError: string | null;
  sitemapFound: boolean;
  robotsFound: boolean;
  extractedKeywords: ExtractedKeyword[];
  productsServices: string[];
  valuePropositions: string[];
  targetAudienceSignals: string[];
  recommendedIcp: GrowthPlanIcpSuggestion;
  conversionOpportunities: SiteAuditIssue[];
  growthPlanSummary: string;
}

function toRootUrl(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Runs an array of async tasks with a bounded concurrency (same small helper as siteAudit.ts's own, duplicated to avoid exporting an internal from that module). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Discovers which pages to crawl: the site's own sitemap.xml when present
 * (capped at MAX_PAGES_TO_CRAWL), falling back to just the root page —
 * same honest "no sitemap -> just crawl the homepage" fallback as
 * siteAudit.ts's runSiteAudit.
 */
export async function discoverPages(
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ urls: string[]; sitemapFound: boolean; robotsFound: boolean }> {
  const root = toRootUrl(domain);
  const [sitemap, robotsFound] = await Promise.all([
    fetchSitemap(domain, fetchImpl),
    checkRobotsTxt(domain, fetchImpl),
  ]);
  const urls = sitemap.urls.length > 0 ? sitemap.urls.slice(0, MAX_PAGES_TO_CRAWL) : [root];
  return { urls, sitemapFound: sitemap.found, robotsFound };
}

/**
 * Crawls the given URLs via the shared Crawl4AI HTTP client. Throws
 * Crawl4AINotConfiguredError/Crawl4AIUnreachableError when the service
 * itself can't be used at all (service-level failure); an individual page
 * 404ing or returning empty HTML is just skipped, same convention as
 * routes/competitors.ts's own crawl handler.
 */
export async function crawlPages(urls: string[]): Promise<CrawledGrowthPage[]> {
  const pages = await mapWithConcurrency(urls, MAX_CONCURRENCY, async (url) => {
    const fetched = await fetchCompetitorPage(url);
    if (fetched.statusCode >= 400 || !fetched.html) return null;
    const extractedText = stripHtml(fetched.html);
    if (!extractedText) return null;
    return { url, title: fetched.title ?? extractTitle(fetched.html), extractedText } satisfies CrawledGrowthPage;
  });
  return pages.filter((p): p is CrawledGrowthPage => p !== null);
}

// ---------------------------------------------------------------------------
// Deterministic text-analysis heuristics (NOT NLU, NOT an LLM — see file
// doc comment). Small, fixed, hardcoded trigger-phrase/keyword lists only.
// ---------------------------------------------------------------------------

const VALUE_PROP_TRIGGERS = [
  "we help", "helping you", "helps you", "we enable", "enables you", "empowers", "our mission",
  "we believe", "trusted by", "the leading", "#1", "best-in-class", "award-winning", "industry-leading",
  "all-in-one", "end-to-end", "built for", "designed for", "made for",
];

const AUDIENCE_PATTERN = /\b(?:for|designed for|built for|made for|trusted by)\s+([a-z][a-z0-9 ,'&-]{2,60}?)(?:[.!,;\n]|$)/gi;

const AUDIENCE_KEYWORDS = [
  "enterprise", "enterprises", "startup", "startups", "small business", "small businesses", "smb",
  "developer", "developers", "marketer", "marketers", "agency", "agencies", "founder", "founders",
  "freelancer", "freelancers", "nonprofit", "nonprofits", "healthcare", "retailer", "retailers",
];

/** Small, fixed dictionary mapping trigger keywords to a recommended industry label — deliberately not ML-derived. */
const INDUSTRY_KEYWORD_MAP: Array<{ industry: string; keywords: string[] }> = [
  { industry: "SaaS / Software", keywords: ["saas", "software", "platform", "api", "cloud", "dashboard"] },
  { industry: "E-commerce / Retail", keywords: ["ecommerce", "e-commerce", "shop", "store", "retail", "checkout", "cart"] },
  { industry: "Healthcare", keywords: ["healthcare", "patient", "patients", "clinic", "clinical", "medical"] },
  { industry: "Financial Services", keywords: ["finance", "financial", "banking", "payments", "fintech", "invoice", "invoicing"] },
  { industry: "Education", keywords: ["education", "learning", "course", "courses", "student", "students", "academy"] },
  { industry: "Marketing / Agency", keywords: ["marketing", "agency", "campaign", "campaigns", "advertising", "branding"] },
  { industry: "Manufacturing", keywords: ["manufacturing", "factory", "supply", "logistics", "warehouse"] },
  { industry: "Real Estate", keywords: ["real estate", "property", "properties", "realtor", "listing", "listings"] },
  { industry: "Professional Services", keywords: ["consulting", "consultancy", "advisory", "legal", "law firm"] },
];

/** Small, fixed list of common geography names to scan for — a heuristic signal, not a geolocation service. */
const GEOGRAPHY_KEYWORDS = [
  "united states", "usa", "canada", "united kingdom", "uk", "europe", "european union", "germany",
  "france", "india", "australia", "singapore", "global", "worldwide", "north america", "latin america",
  "middle east", "africa", "asia", "apac",
];

const SEGMENT_KEYWORDS: Array<{ segment: string; keywords: string[] }> = [
  { segment: "Enterprise", keywords: ["enterprise", "enterprises"] },
  { segment: "Small & Medium Business", keywords: ["small business", "small businesses", "smb", "small teams"] },
  { segment: "Startups", keywords: ["startup", "startups", "founder", "founders"] },
  { segment: "Agencies", keywords: ["agency", "agencies"] },
  { segment: "Developers", keywords: ["developer", "developers", "api"] },
];

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 300);
}

/**
 * Deterministic "products/services" extraction: the top N-gram-free TF
 * keywords (3-20 chars, already stopword-filtered by extractKeywords) are
 * treated as candidate product/service terms. This is a frequency heuristic
 * over the site's own words, not entity recognition — it will include noise
 * for small/sparse sites, by design (no fabricated terms are injected to
 * "fill out" a thin result).
 */
export function extractProductsServices(keywords: ExtractedKeyword[], limit = 15): string[] {
  return keywords.slice(0, limit).map((k) => k.keyword);
}

/**
 * Deterministic value-proposition extraction: sentences from the crawled
 * text that contain one of a small, fixed set of trigger phrases commonly
 * used in marketing copy (VALUE_PROP_TRIGGERS). Returns the matching
 * sentences verbatim (deduped, capped) — never a paraphrase or summary.
 */
export function extractValuePropositions(pages: CrawledGrowthPage[], limit = 8): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const page of pages) {
    for (const sentence of sentencesOf(page.extractedText)) {
      const lower = sentence.toLowerCase();
      if (VALUE_PROP_TRIGGERS.some((trigger) => lower.includes(trigger))) {
        const key = lower.slice(0, 120);
        if (!seen.has(key)) {
          seen.add(key);
          results.push(sentence);
          if (results.length >= limit) return results;
        }
      }
    }
  }
  return results;
}

/**
 * Deterministic target-audience-signal extraction: regex matches of
 * "for/built for/designed for/trusted by <phrase>" plus any hit against a
 * small fixed AUDIENCE_KEYWORDS list. Returns short phrases, deduped.
 */
export function extractTargetAudienceSignals(combinedText: string, limit = 10): string[] {
  const results = new Set<string>();
  const lower = combinedText.toLowerCase();

  for (const match of lower.matchAll(AUDIENCE_PATTERN)) {
    const phrase = match[1]?.trim();
    if (phrase && phrase.length >= 3 && phrase.length <= 60) {
      results.add(phrase);
      if (results.size >= limit) return Array.from(results);
    }
  }
  for (const keyword of AUDIENCE_KEYWORDS) {
    if (lower.includes(keyword)) {
      results.add(keyword);
      if (results.size >= limit) break;
    }
  }
  return Array.from(results).slice(0, limit);
}

/**
 * Deterministic ICP suggestion: matches the combined crawled text (plus
 * already-extracted keywords) against small, fixed dictionaries for
 * industry, geography, and segment. This is a suggestion only — never
 * written directly into icp_profiles; see routes/growthAnalyzer.ts's
 * accept-icp endpoint for the human-in-the-loop acceptance step.
 */
export function recommendIcp(
  combinedText: string,
  keywords: ExtractedKeyword[],
  audienceSignals: string[],
): GrowthPlanIcpSuggestion {
  const lower = combinedText.toLowerCase();
  const keywordSet = new Set(keywords.map((k) => k.keyword));

  const industries = INDUSTRY_KEYWORD_MAP.filter((entry) =>
    entry.keywords.some((kw) => lower.includes(kw) || keywordSet.has(kw)),
  ).map((entry) => entry.industry);

  const geographies = GEOGRAPHY_KEYWORDS.filter((kw) => lower.includes(kw)).map((kw) =>
    kw.replace(/\b\w/g, (c) => c.toUpperCase()),
  );

  const segments = SEGMENT_KEYWORDS.filter((entry) =>
    entry.keywords.some((kw) => lower.includes(kw) || audienceSignals.includes(kw)),
  ).map((entry) => entry.segment);

  const rationaleParts: string[] = [];
  rationaleParts.push(
    industries.length > 0
      ? `Industry signal from site copy: ${industries.join(", ")}.`
      : "No clear industry keyword matched this site's own copy — treat industries as a guess.",
  );
  rationaleParts.push(
    geographies.length > 0
      ? `Geography mentions found: ${geographies.join(", ")}.`
      : "No specific geography mentioned — defaulting to no geographic restriction.",
  );
  rationaleParts.push(
    segments.length > 0
      ? `Audience-size/segment language found: ${segments.join(", ")}.`
      : "No specific company-size/segment language found.",
  );

  return {
    industries,
    geographies: geographies.length > 0 ? geographies : ["Global (no specific geography detected)"],
    segments,
    rationale: rationaleParts.join(" "),
  };
}

/**
 * Deterministic, templated growth-plan summary text — built directly from
 * the real counts/fields computed above (and, when supplied, real content
 * gaps vs. the project's own tracked competitors — see
 * ../lib/growthAnalyzer.ts's computeContentGaps and
 * routes/growthAnalyzer.ts). Never an LLM-written narrative.
 */
export function buildGrowthPlanSummary(opts: {
  domain: string;
  pagesCrawled: number;
  recommendedIcp: GrowthPlanIcpSuggestion;
  productsServices: string[];
  valuePropositions: string[];
  contentGapsCount: number;
  conversionOpportunities: SiteAuditIssue[];
}): string {
  const { domain, pagesCrawled, recommendedIcp, productsServices, valuePropositions, contentGapsCount, conversionOpportunities } =
    opts;
  const parts: string[] = [];
  parts.push(`Growth plan for ${domain}, based on ${pagesCrawled} crawled page(s).`);
  parts.push(
    `Recommended ICP — industries: ${recommendedIcp.industries.join(", ") || "none detected"}; ` +
      `geographies: ${recommendedIcp.geographies.join(", ")}; segments: ${recommendedIcp.segments.join(", ") || "none detected"}.`,
  );
  parts.push(
    productsServices.length > 0
      ? `Top recurring product/service terms: ${productsServices.slice(0, 8).join(", ")}.`
      : "No recurring product/service terms were extracted (thin or unreachable site content).",
  );
  parts.push(
    valuePropositions.length > 0
      ? `${valuePropositions.length} value-proposition sentence(s) found on the site.`
      : "No explicit value-proposition language was detected.",
  );
  parts.push(
    contentGapsCount > 0
      ? `${contentGapsCount} content gap(s) found relative to tracked competitors' recurring terms — see contentGaps for detail.`
      : "No tracked competitors with crawled content to diff against yet (or no gaps found).",
  );
  const highSeverity = conversionOpportunities.filter((i) => i.severity === "high").length;
  parts.push(
    conversionOpportunities.length > 0
      ? `${conversionOpportunities.length} technical conversion-opportunity issue(s) found (${highSeverity} high severity) — see conversionOpportunities for detail.`
      : "No technical conversion-blocking issues were found by the site audit.",
  );
  return parts.join(" ");
}

/**
 * Pure diff: which of a competitor's recurring keywords are NOT among this
 * site's own top keywords — i.e. a real, data-backed content gap, not a
 * guess. `competitorKeywordSets` is `{ competitorName, keywords }[]`, each
 * competitor's latest competitor_snapshots.extracted_keywords (see
 * routes/competitors.ts) — reused rather than re-crawling competitors here.
 */
export function computeContentGaps(
  ownKeywords: ExtractedKeyword[],
  competitorKeywordSets: Array<{ competitorName: string; keywords: ExtractedKeyword[] }>,
  limitPerCompetitor = 10,
): Array<{ competitorName: string; gapKeywords: string[] }> {
  const ownSet = new Set(ownKeywords.map((k) => k.keyword));
  return competitorKeywordSets
    .map(({ competitorName, keywords }) => ({
      competitorName,
      gapKeywords: keywords
        .filter((k) => !ownSet.has(k.keyword))
        .slice(0, limitPerCompetitor)
        .map((k) => k.keyword),
    }))
    .filter((entry) => entry.gapKeywords.length > 0);
}

/**
 * Orchestrates the full crawl -> extract -> recommend pipeline for one
 * domain. Never throws for a crawl failure — returns status: 'failed' (or
 * 'partial' when at least one page was crawled but the crawl stopped early)
 * with an honest crawlError instead, so the caller can persist an honest
 * partial/failed analysis row rather than fabricating one.
 */
export async function runGrowthAnalysis(
  domain: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<GrowthAnalysisResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { urls, sitemapFound, robotsFound } = await discoverPages(domain, fetchImpl);

  let pages: CrawledGrowthPage[] = [];
  let crawlError: string | null = null;
  let status: GrowthAnalysisResult["status"] = "completed";

  try {
    pages = await crawlPages(urls);
    if (pages.length === 0) {
      status = "partial";
      crawlError = "No pages could be crawled (all candidate pages were unreachable, 404, or empty).";
    }
  } catch (err) {
    status = "failed";
    if (err instanceof Crawl4AINotConfiguredError || err instanceof Crawl4AIUnreachableError) {
      crawlError = err.message;
    } else {
      crawlError = err instanceof Error ? err.message : String(err);
    }
  }

  const combinedText = pages.map((p) => p.extractedText).join(" ");
  const extractedKeywords = status === "failed" ? [] : extractKeywords(combinedText, 40);
  const productsServices = status === "failed" ? [] : extractProductsServices(extractedKeywords);
  const valuePropositions = status === "failed" ? [] : extractValuePropositions(pages);
  const targetAudienceSignals = status === "failed" ? [] : extractTargetAudienceSignals(combinedText);
  const recommendedIcp =
    status === "failed"
      ? { industries: [], geographies: [], segments: [], rationale: "No pages were crawled — no ICP signal available." }
      : recommendIcp(combinedText, extractedKeywords, targetAudienceSignals);

  // Real technical-SEO audit (independent of Crawl4AI — plain fetch) used
  // as the "conversion opportunity" basis; honestly empty if the domain
  // itself can't be reached at all (runSiteAudit never throws).
  const siteAuditResult = await runSiteAudit(domain, { fetchImpl });
  const conversionOpportunities = siteAuditResult.issues;

  const growthPlanSummary = buildGrowthPlanSummary({
    domain,
    pagesCrawled: pages.length,
    recommendedIcp,
    productsServices,
    valuePropositions,
    contentGapsCount: 0,
    conversionOpportunities,
  });

  return {
    domain,
    status,
    pagesDiscovered: urls.length,
    pagesCrawled: pages.length,
    crawlError,
    sitemapFound,
    robotsFound,
    extractedKeywords,
    productsServices,
    valuePropositions,
    targetAudienceSignals,
    recommendedIcp,
    conversionOpportunities,
    growthPlanSummary,
  };
}
