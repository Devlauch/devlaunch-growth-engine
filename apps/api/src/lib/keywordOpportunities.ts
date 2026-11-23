import type { ExtractedKeyword } from "./keywordExtraction.js";

/**
 * "Keyword opportunities" (Phase 4b: business intelligence). Builds on the
 * same real, already-crawled data as ../lib/growthAnalyzer.ts's
 * `computeContentGaps` (real TF keyword sets: this project's own latest
 * growth_analyses.extracted_keywords vs. each tracked competitor's latest
 * competitor_snapshots.extracted_keywords) but is kept as its own small,
 * pure module — rather than editing growthAnalyzer.ts directly, which is
 * being actively edited in parallel this round by the sibling agent
 * owning website-analysis/ICP — to avoid merge collisions. The algorithm is
 * intentionally the same honesty contract: a "keyword opportunity" here is
 * strictly a keyword that appears in at least one real competitor's
 * crawled content and does NOT appear in this project's own crawled
 * content. There is no real keyword-search-volume API integrated anywhere
 * in this codebase (grep confirms no such provider exists), so the
 * "signal" ranking a keyword opportunity carries is real, observed data
 * only: how many tracked competitors use the term, and their combined
 * term-frequency count — never an invented "search volume" number.
 */

export interface KeywordOpportunity {
  keyword: string;
  /** How many of the tracked competitors' latest crawls use this term at all. */
  competitorCount: number;
  /** Sum of this keyword's TF frequency across every competitor whose latest snapshot contains it — a real, observed signal, not search volume. */
  combinedFrequency: number;
  /** Which tracked competitors (by name) actually use this term, each with its own real frequency from their latest crawl. */
  competitors: Array<{ competitorName: string; frequency: number }>;
}

/**
 * Computes real keyword opportunities: terms present in at least one
 * tracked competitor's latest crawled keyword set but absent from this
 * project's own latest crawled keyword set, ranked by how many competitors
 * use the term (desc) then combined real frequency (desc) — i.e. ranked by
 * real observed competitive signal, never a guessed metric.
 */
export function computeKeywordOpportunities(
  ownKeywords: ExtractedKeyword[],
  competitorKeywordSets: Array<{ competitorName: string; keywords: ExtractedKeyword[] }>,
  limit = 25,
): KeywordOpportunity[] {
  const ownSet = new Set(ownKeywords.map((k) => k.keyword));
  const byKeyword = new Map<string, KeywordOpportunity>();

  for (const { competitorName, keywords } of competitorKeywordSets) {
    for (const { keyword, frequency } of keywords) {
      if (ownSet.has(keyword)) continue;
      let entry = byKeyword.get(keyword);
      if (!entry) {
        entry = { keyword, competitorCount: 0, combinedFrequency: 0, competitors: [] };
        byKeyword.set(keyword, entry);
      }
      entry.competitorCount += 1;
      entry.combinedFrequency += frequency;
      entry.competitors.push({ competitorName, frequency });
    }
  }

  return Array.from(byKeyword.values())
    .sort(
      (a, b) =>
        b.competitorCount - a.competitorCount ||
        b.combinedFrequency - a.combinedFrequency ||
        a.keyword.localeCompare(b.keyword),
    )
    .slice(0, limit);
}
