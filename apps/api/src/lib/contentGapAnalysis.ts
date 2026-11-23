/**
 * Content-gap analysis (Workstream E): a pure, deterministic comparison of
 * two already-extracted website_intelligence_snapshots payloads (one of
 * ours, one of a competitor's), listing real topics/features/plan terms
 * present in the competitor's extraction but absent from ours. Same
 * "real keyword-set difference, never fabricated" convention as
 * ../lib/keywordOpportunities.ts (which does the equivalent comparison
 * over TF keyword lists) — this operates over structured
 * PricingExtraction/ProductCatalogExtraction/CaseStudiesExtraction shapes
 * instead, so it can name the actual plan/product/feature phrase that's
 * missing, not just a bare keyword.
 *
 * Pure function: no network access, no DB, no LLM call. Callers
 * (routes/websiteIntelligence.ts) load the two real snapshot rows and
 * pass their `extracted_data` straight through.
 */
import { extractKeywords } from "./keywordExtraction.js";
import type { PricingExtraction } from "./structuredExtraction.js";
import type { ProductCatalogExtraction } from "./structuredExtraction.js";
import type { CaseStudiesExtraction } from "./structuredExtraction.js";

export interface GapItem {
  /** The real phrase/term found in the competitor's extraction but not ours. */
  phrase: string;
  /** Where in the competitor's extraction this phrase came from, e.g. "plans[1].features[2]". */
  sourcePath: string;
}

export interface GapResult {
  /** True only when both snapshots actually had non-empty extracted content to compare. */
  comparable: boolean;
  missingPlanFeatures: GapItem[];
  missingProducts: GapItem[];
  missingCaseStudyTopics: GapItem[];
  /** Deterministic TF-keyword-set difference across all textual fields of both snapshots, same math as keywordOpportunities.ts. */
  missingKeywords: string[];
}

const MIN_PHRASE_LEN = 3;
const MAX_ITEMS_PER_CATEGORY = 30;

function normalizePhrase(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Collects every plan-feature phrase from a PricingExtraction, each tagged
 * with its real source path (plans[i].features[j]).
 */
function planFeatureEntries(extraction: PricingExtraction | undefined): Array<{ phrase: string; path: string }> {
  if (!extraction?.plans) return [];
  const entries: Array<{ phrase: string; path: string }> = [];
  extraction.plans.forEach((plan, i) => {
    plan.features.forEach((feature, j) => {
      if (feature.length >= MIN_PHRASE_LEN) entries.push({ phrase: feature, path: `plans[${i}].features[${j}]` });
    });
  });
  return entries;
}

function productEntries(extraction: ProductCatalogExtraction | undefined): Array<{ phrase: string; path: string }> {
  if (!extraction?.products) return [];
  return extraction.products
    .map((p, i) => ({ phrase: p.name, path: `products[${i}].name` }))
    .filter((e) => e.phrase.length >= MIN_PHRASE_LEN);
}

function caseStudyEntries(extraction: CaseStudiesExtraction | undefined): Array<{ phrase: string; path: string }> {
  if (!extraction?.caseStudies) return [];
  // Use extractKeywords over each case-study/testimonial text to surface
  // real recurring topic words (e.g. "onboarding", "automation") rather
  // than comparing whole quoted sentences verbatim, which would almost
  // never match across two different companies' copy.
  const entries: Array<{ phrase: string; path: string }> = [];
  extraction.caseStudies.forEach((cs, i) => {
    for (const { keyword } of extractKeywords(cs.text, 8)) {
      entries.push({ phrase: keyword, path: `caseStudies[${i}].text` });
    }
  });
  return entries;
}

function dedupeMissing(
  ourPhrases: Set<string>,
  competitorEntries: Array<{ phrase: string; path: string }>,
): GapItem[] {
  const seen = new Set<string>();
  const result: GapItem[] = [];
  for (const entry of competitorEntries) {
    const normalized = normalizePhrase(entry.phrase);
    if (normalized.length < MIN_PHRASE_LEN) continue;
    if (ourPhrases.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ phrase: entry.phrase, sourcePath: entry.path });
    if (result.length >= MAX_ITEMS_PER_CATEGORY) break;
  }
  return result;
}

function allTextOf(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return "";
  if (Array.isArray(data)) return data.map(allTextOf).join(" ");
  if (typeof data === "object") return Object.values(data as Record<string, unknown>).map(allTextOf).join(" ");
  return "";
}

export interface SnapshotForGapAnalysis {
  snapshotType: "pricing" | "product_catalog" | "case_studies" | "positioning";
  extractedData: unknown;
}

/**
 * Compares our own latest extracted snapshot against a competitor's for
 * the same snapshot_type and lists real topics/features/products present
 * in theirs but absent from ours. Returns `comparable: false` (with all
 * lists empty — never a fabricated gap) when either snapshot has no
 * usable extracted content.
 */
export function analyzeContentGap(
  ourSnapshot: SnapshotForGapAnalysis | null,
  competitorSnapshot: SnapshotForGapAnalysis | null,
): GapResult {
  const empty: GapResult = {
    comparable: false,
    missingPlanFeatures: [],
    missingProducts: [],
    missingCaseStudyTopics: [],
    missingKeywords: [],
  };

  if (!ourSnapshot || !competitorSnapshot) return empty;
  if (ourSnapshot.snapshotType !== competitorSnapshot.snapshotType) return empty;

  const ourText = allTextOf(ourSnapshot.extractedData);
  const competitorText = allTextOf(competitorSnapshot.extractedData);
  if (ourText.trim().length === 0 || competitorText.trim().length === 0) return empty;

  const ourData = ourSnapshot.extractedData as unknown as Record<string, unknown>;
  const competitorData = competitorSnapshot.extractedData as unknown as Record<string, unknown>;

  const ourPlanFeatures = new Set(
    planFeatureEntries(ourData as unknown as PricingExtraction).map((e) => normalizePhrase(e.phrase)),
  );
  const ourProducts = new Set(
    productEntries(ourData as unknown as ProductCatalogExtraction).map((e) => normalizePhrase(e.phrase)),
  );
  const ourCaseStudyTopics = new Set(
    caseStudyEntries(ourData as unknown as CaseStudiesExtraction).map((e) => normalizePhrase(e.phrase)),
  );

  const missingPlanFeatures = dedupeMissing(
    ourPlanFeatures,
    planFeatureEntries(competitorData as unknown as PricingExtraction),
  );
  const missingProducts = dedupeMissing(
    ourProducts,
    productEntries(competitorData as unknown as ProductCatalogExtraction),
  );
  const missingCaseStudyTopics = dedupeMissing(
    ourCaseStudyTopics,
    caseStudyEntries(competitorData as unknown as CaseStudiesExtraction),
  );

  // Deterministic overall keyword-set gap across all text in both
  // snapshots — same TF math as keywordExtraction.ts/keywordOpportunities.ts.
  const ourKeywords = new Set(extractKeywords(ourText, 100).map((k) => k.keyword));
  const competitorKeywords = extractKeywords(competitorText, 100);
  const missingKeywords = competitorKeywords
    .map((k) => k.keyword)
    .filter((k) => !ourKeywords.has(k))
    .slice(0, MAX_ITEMS_PER_CATEGORY);

  return {
    comparable: true,
    missingPlanFeatures,
    missingProducts,
    missingCaseStudyTopics,
    missingKeywords,
  };
}
