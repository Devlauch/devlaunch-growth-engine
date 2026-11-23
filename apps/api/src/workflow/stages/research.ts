import type { StageExecutor, StageInput, StageResult } from "../types.js";
import {
  COMPETITOR_CANDIDATE_PATHS,
  Crawl4AINotConfiguredError,
  Crawl4AIUnreachableError,
  fetchCompetitorPage,
} from "../../lib/crawl4aiClient.js";
import { detectCompetitorChanges, type DetectedChange, type SnapshotPage } from "../../lib/competitorChangeDetection.js";
import { extractKeywords, type ExtractedKeyword } from "../../lib/keywordExtraction.js";
import { runSiteAudit, type RunSiteAuditResult } from "../../lib/siteAudit.js";
import { stripHtml } from "../../lib/htmlText.js";
import { safeFetch } from "../../lib/ssrfGuard.js";

/**
 * Stage 2: research. Phase 4 orchestration stage composing three
 * already-built Phase 2 features purely by calling their real library
 * functions directly (never fabricating data, never calling a route
 * handler):
 *
 *  - apps/api/src/lib/crawl4aiClient.ts + competitorChangeDetection.ts —
 *    same crawl-then-diff flow as routes/competitors.ts's POST /:id/crawl,
 *    run here against whatever competitor domains the workflow was given
 *    (not necessarily rows already in the `competitors` table — if a
 *    matching row/prior snapshot *does* exist for this project+domain, it
 *    is used for a real diff via detectCompetitorChanges; nothing new is
 *    written back to competitor_snapshots/competitor_changes — this stage
 *    is read-only research, not a replacement for the dedicated crawl
 *    route).
 *  - apps/api/src/lib/siteAudit.ts's runSiteAudit — the client's own site,
 *    resolved from inputConfig.researchDomain or, failing that, a real
 *    `project_profiles.website_url` lookup. No profile/website on file ->
 *    the site-audit sub-check is honestly skipped, never fabricated.
 *  - apps/api/src/lib/keywordExtraction.ts's extractKeywords — run over
 *    whatever real page text step 2/3 actually fetched, to produce a
 *    simple, honest keyword-overlap comparison (set intersection/
 *    difference, no narrative).
 *
 * `status` is always "completed" here — thin/empty research results (an
 * unreachable competitor, no website on file, no overlapping keywords) are
 * real findings, not stage failures. Only an actual thrown error from this
 * file's own code produces "failed".
 */

const MAX_COMPETITOR_DOMAINS = 5;
const CLIENT_FETCH_TIMEOUT_MS = 5000;
const TOP_N_KEYWORDS = 30;

interface CompetitorResearchResult {
  domain: string;
  status: "crawled" | "unreachable";
  error?: string;
  pagesFetched?: number;
  topKeywords?: ExtractedKeyword[];
  changesDetected?: DetectedChange[];
  comparedAgainstPriorSnapshot?: boolean;
}

interface KeywordComparisonEntry {
  domain: string;
  overlapCount: number;
  overlapKeywords: string[];
  distinctToClientCount: number;
  distinctToCompetitorCount: number;
}

interface KeywordComparison {
  clientTopKeywords: ExtractedKeyword[];
  perCompetitor: KeywordComparisonEntry[];
}

function normalizeDomainToOrigin(domain: string): string {
  if (/^https?:\/\//i.test(domain)) return domain.replace(/\/+$/, "");
  return `https://${domain.replace(/\/+$/, "")}`;
}

/** Crawls a single competitor domain the same way routes/competitors.ts's POST /:id/crawl does. */
async function crawlCompetitorDomain(domain: string): Promise<{ pages: SnapshotPage[]; combinedText: string }> {
  const origin = normalizeDomainToOrigin(domain);
  const pages: SnapshotPage[] = [];

  for (const path of COMPETITOR_CANDIDATE_PATHS) {
    const url = new URL(path, origin).toString();
    const fetched = await fetchCompetitorPage(url);
    if (fetched.statusCode >= 400 || !fetched.html) {
      // A single page 404ing / being empty is not a service-level failure.
      continue;
    }
    const extractedText = stripHtml(fetched.html);
    pages.push({
      url,
      pageType: path === "/" ? "home" : path.replace(/^\//, ""),
      title: fetched.title,
      extractedText,
      contentHash: "", // not persisted here — this stage never writes competitor_snapshots
    });
  }

  const combinedText = pages.map((p) => p.extractedText).join(" ");
  return { pages, combinedText };
}

/**
 * Real, best-effort homepage text fetch for the client's own site, used only
 * for keyword comparison. `domain` comes from `inputConfig.researchDomain`
 * (workflow-caller-supplied) or `project_profiles.website_url` (tenant
 * data) — both attacker-influenceable, so this goes through the same
 * SSRF-hardened `safeFetch` (../../lib/ssrfGuard.ts) every other
 * tenant/user-supplied-domain fetch in this codebase uses (see
 * growthAnalyzer.ts, internalLinking.ts, siteAudit.ts, crawl4aiClient.ts),
 * never bare `fetch`. An `SsrfBlockedError` is just another best-effort
 * failure here — caught and reported as "no homepage text", not thrown.
 */
async function fetchClientHomepageText(domain: string): Promise<string | null> {
  const root = normalizeDomainToOrigin(domain);
  try {
    const res = await safeFetch(root, {}, { timeoutMs: CLIENT_FETCH_TIMEOUT_MS });
    if (!res.ok) return null;
    const html = await res.text();
    return stripHtml(html);
  } catch {
    return null;
  }
}

export const runResearchStage: StageExecutor = async (input: StageInput): Promise<StageResult> => {
  const { tenantId, projectId, tenantDb, inputConfig } = input;

  const requestedDomains = Array.isArray(inputConfig.competitorDomains)
    ? (inputConfig.competitorDomains as unknown[]).filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    : [];
  const competitorDomains = requestedDomains.slice(0, MAX_COMPETITOR_DOMAINS);

  // ---------------------------------------------------------------------
  // 1. Resolve the client's own research domain.
  // ---------------------------------------------------------------------
  let researchDomain: string | null =
    typeof inputConfig.researchDomain === "string" && inputConfig.researchDomain.trim()
      ? inputConfig.researchDomain.trim()
      : null;
  let websiteSource: "inputConfig" | "project_profiles" | null = researchDomain ? "inputConfig" : null;

  if (!researchDomain) {
    const profileResult = await tenantDb.query(
      `SELECT website_url FROM project_profiles WHERE tenant_id = $1 AND project_id = $2 LIMIT 1`,
      [tenantId, projectId],
    );
    const websiteUrl = profileResult.rows[0]?.website_url as string | null | undefined;
    if (websiteUrl && websiteUrl.trim()) {
      researchDomain = websiteUrl.trim();
      websiteSource = "project_profiles";
    }
  }

  // ---------------------------------------------------------------------
  // 2. Crawl each competitor domain + diff against any prior snapshot.
  // ---------------------------------------------------------------------
  const competitorResults: CompetitorResearchResult[] = [];
  const competitorTextByDomain = new Map<string, string>();

  for (const domain of competitorDomains) {
    try {
      const { pages, combinedText } = await crawlCompetitorDomain(domain);

      let previousPages: SnapshotPage[] | null = null;
      let comparedAgainstPriorSnapshot = false;
      try {
        const existingCompetitorResult = await tenantDb.query(
          `SELECT id FROM competitors WHERE tenant_id = $1 AND project_id = $2 AND domain = $3 LIMIT 1`,
          [tenantId, projectId, domain],
        );
        const existingCompetitor = existingCompetitorResult.rows[0] as { id: string } | undefined;
        if (existingCompetitor) {
          const snapshotResult = await tenantDb.query(
            `SELECT pages FROM competitor_snapshots WHERE competitor_id = $1 AND tenant_id = $2
             ORDER BY crawled_at DESC LIMIT 1`,
            [existingCompetitor.id, tenantId],
          );
          const priorSnapshot = snapshotResult.rows[0] as { pages: SnapshotPage[] } | undefined;
          if (priorSnapshot) {
            previousPages = priorSnapshot.pages;
            comparedAgainstPriorSnapshot = true;
          }
        }
      } catch {
        // Best-effort diff lookup only — never fail the competitor's crawl
        // result over an optional comparison query.
        previousPages = null;
        comparedAgainstPriorSnapshot = false;
      }

      const changesDetected = detectCompetitorChanges(previousPages, pages);
      const topKeywords = extractKeywords(combinedText, TOP_N_KEYWORDS);
      if (combinedText.trim()) competitorTextByDomain.set(domain, combinedText);

      competitorResults.push({
        domain,
        status: "crawled",
        pagesFetched: pages.length,
        topKeywords,
        changesDetected,
        comparedAgainstPriorSnapshot,
      });
    } catch (err) {
      if (err instanceof Crawl4AINotConfiguredError || err instanceof Crawl4AIUnreachableError) {
        competitorResults.push({ domain, status: "unreachable", error: err.message });
      } else {
        // Any other unexpected error crawling one competitor is still
        // recorded per-competitor rather than failing the whole stage.
        competitorResults.push({
          domain,
          status: "unreachable",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // 3. Audit the client's own site, if one was resolved.
  // ---------------------------------------------------------------------
  let siteAudit: (RunSiteAuditResult & { domain: string; status: "audited" }) | { status: "error"; domain: string; error: string } | null =
    null;
  let clientText: string | null = null;

  if (researchDomain) {
    try {
      const auditResult = await runSiteAudit(researchDomain);
      siteAudit = { ...auditResult, domain: researchDomain, status: "audited" };
    } catch (err) {
      siteAudit = {
        status: "error",
        domain: researchDomain,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    clientText = await fetchClientHomepageText(researchDomain);
  }

  // ---------------------------------------------------------------------
  // 4. Keyword comparison: client vs. each successfully-crawled competitor.
  // ---------------------------------------------------------------------
  const clientTopKeywords = clientText ? extractKeywords(clientText, TOP_N_KEYWORDS) : [];
  const clientKeywordSet = new Set(clientTopKeywords.map((k) => k.keyword));

  const perCompetitor: KeywordComparisonEntry[] = [];
  for (const [domain, text] of competitorTextByDomain) {
    const competitorKeywords = extractKeywords(text, TOP_N_KEYWORDS);
    const competitorKeywordSet = new Set(competitorKeywords.map((k) => k.keyword));
    const overlapKeywords = [...clientKeywordSet].filter((k) => competitorKeywordSet.has(k));
    perCompetitor.push({
      domain,
      overlapCount: overlapKeywords.length,
      overlapKeywords,
      distinctToClientCount: clientKeywordSet.size - overlapKeywords.length,
      distinctToCompetitorCount: competitorKeywordSet.size - overlapKeywords.length,
    });
  }

  const keywordComparison: KeywordComparison = { clientTopKeywords, perCompetitor };

  // ---------------------------------------------------------------------
  // 5. Compose the real, honest summary.
  // ---------------------------------------------------------------------
  const unreachableCount = competitorResults.filter((c) => c.status === "unreachable").length;
  const crawledCount = competitorResults.filter((c) => c.status === "crawled").length;

  const summaryParts: string[] = [];
  if (competitorDomains.length > 0) {
    const unreachableSuffix = unreachableCount > 0 ? ` (${unreachableCount} unreachable)` : "";
    summaryParts.push(`Audited ${crawledCount} of ${competitorDomains.length} competitor site(s)${unreachableSuffix}`);
  } else {
    summaryParts.push("No competitor domains were supplied");
  }

  if (siteAudit && siteAudit.status === "audited") {
    const brokenLinks = siteAudit.issues.filter((i) => i.issueType === "broken_link").length;
    summaryParts.push(`audited our own site ${siteAudit.domain} (${brokenLinks} broken link(s) found)`);
  } else if (siteAudit && siteAudit.status === "error") {
    summaryParts.push(`our own site audit of ${siteAudit.domain} errored (${siteAudit.error})`);
  } else {
    summaryParts.push("no website on file for this project, so the own-site audit was skipped");
  }

  const topOverlap = [...perCompetitor].sort((a, b) => b.overlapCount - a.overlapCount)[0];
  let keywordSentence = "";
  if (topOverlap && topOverlap.overlapCount > 0) {
    keywordSentence = ` ${topOverlap.overlapCount} keyword overlap(s) with ${topOverlap.domain}.`;
  } else if (perCompetitor.length > 0) {
    keywordSentence = " No keyword overlap found with the crawled competitor(s).";
  }

  const summary = `${summaryParts.join(" and ")}.${keywordSentence}`;

  return {
    stage: "research",
    status: "completed",
    summary,
    data: {
      competitorDomainsRequested: competitorDomains,
      competitorResults,
      researchDomain,
      websiteSource,
      siteAudit,
      keywordComparison,
    },
  };
};
