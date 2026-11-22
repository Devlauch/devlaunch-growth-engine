/**
 * Tiny HTML text-extraction helpers, mirroring
 * apps/worker/src/agents/websiteCrawler.ts's `stripHtml`/`extractTitle`
 * exactly (not a full HTML parser — good enough for page text extraction).
 * apps/api has no runtime dependency on apps/worker (see
 * ../lib/crawl4aiClient.ts's doc comment and the same duplication pattern
 * already used for scoreLead.ts/draftMessage.ts), so this is an
 * intentional, small duplication rather than a new cross-package
 * dependency. Keep in sync with websiteCrawler.ts if either changes.
 */

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
