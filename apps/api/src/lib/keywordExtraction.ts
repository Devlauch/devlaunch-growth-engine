/**
 * Pure keyword-extraction math, mirroring
 * apps/worker/src/agents/competitorIntelligence.ts's `extractKeywords`
 * exactly (Phase 2 item 1, "Competitor Intelligence Agent"). apps/api has
 * no runtime dependency on the worker process/package (agents only execute
 * inside apps/worker today — see apps/api/package.json and the same
 * duplication pattern already used for scoreLead.ts/draftMessage.ts), so
 * this is an intentional, small duplication of a pure function rather than
 * a new cross-package dependency for one computation. Keep this in sync
 * with competitorIntelligence.ts's algorithm exactly if either changes.
 *
 * Honesty contract: this is basic TF (term-frequency, lowercased,
 * stopword-filtered word counts) over a competitor's own public pages. It
 * is NOT a paid SEO/SERP tool — it carries no search-ranking position, no
 * search volume, and no backlink data. Callers must not present it as one.
 */

export interface ExtractedKeyword {
  keyword: string;
  frequency: number;
}

// Same small, hardcoded English stopword list as the worker agent's copy.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "so", "of", "to", "in", "on", "at", "for",
  "with", "without", "by", "from", "up", "down", "out", "about", "into", "over", "after", "is", "are",
  "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "as", "we", "you",
  "your", "our", "us", "they", "their", "he", "she", "his", "her", "them", "i", "my", "me", "do", "does",
  "did", "can", "could", "will", "would", "should", "may", "might", "must", "not", "no", "yes", "all",
  "any", "each", "more", "most", "other", "some", "such", "only", "own", "same", "than", "too", "very",
  "just", "also", "here", "there", "when", "where", "who", "whom", "which", "what", "how", "why", "has",
  "have", "had", "having", "shall", "get", "gets", "got", "one", "two", "new", "us", "us.", "inc", "llc",
]);

const WORD_RE = /[a-z][a-z0-9'-]*/g;

/**
 * Pure, testable term-frequency keyword extraction: lowercases, strips
 * stopwords and very short tokens, counts frequency, and returns the top N
 * terms sorted by frequency desc then alphabetically for a stable tiebreak.
 */
export function extractKeywords(text: string, topN = 30): ExtractedKeyword[] {
  const counts = new Map<string, number>();
  const matches = text.toLowerCase().match(WORD_RE) ?? [];
  for (const word of matches) {
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([keyword, frequency]) => ({ keyword, frequency }));
}
