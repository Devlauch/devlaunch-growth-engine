import { parseRobotsTxt } from "./robotsTxt.js";

/**
 * Real website-crawling capability backing `Crawl4AIResearchAdapter`
 * (see ./researchAdapter.ts). This module:
 *   - Fetches and obeys the target domain's robots.txt (./robotsTxt.ts).
 *   - Rate-limits requests per domain.
 *   - Classifies pages (contact / about / departments / placement / news)
 *     from URL path + page heading/title text.
 *   - Extracts only publicly-posted business info: page text, emails,
 *     phone numbers — never login-walled content or personal profiles.
 *   - Delegates the actual page fetch to a `CrawlBackend`, with
 *     `HttpCrawl4AIBackend` as the one real HTTP implementation. The
 *     exact Crawl4AI Docker HTTP API shape (endpoint path, request/response
 *     JSON) is NOT independently verified against a live instance as part
 *     of this change — see the comment on `HttpCrawl4AIBackend` below. The
 *     `CrawlBackend` interface exists specifically so that detail can be
 *     corrected later without touching any of the crawl logic in this file.
 */

export type PageType = "contact" | "about" | "departments" | "placement" | "news" | "other";

export interface CrawledPage {
  url: string;
  pageType: PageType;
  title?: string;
  extractedText: string;
  extractedEmails: string[];
  extractedPhones: string[];
  fetchedAt: string;
}

export interface SkippedUrl {
  url: string;
  reason: string;
}

export interface CrawlOrganizationSiteResult {
  pages: CrawledPage[];
  skipped: SkippedUrl[];
}

/** Candidate paths probed on an organization's own site, by intent. */
export const DEFAULT_CANDIDATE_PATHS: string[] = [
  "/",
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
  "/departments",
  "/our-departments",
  "/placement",
  "/placements",
  "/training-and-placement",
  "/careers",
  "/news",
  "/press",
  "/media",
];

export interface CrawlOrganizationSiteOptions {
  /** Candidate paths to probe. Defaults to DEFAULT_CANDIDATE_PATHS. */
  paths?: string[];
  /** Hard cap on number of pages fetched (after robots.txt filtering). */
  maxPages?: number;
  /** Conservative default: 1 request/sec per domain. */
  requestsPerSecond?: number;
  /** User-Agent string used both for robots.txt group selection and the crawl itself. */
  userAgent?: string;
  /** Swap in a fake backend for tests; defaults to a real HttpCrawl4AIBackend. */
  backend?: CrawlBackend;
  /** Swap in a fake fetch for tests (used for the robots.txt request only). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_USER_AGENT = "DevLaunchResearchBot/1.0 (+business-research; contact: platform-team)";

/**
 * Thrown when the Crawl4AI backend itself cannot be reached or errors out
 * at the transport/service level (as opposed to an individual page 404,
 * which is just skipped). Crawling aborts immediately on this error so we
 * never silently return an empty/partial result dressed up as "we
 * crawled the site and found nothing".
 */
export class CrawlServiceUnreachableError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Crawl4AI service at ${baseUrl} is unreachable or errored: ${causeMessage}`);
    this.name = "CrawlServiceUnreachableError";
    this.cause = cause;
  }
}

export interface CrawlFetchResult {
  url: string;
  statusCode: number;
  html: string;
  title?: string;
}

/**
 * Pluggable backend for actually fetching a rendered page. Kept as an
 * interface (rather than hard-coding the HTTP call inline) specifically
 * so the concrete request/response shape can be corrected once verified
 * against a live Crawl4AI instance, without changing any crawl logic.
 */
export interface CrawlBackend {
  fetchPage(url: string): Promise<CrawlFetchResult>;
}

/**
 * Real HTTP implementation calling a Crawl4AI Docker service.
 *
 * NOT independently verified against a live instance. Implemented against
 * Crawl4AI's documented Docker server API as of this change: a synchronous
 * `POST {baseUrl}/crawl` accepting `{ urls: string[] }` (optionally more
 * crawler config) and returning `{ results: [{ url, success, status_code,
 * html, markdown, metadata: { title } }] }`. If the deployed service uses
 * the async `/crawl` + `/task/{id}` polling flow instead (older/newer
 * Crawl4AI versions differ here), only this class needs to change.
 */
export class HttpCrawl4AIBackend implements CrawlBackend {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchPage(url: string): Promise<CrawlFetchResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/crawl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: [url] }),
      });
    } catch (err) {
      // Network-level failure (connection refused, DNS failure, etc.) —
      // the service itself is unreachable.
      throw new CrawlServiceUnreachableError(this.baseUrl, err);
    }

    if (response.status >= 500) {
      throw new CrawlServiceUnreachableError(this.baseUrl, new Error(`HTTP ${response.status} ${response.statusText}`));
    }
    if (!response.ok) {
      // A 4xx for a single page (e.g. page genuinely 404s) is not a
      // service-level failure — surface it as a per-page result so the
      // caller can skip just this page.
      return { url, statusCode: response.status, html: "" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new CrawlServiceUnreachableError(this.baseUrl, err);
    }

    const result = extractFirstResult(body);
    return {
      url,
      statusCode: 200,
      html: result.html ?? "",
      title: result.title,
    };
  }
}

function extractFirstResult(body: unknown): { html?: string; title?: string } {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const results = obj.results;
    if (Array.isArray(results) && results.length > 0 && results[0] && typeof results[0] === "object") {
      const r = results[0] as Record<string, unknown>;
      const metadata = r.metadata as Record<string, unknown> | undefined;
      return {
        html: typeof r.html === "string" ? r.html : typeof r.markdown === "string" ? r.markdown : undefined,
        title: typeof metadata?.title === "string" ? (metadata.title as string) : undefined,
      };
    }
    // Fallback: a simpler { html, title } shape.
    if (typeof obj.html === "string") {
      return { html: obj.html, title: typeof obj.title === "string" ? obj.title : undefined };
    }
  }
  return {};
}

/** Serializes requests to the same domain with a minimum spacing between them. */
export class DomainRateLimiter {
  private lastRequestAt = new Map<string, number>();

  constructor(private readonly minIntervalMs: number) {}

  async wait(domainKey: string): Promise<void> {
    const now = Date.now();
    const last = this.lastRequestAt.get(domainKey) ?? 0;
    const elapsed = now - last;
    const remaining = this.minIntervalMs - elapsed;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    this.lastRequestAt.set(domainKey, Date.now());
  }
}

const PAGE_TYPE_PATTERNS: Array<[Exclude<PageType, "other">, RegExp]> = [
  ["contact", /contact/i],
  ["placement", /placement|training[-_ ]?and[-_ ]?placement|career[-_ ]?services|internship/i],
  ["departments", /department/i],
  ["news", /news|press|media|announcement|blog/i],
  ["about", /about/i],
];

/** Classifies a page's likely type from its URL path and heading/title text. */
export function classifyPageType(url: string, headingOrTitleText: string): PageType {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const haystack = `${path} ${headingOrTitleText}`;
  for (const [type, pattern] of PAGE_TYPE_PATTERNS) {
    if (pattern.test(haystack)) return type;
  }
  return "other";
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+/g;
// Loosely matches international/domestic business phone numbers: optional
// +country code, then 2-4 digit groups separated by spaces/dots/dashes,
// 9-14 digits total. Deliberately conservative (business listings only).
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,4}/g;

export function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_RE) ?? [];
  return Array.from(new Set(matches.map((m) => m.toLowerCase())));
}

export function extractPhones(text: string): string[] {
  const matches = text.match(PHONE_RE) ?? [];
  const cleaned = matches
    .map((m) => m.trim())
    .filter((m) => m.replace(/\D/g, "").length >= 9 && m.replace(/\D/g, "").length <= 15);
  return Array.from(new Set(cleaned));
}

/** Strips tags and collapses whitespace. Not a full HTML parser — good enough for business page text extraction. */
export function stripHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = withoutScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.replace(/\s+/g, " ").trim();
}

export function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : undefined;
}

export function extractHeadingText(html: string): string {
  const headings = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi) ?? [];
  return headings.map((h) => stripHtml(h)).join(" ");
}

function normalizeOrgDomain(orgDomain: string): string {
  if (/^https?:\/\//i.test(orgDomain)) return orgDomain.replace(/\/+$/, "");
  return `https://${orgDomain.replace(/\/+$/, "")}`;
}

/**
 * Crawls a KNOWN organization's own website, restricted to a conservative
 * set of candidate business-information paths (contact, about,
 * departments, placement/training, news). Obeys robots.txt and rate-limits
 * requests to the target domain. Never follows arbitrary links, never
 * authenticates, never scrapes personal/social profiles — only fetches the
 * organization's own public pages.
 *
 * Throws `CrawlServiceUnreachableError` (does not return a partial/empty
 * result silently) if the Crawl4AI backend itself cannot be reached.
 */
export async function crawlOrganizationSite(
  baseUrl: string,
  orgDomain: string,
  opts: CrawlOrganizationSiteOptions = {},
): Promise<CrawlOrganizationSiteResult> {
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const backend = opts.backend ?? new HttpCrawl4AIBackend(baseUrl, fetchImpl);
  const siteRoot = normalizeOrgDomain(orgDomain);
  const paths = opts.paths ?? DEFAULT_CANDIDATE_PATHS;
  const maxPages = opts.maxPages ?? paths.length;
  const limiter = new DomainRateLimiter(1000 / (opts.requestsPerSecond ?? 1));

  const pages: CrawledPage[] = [];
  const skipped: SkippedUrl[] = [];

  // Fetch + parse robots.txt once up front. A failure to even reach
  // robots.txt is treated as "allow by default" (common real-world crawler
  // behavior) but is recorded, not hidden.
  let robotsText = "";
  try {
    const robotsUrl = new URL("/robots.txt", siteRoot).toString();
    const robotsResp = await fetchImpl(robotsUrl);
    if (robotsResp.ok) {
      robotsText = await robotsResp.text();
    } else {
      skipped.push({ url: robotsUrl, reason: `robots.txt returned HTTP ${robotsResp.status}; proceeding as allow-all` });
    }
  } catch (err) {
    skipped.push({
      url: new URL("/robots.txt", siteRoot).toString(),
      reason: `robots.txt unreachable (${err instanceof Error ? err.message : String(err)}); proceeding as allow-all`,
    });
  }
  const robots = parseRobotsTxt(robotsText, userAgent);

  for (const path of paths) {
    if (pages.length >= maxPages) break;

    const pageUrl = new URL(path, siteRoot).toString();
    const pathname = new URL(pageUrl).pathname;

    if (!robots.isAllowed(pathname)) {
      skipped.push({ url: pageUrl, reason: "disallowed by robots.txt" });
      continue;
    }

    await limiter.wait(siteRoot);

    try {
      const fetched = await backend.fetchPage(pageUrl);
      if (fetched.statusCode >= 400) {
        skipped.push({ url: pageUrl, reason: `http ${fetched.statusCode}` });
        continue;
      }
      if (!fetched.html) {
        skipped.push({ url: pageUrl, reason: "empty response body" });
        continue;
      }

      const text = stripHtml(fetched.html);
      const title = fetched.title ?? extractTitle(fetched.html);
      const headingText = extractHeadingText(fetched.html);

      pages.push({
        url: pageUrl,
        pageType: classifyPageType(pageUrl, `${title ?? ""} ${headingText}`),
        title,
        extractedText: text,
        extractedEmails: extractEmails(text),
        extractedPhones: extractPhones(text),
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof CrawlServiceUnreachableError) {
        // The crawl backend itself is down — abort rather than keep
        // "trying" every remaining path and returning a hollow result.
        throw err;
      }
      skipped.push({ url: pageUrl, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { pages, skipped };
}
