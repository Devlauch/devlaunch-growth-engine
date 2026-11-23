import type { SnapshotPage } from "./competitorChangeDetection.js";

/**
 * Positioning insights + pricing/service-tier extraction (Phase 4b:
 * business intelligence — closing the "pricing/service comparison
 * extraction" gap flagged against routes/competitors.ts's existing
 * `GET /:id/report`, which previously only surfaced top keywords + a
 * templated change-count summary, never anything about pricing/plans).
 *
 * Same deterministic trigger-phrase approach as
 * ../lib/growthAnalyzer.ts's `extractValuePropositions`: scans sentences
 * from a competitor's own crawled pages (competitor_snapshots.pages — see
 * competitorChangeDetection.ts's SnapshotPage) for a small, fixed set of
 * pricing/plan/tier trigger phrases and returns the matching sentences
 * VERBATIM, deduped and capped. This is never summarized, paraphrased, or
 * invented — if a competitor's pricing page wasn't crawled (it's one of
 * COMPETITOR_CANDIDATE_PATHS, so usually is) or doesn't mention any
 * trigger phrase, this honestly returns an empty list rather than guessing
 * at their pricing.
 */

const PRICING_TRIGGERS = [
  "pricing",
  "price",
  "prices",
  "plan",
  "plans",
  "tier",
  "tiers",
  "/mo",
  "/month",
  "/user",
  "/seat",
  "per month",
  "per user",
  "per seat",
  "per year",
  "free trial",
  "free plan",
  "starting at",
  "starts at",
  "billed annually",
  "billed monthly",
  "contact sales",
  "custom pricing",
  "enterprise plan",
  "$",
  "€",
  "£",
];

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 300);
}

export interface PricingSignal {
  /** The real sentence, verbatim from the crawled page — never paraphrased. */
  sentence: string;
  /** The page it was found on. */
  pageUrl: string;
}

/**
 * Extracts real pricing/plan/service-tier sentences from a competitor's
 * crawled pages. Pure function over already-crawled SnapshotPage[] — no
 * network access, no LLM call.
 */
export function extractPricingSignals(pages: SnapshotPage[], limit = 12): PricingSignal[] {
  const seen = new Set<string>();
  const results: PricingSignal[] = [];
  for (const page of pages) {
    for (const sentence of sentencesOf(page.extractedText)) {
      const lower = sentence.toLowerCase();
      if (PRICING_TRIGGERS.some((trigger) => lower.includes(trigger))) {
        const key = lower.slice(0, 160);
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ sentence, pageUrl: page.url });
          if (results.length >= limit) return results;
        }
      }
    }
  }
  return results;
}

/**
 * Deterministic, templated positioning summary built directly from real
 * counts (never an LLM-written narrative) — extends
 * routes/competitors.ts's existing templated `positioningSummary` text
 * with a real pricing-signal count.
 */
export function buildPricingSummaryLine(pricingSignals: PricingSignal[]): string {
  if (pricingSignals.length === 0) {
    return "No pricing/plan language was found in this competitor's crawled pages.";
  }
  return (
    `${pricingSignals.length} pricing/plan sentence(s) found in this competitor's crawled pages — see ` +
    `pricingSignals for the verbatim text and source page.`
  );
}
