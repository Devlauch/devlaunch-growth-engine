import { extractKeywords } from "./keywordExtraction.js";

/**
 * Pure page-diffing logic for the Competitor Intelligence Agent (Phase 2
 * item 1). Given the pages captured in a competitor's previous snapshot and
 * its new one, decides which `competitor_changes` rows to write. Kept as a
 * pure, DB-free function so it's directly unit-testable (see
 * apps/api/test/competitors.test.ts) — apps/api/src/routes/competitors.ts
 * only wires it up to real snapshot rows.
 *
 * `diffSummary` is always real, templated text built from counts actually
 * computed here (a keyword-overlap percentage plus a word-count delta) —
 * never an LLM-fabricated narrative.
 */

export type CompetitorChangeType = "new_page" | "content_changed" | "page_removed";

export interface SnapshotPage {
  url: string;
  pageType: string;
  title?: string;
  extractedText: string;
  contentHash: string;
}

export interface DetectedChange {
  changeType: CompetitorChangeType;
  pageUrl: string;
  diffSummary: string;
}

function wordCount(text: string): number {
  return (text.trim().match(/\S+/g) ?? []).length;
}

/** Percentage (0-100) of each page's top-50 keywords that are shared. */
function keywordOverlapPercent(beforeText: string, afterText: string): number {
  const beforeKeywords = new Set(extractKeywords(beforeText, 50).map((k) => k.keyword));
  const afterKeywords = new Set(extractKeywords(afterText, 50).map((k) => k.keyword));
  const union = new Set<string>([...beforeKeywords, ...afterKeywords]);
  if (union.size === 0) return 100;
  let shared = 0;
  for (const keyword of beforeKeywords) {
    if (afterKeywords.has(keyword)) shared += 1;
  }
  return Math.round((shared / union.size) * 100);
}

function contentChangeSummary(before: SnapshotPage, after: SnapshotPage): string {
  const overlapPct = keywordOverlapPercent(before.extractedText, after.extractedText);
  const beforeWords = wordCount(before.extractedText);
  const afterWords = wordCount(after.extractedText);
  const wordDelta = afterWords - beforeWords;
  const direction = wordDelta === 0 ? "unchanged" : wordDelta > 0 ? `+${wordDelta}` : `${wordDelta}`;
  return (
    `${overlapPct}% of top extracted keywords are unchanged; word count went from ${beforeWords} to ${afterWords} ` +
    `(${direction} words).`
  );
}

/**
 * Compares the page set of a competitor's previous snapshot (or `null` if
 * this is the first-ever crawl) against its newest snapshot's pages and
 * returns the changes to record.
 */
export function detectCompetitorChanges(
  previousPages: SnapshotPage[] | null,
  currentPages: SnapshotPage[],
): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const previousByUrl = new Map((previousPages ?? []).map((p) => [p.url, p]));
  const currentByUrl = new Map(currentPages.map((p) => [p.url, p]));

  for (const page of currentPages) {
    const previous = previousByUrl.get(page.url);
    if (!previous) {
      changes.push({
        changeType: "new_page",
        pageUrl: page.url,
        diffSummary: `New page discovered at ${page.url} (not present in the prior crawl).`,
      });
      continue;
    }
    if (previous.contentHash !== page.contentHash) {
      changes.push({
        changeType: "content_changed",
        pageUrl: page.url,
        diffSummary: contentChangeSummary(previous, page),
      });
    }
  }

  if (previousPages) {
    for (const previous of previousPages) {
      if (!currentByUrl.has(previous.url)) {
        changes.push({
          changeType: "page_removed",
          pageUrl: previous.url,
          diffSummary: `${previous.url} was present in the prior crawl but was not found this time.`,
        });
      }
    }
  }

  return changes;
}
