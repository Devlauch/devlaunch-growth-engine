/**
 * Internal linking recommendations (Phase 5 item "internal linking
 * recommendations" gap).
 *
 * Honesty contract: every suggestion here is computed from REAL crawled
 * page content and REAL `<a href>` link presence — never fabricated or
 * inferred from an LLM. The method is:
 *
 *   1. Discover a tenant's own pages the same way ../lib/siteAudit.ts does
 *      (sitemap.xml, falling back to the homepage), and fetch each page
 *      with the same SSRF-hardened `safeFetch` (../lib/ssrfGuard.ts).
 *   2. For each page, extract its real outbound same-domain links (regex
 *      over `<a href="...">`, same "good enough, no HTML parser" style as
 *      siteAudit.ts/htmlText.ts) and its real text content.
 *   3. Run each page's text through ../lib/keywordExtraction.ts (the same
 *      TF extraction used across growthAnalyzer.ts/competitorIntelligence.ts)
 *      and ../lib/keywordClustering.ts's deterministic clustering.
 *   4. For any two distinct pages that both have a top keyword in the same
 *      cluster, and where page A does NOT already link to page B, emit a
 *      suggestion: "A should link to B because they share cluster X" —
 *      with the real shared keywords attached as evidence.
 *
 * This is a concrete, checkable recommendation (you can open page A's HTML
 * and verify the link is genuinely absent) — not a generic "improve your
 * internal linking" tip.
 */

import { safeFetch, assertSafeUrl, SsrfBlockedError, type SafeFetchInit, type SafeFetchResponse } from "./ssrfGuard.js";
import { fetchSitemap, checkRobotsTxt, type FetchLike } from "./siteAudit.js";
import { extractKeywords, type ExtractedKeyword } from "./keywordExtraction.js";
import { clusterKeywords, type KeywordCluster } from "./keywordClustering.js";
import { stripHtml } from "./htmlText.js";

const MAX_PAGES = 15;
const MAX_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 5000;
const TOP_KEYWORDS_PER_PAGE = 12;
const MAX_SUGGESTIONS = 50;

export interface CrawledLinkPage {
  url: string;
  outboundLinks: Set<string>;
  topKeywords: ExtractedKeyword[];
}

export interface InternalLinkSuggestion {
  fromUrl: string;
  toUrl: string;
  clusterKey: string;
  clusterLabel: string;
  sharedKeywords: string[];
  reason: string;
}

function toRootUrl(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const HREF_RE = /<a\b[^>]*\shref\s*=\s*["']([^"'#?]+)(?:[?#][^"']*)?["'][^>]*>/gi;

/**
 * Extracts real same-origin outbound links from a page's HTML, normalized
 * to absolute URLs with trailing slashes stripped (so "/about" and
 * "/about/" compare equal). Cross-domain links (external sites) are
 * dropped — internal linking recommendations only make sense within one
 * site.
 */
export function extractInternalLinks(html: string, pageUrl: string): Set<string> {
  const base = new URL(pageUrl);
  const links = new Set<string>();
  for (const match of html.matchAll(HREF_RE)) {
    const href = match[1]?.trim();
    if (!href) continue;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      const resolved = new URL(href, base);
      if (resolved.hostname !== base.hostname) continue; // external link, not internal
      resolved.hash = "";
      resolved.search = "";
      const normalized = resolved.toString().replace(/\/+$/, "");
      links.add(normalized);
    } catch {
      // Malformed href — skip rather than guess.
    }
  }
  return links;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

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

export interface CrawlPagesForLinkingOptions {
  fetchImpl?: FetchLike;
}

/**
 * Discovers and fetches a tenant's own pages (sitemap.xml, falling back to
 * the homepage — same convention as siteAudit.ts/growthAnalyzer.ts), and
 * extracts each page's real outbound internal links plus its top TF
 * keywords. Never throws on an individual page failure — an unreachable
 * page is simply skipped, same "honest partial result" convention as the
 * rest of this codebase's crawl-based features.
 */
export async function crawlPagesForLinking(
  domain: string,
  options: CrawlPagesForLinkingOptions = {},
): Promise<CrawledLinkPage[]> {
  const fetchImpl = options.fetchImpl ?? safeFetch;
  const root = toRootUrl(domain);

  try {
    await assertSafeUrl(root);
  } catch (err) {
    if (err instanceof SsrfBlockedError) return [];
    throw err;
  }

  const sitemap = await fetchSitemap(domain, fetchImpl);
  const urls = (sitemap.urls.length > 0 ? sitemap.urls : [root]).slice(0, MAX_PAGES);

  const pages = await mapWithConcurrency(urls, MAX_CONCURRENCY, async (url): Promise<CrawledLinkPage | null> => {
    try {
      const res = (await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      } as SafeFetchInit)) as SafeFetchResponse | Response;
      if (!res.ok) return null;
      const html = await res.text();
      if (!html) return null;
      const text = stripHtml(html);
      const outboundLinks = extractInternalLinks(html, url);
      const topKeywords = extractKeywords(text, TOP_KEYWORDS_PER_PAGE);
      return { url: normalizeUrl(url), outboundLinks, topKeywords };
    } catch {
      return null;
    }
  });

  return pages.filter((p): p is CrawledLinkPage => p !== null);
}

/**
 * Pure function: given already-crawled pages (url + outbound links + top
 * keywords per page), clusters each page's keywords together (across all
 * pages) via ../lib/keywordClustering.ts, then for every cluster shared by
 * 2+ distinct pages, suggests any missing A->B link where A doesn't
 * already link to B. Capped at MAX_SUGGESTIONS, sorted by shared-keyword
 * count desc so the strongest topical overlaps surface first.
 */
export function computeInternalLinkSuggestions(pages: CrawledLinkPage[]): InternalLinkSuggestion[] {
  if (pages.length < 2) return [];

  // Cluster across ALL pages' top keywords combined, so e.g. "pricing" on
  // page A and "pricing plans" on page B land in the same cluster.
  const allKeywordFrequency = new Map<string, number>();
  for (const page of pages) {
    for (const kw of page.topKeywords) {
      allKeywordFrequency.set(kw.keyword, (allKeywordFrequency.get(kw.keyword) ?? 0) + kw.frequency);
    }
  }
  const combinedKeywords: ExtractedKeyword[] = Array.from(allKeywordFrequency.entries()).map(
    ([keyword, frequency]) => ({ keyword, frequency }),
  );
  const clusters = clusterKeywords(combinedKeywords);
  const keywordToCluster = new Map<string, KeywordCluster>();
  for (const cluster of clusters) {
    for (const kw of cluster.keywords) keywordToCluster.set(kw.keyword, cluster);
  }

  // Which pages have a top keyword in each cluster.
  const clusterToPages = new Map<string, Set<number>>();
  const pageKeywordsByCluster = new Map<string, Map<number, Set<string>>>();
  pages.forEach((page, pageIndex) => {
    for (const kw of page.topKeywords) {
      const cluster = keywordToCluster.get(kw.keyword);
      if (!cluster) continue;
      const pageSet = clusterToPages.get(cluster.clusterKey) ?? new Set<number>();
      pageSet.add(pageIndex);
      clusterToPages.set(cluster.clusterKey, pageSet);

      const perPage = pageKeywordsByCluster.get(cluster.clusterKey) ?? new Map<number, Set<string>>();
      const kwSet = perPage.get(pageIndex) ?? new Set<string>();
      kwSet.add(kw.keyword);
      perPage.set(pageIndex, kwSet);
      pageKeywordsByCluster.set(cluster.clusterKey, perPage);
    }
  });

  const suggestions: InternalLinkSuggestion[] = [];
  for (const cluster of clusters) {
    const pageIndices = Array.from(clusterToPages.get(cluster.clusterKey) ?? []);
    if (pageIndices.length < 2) continue;

    for (const fromIndex of pageIndices) {
      for (const toIndex of pageIndices) {
        if (fromIndex === toIndex) continue;
        const fromPage = pages[fromIndex];
        const toPage = pages[toIndex];
        if (fromPage.url === toPage.url) continue;
        if (fromPage.outboundLinks.has(toPage.url)) continue; // already linked — nothing to suggest

        const sharedKeywords = Array.from(
          new Set([
            ...(pageKeywordsByCluster.get(cluster.clusterKey)?.get(fromIndex) ?? []),
            ...(pageKeywordsByCluster.get(cluster.clusterKey)?.get(toIndex) ?? []),
          ]),
        ).sort();

        suggestions.push({
          fromUrl: fromPage.url,
          toUrl: toPage.url,
          clusterKey: cluster.clusterKey,
          clusterLabel: cluster.label,
          sharedKeywords,
          reason: `${fromPage.url} and ${toPage.url} both rank "${cluster.label}"-related terms (${sharedKeywords.join(", ")}) among their top keywords, but ${fromPage.url} does not currently link to ${toPage.url}.`,
        });
      }
    }
  }

  return suggestions
    .sort((a, b) => b.sharedKeywords.length - a.sharedKeywords.length || a.fromUrl.localeCompare(b.fromUrl))
    .slice(0, MAX_SUGGESTIONS);
}

export interface AnalyzeInternalLinkingResult {
  domain: string;
  pagesCrawled: number;
  suggestions: InternalLinkSuggestion[];
}

/**
 * Orchestrates crawl -> cluster -> suggest for one domain. Never throws for
 * a crawl failure — an unreachable domain simply yields 0 pages crawled
 * and 0 suggestions (never a fabricated suggestion).
 */
export async function analyzeInternalLinking(
  domain: string,
  options: CrawlPagesForLinkingOptions = {},
): Promise<AnalyzeInternalLinkingResult> {
  const pages = await crawlPagesForLinking(domain, options);
  const suggestions = computeInternalLinkSuggestions(pages);
  return { domain, pagesCrawled: pages.length, suggestions };
}

// Re-exported so routes can honestly report robots.txt presence alongside
// suggestions without a second, separate fetch.
export { checkRobotsTxt };
