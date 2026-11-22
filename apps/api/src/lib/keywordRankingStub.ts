/**
 * Honest pluggable stub for SERP keyword-ranking tracking (Phase 2 item 3,
 * "Technical SEO Agent"). Real position tracking genuinely requires a
 * paid provider (SEMrush/Ahrefs/DataForSEO, etc.) this environment has no
 * credentials for. This mirrors the exact
 * NotConfiguredError/NotConfiguredDirectoryApiClient pattern in
 * packages/agent-sdk/src/connectors/publicDirectoryConnector.ts:
 *
 *   1. `RankingProvider` — the stable pluggable interface a real SERP API
 *      client can implement later, without any caller needing to change.
 *   2. `NotConfiguredRankingProvider` — the one concrete implementation
 *      available today. It throws rather than returning a fake/guessed
 *      position.
 */

import type { RunSiteAuditResult, SiteAuditIssue } from "./siteAudit.js";

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export interface RankingCheckResult {
  position: number | null;
  source: string;
  checkedAt: string;
}

/** Pluggable backend for `checkRanking`. Implement this against a real SERP API (SEMrush/Ahrefs/DataForSEO/etc.) to back keyword tracking with that provider. */
export interface RankingProvider {
  checkRanking(keyword: string, domain: string): Promise<RankingCheckResult>;
}

/**
 * Honest stand-in for a licensed SERP-tracking provider we don't have
 * credentials for in this environment. Always throws — never returns a
 * fabricated "looks real" ranking position. Wire in a real client
 * (implementing `RankingProvider`) once an API key exists.
 */
export class NotConfiguredRankingProvider implements RankingProvider {
  constructor(private readonly providerName = "SERP ranking provider (e.g. SEMrush/Ahrefs/DataForSEO)") {}

  async checkRanking(_keyword: string, _domain: string): Promise<never> {
    throw new NotConfiguredError(
      `${this.providerName} is not configured (no API key available in this environment). ` +
        `Implement RankingProvider against a real provider and pass it in once credentials ` +
        `are available. Refusing to fabricate a ranking position.`,
    );
  }
}

export interface SeoRecommendationsAudit {
  sitemap_found: boolean;
  robots_found: boolean;
  pages_checked: number;
  broken_links_count: number;
  missing_meta_count: number;
  core_web_vitals_status: "ok" | "not_configured" | "error";
  core_web_vitals: { performanceScore?: number } | null;
}

/**
 * Real rule-based recommendations generated from the actual counts on an
 * audit + its issues — never fabricated advice copy unrelated to what was
 * actually found.
 */
export function generateSeoRecommendations(
  audit: SeoRecommendationsAudit,
  issues: Pick<SiteAuditIssue, "issueType" | "severity">[],
): string[] {
  const recommendations: string[] = [];

  if (!audit.sitemap_found) {
    recommendations.push("Add sitemap.xml — none was found. A sitemap helps search engines discover and index your pages.");
  }
  if (!audit.robots_found) {
    recommendations.push("Add robots.txt — none was found. It lets you control which pages search engine crawlers can access.");
  }
  if (audit.broken_links_count > 0) {
    recommendations.push(
      `Fix ${audit.broken_links_count} broken link${audit.broken_links_count === 1 ? "" : "s"} before your next crawl. Broken links hurt both user experience and crawl budget.`,
    );
  }
  if (audit.missing_meta_count > 0) {
    recommendations.push(
      `${audit.missing_meta_count} page${audit.missing_meta_count === 1 ? " is" : "s are"} missing a title or meta description, which hurts click-through from search results.`,
    );
  }

  const titleTooLong = issues.filter((i) => i.issueType === "title_too_long").length;
  if (titleTooLong > 0) {
    recommendations.push(`${titleTooLong} page title(s) exceed the recommended length and may be truncated in search results.`);
  }
  const descTooLong = issues.filter((i) => i.issueType === "meta_description_too_long").length;
  if (descTooLong > 0) {
    recommendations.push(`${descTooLong} meta description(s) exceed the recommended length and may be truncated in search results.`);
  }

  if (audit.core_web_vitals_status === "not_configured") {
    recommendations.push(
      "Core Web Vitals monitoring isn't configured — set GOOGLE_PAGESPEED_API_KEY to get real LCP/CLS/INP and performance-score data from Google PageSpeed Insights.",
    );
  } else if (audit.core_web_vitals_status === "error") {
    recommendations.push("The last Core Web Vitals check failed — see the audit's core_web_vitals error for details.");
  } else if (audit.core_web_vitals_status === "ok" && typeof audit.core_web_vitals?.performanceScore === "number") {
    const score = audit.core_web_vitals.performanceScore;
    if (score < 0.5) {
      recommendations.push(`Lighthouse performance score is low (${Math.round(score * 100)}/100) — Core Web Vitals need attention.`);
    } else if (score < 0.9) {
      recommendations.push(`Lighthouse performance score is ${Math.round(score * 100)}/100 — there's room to improve Core Web Vitals.`);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push("No issues found in this audit — technical SEO fundamentals look healthy.");
  }

  return recommendations;
}

// Re-exported so callers that only need the "what did this audit produce"
// shape (apps/api/src/routes/seo.ts) don't need a second import for the
// runSiteAudit() result type.
export type { RunSiteAuditResult };
