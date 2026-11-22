/**
 * Real, dependency-free landing page audit (Phase 2 item 5, "Conversion
 * Optimization Agent"): a single `fetch` + regex pass over a landing page's
 * HTML, looking for a conversion path (a CTA and/or a form) and basic
 * content signals (word count, heading count).
 *
 * Deliberately NOT built on apps/api/src/lib/siteAudit.ts: siteAudit.ts
 * (Phase 2 item 3, "Technical SEO Agent") checks sitemap/robots/broken
 * links/title+meta-description length — a different concern from "does
 * this page have a working conversion path." Reusing it would mean either
 * dragging in sitemap-crawl behavior this feature doesn't want, or
 * reaching into its internals for something it doesn't export. This file
 * is a small, deliberately separate fetch+regex helper, same precedent as
 * scoreLead.ts mirroring leadScoring.ts and siteAudit.ts itself mirroring
 * apps/worker/src/agents/websiteCrawler.ts.
 *
 * Never throws: a network failure, non-2xx response, or timeout degrades
 * to `loadStatus: 'error'` / `'timeout'` with zeroed counts and no
 * findings — honest, not fabricated.
 */

export type LoadStatus = "ok" | "error" | "timeout";
export type FindingSeverity = "low" | "medium" | "high";

export interface LandingPageFinding {
  issue: string;
  detail: string;
  severity: FindingSeverity;
}

export interface LandingPageAuditResult {
  hasCta: boolean;
  hasForm: boolean;
  wordCount: number;
  headingCount: number;
  loadStatus: LoadStatus;
  findings: LandingPageFinding[];
}

const FETCH_TIMEOUT_MS = 8000;
const THIN_CONTENT_WORD_THRESHOLD = 50;

// Real heuristic, not a definitive detector: common CTA button/link copy
// seen on landing pages. A page can have a working conversion path that
// uses different wording than this list and would be under-detected here
// (documented limitation, not silently assumed to be exhaustive).
const CTA_PATTERNS = [
  "sign up",
  "get started",
  "book a",
  "request a demo",
  "contact us",
  "buy now",
  "start free trial",
];

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function detectCta(html: string): boolean {
  const lower = html.toLowerCase();
  return CTA_PATTERNS.some((pattern) => lower.includes(pattern));
}

function detectForm(html: string): boolean {
  return /<form[\s>]/i.test(html);
}

function countHeadings(html: string): number {
  const matches = html.match(/<h[1-6][\s>]/gi);
  return matches ? matches.length : 0;
}

/**
 * Real, rule-based issue derivation from the checks above. Each rule is
 * documented inline; nothing here is invented beyond what the checks
 * actually found.
 */
function deriveFindings(input: {
  hasCta: boolean;
  hasForm: boolean;
  wordCount: number;
  headingCount: number;
}): LandingPageFinding[] {
  const findings: LandingPageFinding[] = [];

  if (!input.hasCta) {
    findings.push({
      issue: "no_cta_detected",
      detail: "No common call-to-action button/link copy (e.g. 'sign up', 'get started', 'book a demo') was found.",
      severity: "high",
    });
  }

  if (!input.hasForm && !input.hasCta) {
    findings.push({
      issue: "no_conversion_path",
      detail: "No <form> and no detectable CTA were found — visitors have no obvious way to convert on this page.",
      severity: "high",
    });
  }

  if (input.wordCount < THIN_CONTENT_WORD_THRESHOLD) {
    findings.push({
      issue: "thin_content",
      detail: `Page body has only ${input.wordCount} word(s), under the ${THIN_CONTENT_WORD_THRESHOLD}-word thin-content threshold.`,
      severity: "medium",
    });
  }

  if (input.headingCount === 0) {
    findings.push({
      issue: "no_headings",
      detail: "No <h1>-<h6> heading elements were found on the page.",
      severity: "low",
    });
  }

  return findings;
}

function degradedResult(loadStatus: Extract<LoadStatus, "error" | "timeout">): LandingPageAuditResult {
  return {
    hasCta: false,
    hasForm: false,
    wordCount: 0,
    headingCount: 0,
    loadStatus,
    findings: [],
  };
}

export interface AuditLandingPageOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Fetches `url` with an 8s timeout and runs the real regex checks above.
 * Never throws — network failure or timeout returns an honest degraded
 * result (`loadStatus: 'error'`/`'timeout'`, zeroed counts, no findings)
 * instead of fabricating data.
 */
export async function auditLandingPage(
  url: string,
  options: AuditLandingPageOptions = {},
): Promise<LandingPageAuditResult> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return degradedResult(isTimeout ? "timeout" : "error");
  }

  if (!res.ok) {
    return degradedResult("error");
  }

  let html: string;
  try {
    html = await res.text();
  } catch {
    return degradedResult("error");
  }

  const hasCta = detectCta(html);
  const hasForm = detectForm(html);
  const wordCount = countWords(stripTags(html));
  const headingCount = countHeadings(html);

  return {
    hasCta,
    hasForm,
    wordCount,
    headingCount,
    loadStatus: "ok",
    findings: deriveFindings({ hasCta, hasForm, wordCount, headingCount }),
  };
}
