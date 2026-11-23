/**
 * Real, dependency-free technical SEO site audit (Phase 2 item 3,
 * "Technical SEO Agent"): broken links, metadata checks, and sitemap/
 * robots.txt checks. Every check here is a genuine network call (real
 * `fetch`) against the target domain — nothing fabricated.
 *
 * Style note: this mirrors apps/worker/src/agents/websiteCrawler.ts's
 * simple regex-based HTML handling (stripHtml/extractTitle) rather than
 * pulling in a new XML/HTML parsing dependency. apps/api has no runtime
 * dependency on apps/worker, so these are small, deliberately duplicated
 * equivalents (same precedent as scoreLead.ts mirroring leadScoring.ts)
 * rather than a cross-package import.
 *
 * SSRF guard: every fetch below targets a tenant-supplied `domain` directly
 * (no Crawl4AI process boundary in between), so `fetchImpl` defaults to
 * `safeFetch` (../lib/ssrfGuard.ts) rather than bare `fetch` — real DNS
 * A/AAAA validation against private/loopback/link-local/metadata ranges,
 * plus a pinned-IP connection and re-validated redirect-following to close
 * the DNS-rebinding TOCTOU gap. Still injectable (tests pass a fake
 * fetchImpl), same convention as before.
 */
import { safeFetch, type SafeFetchInit, type SafeFetchResponse } from "./ssrfGuard.js";

/** Structural supertype of both `safeFetch` and global `fetch` — lets
 * `fetchImpl` default to the SSRF-hardened `safeFetch` while tests keep
 * injecting a plain mock function (or real `fetch`) as before. */
export type FetchLike = (url: string, init?: SafeFetchInit) => Promise<SafeFetchResponse | Response>;

export type IssueType =
  | "broken_link"
  | "missing_title"
  | "missing_meta_description"
  | "title_too_long"
  | "meta_description_too_long"
  | "missing_sitemap"
  | "missing_robots";

export type Severity = "low" | "medium" | "high";

export interface SiteAuditIssue {
  issueType: IssueType;
  url: string;
  detail: string;
  severity: Severity;
}

export interface SitemapResult {
  found: boolean;
  urls: string[];
}

export interface LinkStatusResult {
  ok: boolean;
  status: number;
}

export interface RunSiteAuditResult {
  sitemapFound: boolean;
  robotsFound: boolean;
  pagesChecked: number;
  issues: SiteAuditIssue[];
}

const MAX_SITEMAP_URLS = 50;
const MAX_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 5000;
const TITLE_MAX_LENGTH = 60;
const META_DESCRIPTION_MAX_LENGTH = 160;

function toRootUrl(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Fetches and parses `https://{domain}/sitemap.xml`. Sitemap XML is a
 * narrow, well-known shape (a flat list of `<loc>...</loc>` entries, or at
 * worst a sitemap index of nested `<loc>` entries pointing at child
 * sitemaps) — a full XML parser is unnecessary overkill for extracting
 * just those URLs, so a regex match on `<loc>` is honest and sufficient
 * here, same spirit as websiteCrawler.ts's stripHtml/extractTitle regexes.
 * Caps at MAX_SITEMAP_URLS to avoid auditing a huge site in one request.
 */
export async function fetchSitemap(domain: string, fetchImpl: FetchLike = safeFetch): Promise<SitemapResult> {
  const sitemapUrl = new URL("/sitemap.xml", toRootUrl(domain)).toString();
  try {
    const res = await fetchImpl(sitemapUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { found: false, urls: [] };
    const xml = await res.text();
    const matches = xml.match(/<loc>([\s\S]*?)<\/loc>/gi) ?? [];
    const urls = matches
      .map((m) => m.replace(/<\/?loc>/gi, "").trim())
      .filter((u) => u.length > 0)
      .slice(0, MAX_SITEMAP_URLS);
    return { found: true, urls };
  } catch {
    // Network error, timeout, DNS failure, etc. — honestly "not found",
    // same convention as dnsVerification.ts/emailVerification.ts.
    return { found: false, urls: [] };
  }
}

/** Real `fetch(https://{domain}/robots.txt)` — 200 means found. */
export async function checkRobotsTxt(domain: string, fetchImpl: FetchLike = safeFetch): Promise<boolean> {
  const robotsUrl = new URL("/robots.txt", toRootUrl(domain)).toString();
  try {
    const res = await fetchImpl(robotsUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Real HTTP HEAD request (falling back to GET if HEAD isn't allowed, e.g.
 * a 405) with a short timeout. Never throws — a network error is reported
 * as `{ ok: false, status: 0 }` rather than propagating.
 */
export async function checkLinkStatus(url: string, fetchImpl: FetchLike = safeFetch): Promise<LinkStatusResult> {
  try {
    const headRes = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (headRes.status === 405) {
      const getRes = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      return { ok: getRes.ok, status: getRes.status };
    }
    return { ok: headRes.ok, status: headRes.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_DESCRIPTION_RE =
  /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>|<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Real regex-based extraction of `<title>` and
 * `<meta name="description" content="...">`, flagging missing/empty
 * values and over-length ones. Missing = high severity (a real SEO/CTR
 * problem); too-long = low severity (search engines truncate it, but the
 * content is still present).
 */
export function auditPageMetadata(html: string, url: string): SiteAuditIssue[] {
  const issues: SiteAuditIssue[] = [];

  const titleMatch = html.match(TITLE_RE);
  const title = titleMatch ? decodeEntities(titleMatch[1]) : "";
  if (!title) {
    issues.push({
      issueType: "missing_title",
      url,
      detail: "Page has no <title> element (or it is empty).",
      severity: "high",
    });
  } else if (title.length > TITLE_MAX_LENGTH) {
    issues.push({
      issueType: "title_too_long",
      url,
      detail: `Title is ${title.length} characters (recommended max ${TITLE_MAX_LENGTH}): "${title}"`,
      severity: "low",
    });
  }

  const descMatch = html.match(META_DESCRIPTION_RE);
  const description = descMatch ? decodeEntities(descMatch[1] ?? descMatch[2] ?? "") : "";
  if (!description) {
    issues.push({
      issueType: "missing_meta_description",
      url,
      detail: 'Page has no <meta name="description" content="..."> element (or it is empty).',
      severity: "high",
    });
  } else if (description.length > META_DESCRIPTION_MAX_LENGTH) {
    issues.push({
      issueType: "meta_description_too_long",
      url,
      detail: `Meta description is ${description.length} characters (recommended max ${META_DESCRIPTION_MAX_LENGTH}).`,
      severity: "low",
    });
  }

  return issues;
}

/** Runs an array of async tasks with a bounded concurrency. */
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

export interface RunSiteAuditOptions {
  fetchImpl?: FetchLike;
}

/**
 * Orchestrates a full site audit: sitemap (falling back to just the root
 * page when no sitemap is found), robots.txt, per-page link status +
 * metadata checks (bounded concurrency, short per-request timeout). Never
 * throws on an individual page failure — it is recorded as a broken_link
 * issue and the audit continues.
 */
export async function runSiteAudit(domain: string, options: RunSiteAuditOptions = {}): Promise<RunSiteAuditResult> {
  const fetchImpl = options.fetchImpl ?? safeFetch;
  const root = toRootUrl(domain);

  const [sitemap, robotsFound] = await Promise.all([
    fetchSitemap(domain, fetchImpl),
    checkRobotsTxt(domain, fetchImpl),
  ]);

  const issues: SiteAuditIssue[] = [];
  if (!sitemap.found) {
    issues.push({
      issueType: "missing_sitemap",
      url: new URL("/sitemap.xml", root).toString(),
      detail: "No sitemap.xml was found at the expected location.",
      severity: "medium",
    });
  }
  if (!robotsFound) {
    issues.push({
      issueType: "missing_robots",
      url: new URL("/robots.txt", root).toString(),
      detail: "No robots.txt was found at the expected location.",
      severity: "low",
    });
  }

  const urlsToCheck = sitemap.urls.length > 0 ? sitemap.urls : [root];

  const perPageIssues = await mapWithConcurrency(urlsToCheck, MAX_CONCURRENCY, async (url) => {
    const linkStatus = await checkLinkStatus(url, fetchImpl);
    if (!linkStatus.ok) {
      return [
        {
          issueType: "broken_link" as const,
          url,
          detail:
            linkStatus.status === 0
              ? "Request failed (network error, timeout, or unreachable)."
              : `Returned HTTP ${linkStatus.status}.`,
          severity: "high" as const,
        },
      ];
    }

    try {
      const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        return [
          {
            issueType: "broken_link" as const,
            url,
            detail: `Returned HTTP ${res.status} on GET.`,
            severity: "high" as const,
          },
        ];
      }
      const html = await res.text();
      return auditPageMetadata(html, url);
    } catch (err) {
      return [
        {
          issueType: "broken_link" as const,
          url,
          detail: `Could not fetch page content: ${err instanceof Error ? err.message : String(err)}`,
          severity: "high" as const,
        },
      ];
    }
  });

  for (const pageIssues of perPageIssues) {
    issues.push(...pageIssues);
  }

  return {
    sitemapFound: sitemap.found,
    robotsFound,
    pagesChecked: urlsToCheck.length,
    issues,
  };
}
