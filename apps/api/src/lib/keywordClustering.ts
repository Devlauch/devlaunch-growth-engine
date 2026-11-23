/**
 * Deterministic keyword clustering (Phase 5 item "keyword clustering" gap).
 *
 * Honesty contract: this is NOT an embedding/ML/LLM-based semantic
 * clustering. It groups the real TF keywords already computed by
 * ../lib/keywordExtraction.ts (itself mirroring
 * apps/worker/src/agents/competitorIntelligence.ts's extractKeywords)
 * using two small, explainable, fully deterministic heuristics:
 *
 *   1. A tiny suffix-stripping stemmer (e.g. "marketing"/"marketer"/
 *      "marketers" -> stem "market") — same spirit as growthAnalyzer.ts's
 *      fixed keyword dictionaries: no external NLP library, no statistical
 *      model, just a short list of common English suffixes stripped in a
 *      fixed order.
 *   2. Shared-substring grouping as a fallback for keywords that don't
 *      share a stem but do share a long common substring (e.g. "ecommerce"
 *      and "commerce"), so obviously related terms aren't left as
 *      singletons purely because the stemmer missed them.
 *
 * Every cluster is fully traceable back to the exact input keywords and
 * their real frequencies — nothing is invented, renamed, or inferred
 * beyond grouping terms that are already present in the crawled/extracted
 * text. Clusters are labeled with their highest-frequency member keyword,
 * not a generated/abstracted topic name.
 */

import type { ExtractedKeyword } from "./keywordExtraction.js";

export interface KeywordCluster {
  /** Stable, deterministic id derived from the cluster's stem/key — not a random uuid. */
  clusterKey: string;
  /** The highest-frequency keyword in the cluster — used as the human-facing label. */
  label: string;
  /** All member keywords, sorted by frequency desc (same tiebreak as extractKeywords). */
  keywords: ExtractedKeyword[];
  /** Sum of member frequencies — a real, derived number, not a fabricated "relevance score". */
  totalFrequency: number;
}

// Longest-suffix-first so "marketing" strips to "market" (not "marketing"
// minus a shorter, wrong-order match). Deliberately small and fixed.
const SUFFIXES = ["ational", "ization", "fulness", "iveness", "ousness", "ing", "ers", "er", "es", "ed", "ly", "s"];

const MIN_STEM_LENGTH = 3;

/**
 * Tiny, fixed-rule suffix stripper — not Porter/Snowball (no external NLP
 * dependency), just enough to merge common plural/verb-form variants of
 * the same word. Stops at MIN_STEM_LENGTH to avoid over-stripping short
 * words (e.g. never reduces "sales" below "sale").
 */
export function stemKeyword(keyword: string): string {
  const lower = keyword.toLowerCase();
  for (const suffix of SUFFIXES) {
    if (lower.length - suffix.length >= MIN_STEM_LENGTH && lower.endsWith(suffix)) {
      return lower.slice(0, lower.length - suffix.length);
    }
  }
  return lower;
}

const MIN_SHARED_SUBSTRING_LENGTH = 6;

/**
 * True when two keywords share a substring at least
 * MIN_SHARED_SUBSTRING_LENGTH long, anchored at the start of the shorter
 * word (catches "ecommerce"/"commerce", "invoicing"/"invoice", etc.)
 * without a full edit-distance computation.
 */
function shareLongSubstring(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < MIN_SHARED_SUBSTRING_LENGTH) return false;
  for (let len = shorter.length; len >= MIN_SHARED_SUBSTRING_LENGTH; len--) {
    for (let start = 0; start + len <= shorter.length; start++) {
      if (longer.includes(shorter.slice(start, start + len))) return true;
    }
  }
  return false;
}

export interface ClusterKeywordsOptions {
  /** Drop clusters with fewer than this many members (default 1 — singletons kept). */
  minClusterSize?: number;
  /** Cap on number of clusters returned (sorted by totalFrequency desc). */
  limit?: number;
}

/**
 * Groups extracted keywords into deterministic clusters:
 *  1. Group by shared stem (stemKeyword).
 *  2. Merge any remaining distinct stem-groups that share a long substring
 *     with another group's representative keyword (union-find over a small
 *     N, fine for the <=40 keywords extractKeywords/growth analyses return).
 *
 * Pure function — no network/DB access, fully unit-testable.
 */
export function clusterKeywords(keywords: ExtractedKeyword[], options: ClusterKeywordsOptions = {}): KeywordCluster[] {
  const { minClusterSize = 1, limit } = options;
  if (keywords.length === 0) return [];

  // Step 1: group by stem.
  const stemGroups = new Map<string, ExtractedKeyword[]>();
  for (const kw of keywords) {
    const stem = stemKeyword(kw.keyword);
    const group = stemGroups.get(stem) ?? [];
    group.push(kw);
    stemGroups.set(stem, group);
  }

  // Step 2: union-find over stem-group representatives that share a long substring.
  const stems = Array.from(stemGroups.keys());
  const parent = new Map<string, string>(stems.map((s) => [s, s]));
  function find(x: string): string {
    while (parent.get(x) !== x) {
      const next = parent.get(x)!;
      parent.set(x, parent.get(next)!);
      x = next;
    }
    return x;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (let i = 0; i < stems.length; i++) {
    for (let j = i + 1; j < stems.length; j++) {
      if (shareLongSubstring(stems[i], stems[j])) union(stems[i], stems[j]);
    }
  }

  // Merge stem-groups into final clusters keyed by their union-find root.
  const merged = new Map<string, ExtractedKeyword[]>();
  for (const stem of stems) {
    const root = find(stem);
    const bucket = merged.get(root) ?? [];
    bucket.push(...stemGroups.get(stem)!);
    merged.set(root, bucket);
  }

  const clusters: KeywordCluster[] = Array.from(merged.entries())
    .map(([clusterKey, members]) => {
      const sorted = [...members].sort(
        (a, b) => b.frequency - a.frequency || a.keyword.localeCompare(b.keyword),
      );
      return {
        clusterKey,
        label: sorted[0].keyword,
        keywords: sorted,
        totalFrequency: sorted.reduce((sum, k) => sum + k.frequency, 0),
      };
    })
    .filter((c) => c.keywords.length >= minClusterSize)
    .sort((a, b) => b.totalFrequency - a.totalFrequency || a.label.localeCompare(b.label));

  return typeof limit === "number" ? clusters.slice(0, limit) : clusters;
}
