/**
 * Deep, structured website extraction (Workstream E): pricing-page,
 * product-catalog, and case-study/testimonial extraction with real
 * per-field evidence (source URL + fetch timestamp), for
 * website_intelligence_snapshots (640_create_website_intelligence_snapshots.sql).
 *
 * Fetching: reuses the EXISTING `fetchCompetitorPage` (./crawl4aiClient.ts)
 * to get page HTML — this file does not reimplement HTTP fetching, and
 * every URL handed to it is also independently re-validated here via
 * `assertSafeUrl` (./ssrfGuard.ts) before any fetch happens, since this
 * module is a second, direct caller of that URL (defense in depth — the
 * same URL also gets validated again inside crawl4aiClient.ts itself).
 *
 * Parsing approach: deterministic regex/string heuristics only — same
 * "good enough, no HTML/DOM parsing dependency" convention already used by
 * ./htmlText.ts, ./siteAudit.ts, and ./positioningInsights.ts (this
 * codebase has no cheerio/jsdom dependency; see those files' doc
 * comments). Inspired by (not copied from — different language, and never
 * executed or vendored) the sibling crawl4ai repo's
 * `JsonElementExtractionStrategy`/`RegexExtractionStrategy`
 * (crawl4ai/extraction_strategy.py, Apache-2.0 licensed): a schema-like
 * "repeated block -> field list" shape for pricing cards, and a
 * regex-pattern-catalog approach (currency/money patterns) for price
 * amounts. No LLM call anywhere in this file — this is evidence
 * extraction (pull out what's really on the page), not invention.
 *
 * Honesty contract: every extractor returns a real, honestly-empty result
 * (with a `fetchError` reason) when the page can't be fetched/parsed —
 * never a fabricated plan/product/case-study standing in for a failed
 * crawl. Every returned field carries at least one `SourceEvidence` entry
 * pointing at the real source URL and fetch time.
 */
import { createHash } from "node:crypto";
import { assertSafeUrl } from "./ssrfGuard.js";
import { fetchCompetitorPage, Crawl4AINotConfiguredError, Crawl4AIUnreachableError } from "./crawl4aiClient.js";
import { stripHtml, extractTitle } from "./htmlText.js";

export interface SourceEvidence {
  /** The exact matched snippet or CSS-selector-ish description of where this field came from. */
  selectorOrText: string;
  sourceUrl: string;
  fetchedAt: string;
}

export interface ExtractionResult<T> {
  ok: boolean;
  data: T;
  evidence: SourceEvidence[];
  /** Set (and `ok: false`) when the page couldn't be fetched/had no usable content — never silently fabricated. */
  fetchError?: string;
}

// ---------------------------------------------------------------------------
// Shared page-fetch helper
// ---------------------------------------------------------------------------

async function fetchPageHonestly(
  url: string,
): Promise<{ html: string; fetchedAt: string; title?: string } | { error: string }> {
  try {
    await assertSafeUrl(url);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const result = await fetchCompetitorPage(url);
    const fetchedAt = new Date().toISOString();
    if (!result.html) {
      return { error: `No content returned for ${url} (HTTP ${result.statusCode})` };
    }
    return { html: result.html, fetchedAt, title: result.title ?? extractTitle(result.html) };
  } catch (err) {
    if (err instanceof Crawl4AINotConfiguredError || err instanceof Crawl4AIUnreachableError) {
      return { error: err.message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Pricing-page extraction
// ---------------------------------------------------------------------------

export interface PricingPlan {
  name: string;
  /** Verbatim matched price text, e.g. "$29/mo" — never reformatted/invented. */
  priceText: string;
  currency?: string;
  amount?: number;
  interval?: "month" | "year" | "one_time" | "unknown";
  /** Verbatim nearby feature bullet lines, capped. */
  features: string[];
}

export interface PricingExtraction {
  plans: PricingPlan[];
}

// Same real-world currency/amount shape as crawl4ai's RegexExtractionStrategy
// CURRENCY pattern, extended with an optional /mo /month /year /user suffix
// capture so interval can be read off the same match instead of a second pass.
const PRICE_RE =
  /([$€£])\s?(\d{1,3}(?:[,.]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(\/\s*(mo|month|yr|year|user|seat))?/gi;

// A "plan heading" is a short line (<=40 chars, no sentence punctuation)
// immediately preceding or following a price match — mirrors how pricing
// cards are laid out (Name, then Price, then feature bullets) without
// needing real DOM structure.
function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.length <= 40 && !/[.!?]$/.test(trimmed) && !PRICE_RE.test(trimmed);
}

function intervalFromSuffix(suffix: string | undefined): PricingPlan["interval"] {
  if (!suffix) return "unknown";
  const s = suffix.toLowerCase();
  if (s.includes("mo")) return "month";
  if (s.includes("yr") || s.includes("year")) return "year";
  return "unknown";
}

function parseAmount(raw: string): number | undefined {
  const normalized = raw.replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Splits plain text into non-empty lines for heading/price proximity
 * heuristics (same idea as crawl4ai's HTML->section splitting, applied to
 * already-stripped text since this codebase doesn't parse real DOM nodes).
 */
function nonEmptyLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Extracts pricing plans from a pricing page: finds every real price match
 * in the page text, and for each one, looks at the few lines immediately
 * around it for a plan-name heading and feature bullets. Deterministic,
 * no LLM. Returns an honestly-empty `plans: []` (never fabricated) when no
 * price pattern is found on the page.
 */
export async function extractPricingPage(url: string): Promise<ExtractionResult<PricingExtraction>> {
  const fetched = await fetchPageHonestly(url);
  if ("error" in fetched) {
    return { ok: false, data: { plans: [] }, evidence: [], fetchError: fetched.error };
  }

  const text = stripHtml(fetched.html);
  // Re-split on sentence-like boundaries AND raw newlines wouldn't help
  // post-stripHtml (stripHtml collapses whitespace to single spaces) — so
  // find price matches directly in the flattened text and pull a bounded
  // text window around each one for heading/feature-bullet heuristics.
  const evidence: SourceEvidence[] = [];
  const plans: PricingPlan[] = [];
  const seenPriceTexts = new Set<string>();

  let match: RegExpExecArray | null;
  PRICE_RE.lastIndex = 0;
  while ((match = PRICE_RE.exec(text)) !== null) {
    const priceText = match[0].trim();
    if (seenPriceTexts.has(priceText)) continue;
    seenPriceTexts.add(priceText);

    const windowStart = Math.max(0, match.index - 80);
    const windowEnd = Math.min(text.length, match.index + match[0].length + 160);
    const window = text.slice(windowStart, windowEnd);

    // Plan name: the short run of words immediately before the price match
    // within the window, if it looks heading-like; otherwise honestly
    // "Unnamed plan" rather than guessing.
    const before = text.slice(windowStart, match.index).trim();
    const beforeWords = before.split(/\s+/).filter(Boolean);
    const candidateHeading = beforeWords.slice(-4).join(" ");
    const name = candidateHeading.length > 0 && candidateHeading.length <= 40 ? candidateHeading : "Unnamed plan";

    // Feature bullets: short clauses after the price, split on common
    // bullet/separator punctuation actually present in the stripped text.
    const after = text.slice(match.index + match[0].length, windowEnd);
    const features = after
      .split(/\s*[•·‣▪]\s*|\s{2,}/)
      .map((f) => f.trim())
      .filter((f) => f.length > 3 && f.length <= 120)
      .slice(0, 6);

    plans.push({
      name,
      priceText,
      currency: match[1],
      amount: parseAmount(match[2]),
      interval: intervalFromSuffix(match[4]),
      features,
    });

    evidence.push({
      selectorOrText: window.trim().slice(0, 300),
      sourceUrl: url,
      fetchedAt: fetched.fetchedAt,
    });
  }

  if (plans.length === 0) {
    return {
      ok: false,
      data: { plans: [] },
      evidence: [],
      fetchError: `Fetched ${url} successfully but found no recognizable price pattern (currency symbol + amount) on the page.`,
    };
  }

  return { ok: true, data: { plans }, evidence };
}

// ---------------------------------------------------------------------------
// Product-catalog extraction
// ---------------------------------------------------------------------------

export interface ProductCatalogEntry {
  name: string;
  /** Verbatim short description line found near the product name. */
  description?: string;
}

export interface ProductCatalogExtraction {
  products: ProductCatalogEntry[];
}

// Product/service section headings this codebase's own content conventions
// already use elsewhere (see ../lib/industryTemplates.ts's own product
// terminology) — deliberately small and documented rather than a hidden
// giant list, same convention as competitorDiscoveryProvider.ts's
// NON_COMPETITOR_HOSTS.
const CATALOG_SECTION_TRIGGERS = [
  "our products",
  "our services",
  "products",
  "services",
  "solutions",
  "what we offer",
  "features",
];

/**
 * Extracts a product/service catalog from a page: finds headings/short
 * lines following one of CATALOG_SECTION_TRIGGERS and collects the next
 * run of short, heading-like lines as catalog entries, each paired with
 * the first following sentence-like line as its description when present.
 * Honestly returns `products: []` when no catalog section is found.
 */
// Matches a single HTML block-level element's own content (heading, list
// item, paragraph, or definition term/description) — used to split a
// catalog section into discrete entries by real DOM block boundaries,
// rather than by whitespace (stripHtml collapses all whitespace runs to a
// single space, so a whitespace-based split can't tell two
// same-paragraph entries apart; real markup almost always puts each
// catalog entry in its own heading/list-item/paragraph, so splitting on
// those tags is both more realistic and more reliable).
const CATALOG_BLOCK_RE = /<(h[1-6]|li|p|dt|dd)[^>]*>([\s\S]*?)<\/\1>/gi;

export async function extractProductCatalog(url: string): Promise<ExtractionResult<ProductCatalogExtraction>> {
  const fetched = await fetchPageHonestly(url);
  if ("error" in fetched) {
    return { ok: false, data: { products: [] }, evidence: [], fetchError: fetched.error };
  }

  const lowerHtml = fetched.html.toLowerCase();
  const evidence: SourceEvidence[] = [];
  const products: ProductCatalogEntry[] = [];
  const seenNames = new Set<string>();

  for (const trigger of CATALOG_SECTION_TRIGGERS) {
    const idx = lowerHtml.indexOf(trigger);
    if (idx === -1) continue;

    const windowHtml = fetched.html.slice(idx, idx + 4000);
    const blocks: string[] = [];
    CATALOG_BLOCK_RE.lastIndex = 0;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = CATALOG_BLOCK_RE.exec(windowHtml)) !== null) {
      const blockText = stripHtml(blockMatch[2]).trim();
      if (blockText.length > 0) blocks.push(blockText);
    }

    for (const candidate of blocks) {
      // A catalog-entry name: short, no terminal sentence punctuation.
      if (candidate.length > 0 && candidate.length <= 50 && !/[.!?]$/.test(candidate)) {
        const key = candidate.toLowerCase();
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        products.push({ name: candidate });
        evidence.push({
          selectorOrText: candidate,
          sourceUrl: url,
          fetchedAt: fetched.fetchedAt,
        });
        if (products.length >= 20) break;
      } else if (products.length > 0 && candidate.length > 10 && candidate.length <= 240) {
        // A longer, sentence-like block following an entry name — treat
        // it as that entry's description if it doesn't have one yet.
        const last = products[products.length - 1];
        if (!last.description) last.description = candidate;
      }
    }
    if (products.length >= 20) break;
  }

  if (products.length === 0) {
    return {
      ok: false,
      data: { products: [] },
      evidence: [],
      fetchError: `Fetched ${url} successfully but found no recognizable product/service catalog section.`,
    };
  }

  return { ok: true, data: { products }, evidence };
}

// ---------------------------------------------------------------------------
// Case-study / testimonial extraction
// ---------------------------------------------------------------------------

export interface CaseStudyEntry {
  /** Verbatim quoted testimonial sentence, or case-study headline sentence. */
  text: string;
  /** Attributed name/company when present immediately after/before the quote (e.g. "- Jane Doe, Acme Co"). */
  attribution?: string;
}

export interface CaseStudiesExtraction {
  caseStudies: CaseStudyEntry[];
}

// Real quotation-mark characters this heuristic looks for — straight and
// curly, since real sites use either.
const QUOTE_RE = /["“]([^"”]{20,400})["”]/g;
const ATTRIBUTION_RE = /^[\s-–—]*([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3}(?:,\s*[A-Za-z0-9&.,'\s-]{2,60})?)/;
const CASE_STUDY_TRIGGERS = ["case study", "success story", "customer story", "testimonial"];

/**
 * Extracts testimonial quotes (real quoted text + any immediately
 * following attribution line) and case-study headline sentences (real
 * sentences containing a CASE_STUDY_TRIGGERS phrase), verbatim — same
 * "return the real matching sentence, never summarized" convention as
 * ../lib/positioningInsights.ts's extractPricingSignals. Honestly returns
 * `caseStudies: []` when neither pattern is found.
 */
export async function extractCaseStudies(url: string): Promise<ExtractionResult<CaseStudiesExtraction>> {
  const fetched = await fetchPageHonestly(url);
  if ("error" in fetched) {
    return { ok: false, data: { caseStudies: [] }, evidence: [], fetchError: fetched.error };
  }

  const text = stripHtml(fetched.html);
  const evidence: SourceEvidence[] = [];
  const caseStudies: CaseStudyEntry[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  QUOTE_RE.lastIndex = 0;
  while ((match = QUOTE_RE.exec(text)) !== null) {
    const quote = match[1].trim();
    const key = quote.toLowerCase().slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);

    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 120);
    const attributionMatch = after.match(ATTRIBUTION_RE);
    const entry: CaseStudyEntry = { text: quote };
    if (attributionMatch) entry.attribution = attributionMatch[1].trim();
    caseStudies.push(entry);

    evidence.push({
      selectorOrText: match[0].trim().slice(0, 300),
      sourceUrl: url,
      fetchedAt: fetched.fetchedAt,
    });
    if (caseStudies.length >= 15) break;
  }

  // Sentence-level case-study/success-story mentions, same verbatim
  // "sentence that actually contains the trigger phrase" approach as
  // positioningInsights.ts's PRICING_TRIGGERS scan.
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 300);
  for (const sentence of sentences) {
    if (caseStudies.length >= 25) break;
    const lower = sentence.toLowerCase();
    if (CASE_STUDY_TRIGGERS.some((t) => lower.includes(t))) {
      const key = lower.slice(0, 160);
      if (seen.has(key)) continue;
      seen.add(key);
      caseStudies.push({ text: sentence });
      evidence.push({ selectorOrText: sentence, sourceUrl: url, fetchedAt: fetched.fetchedAt });
    }
  }

  if (caseStudies.length === 0) {
    return {
      ok: false,
      data: { caseStudies: [] },
      evidence: [],
      fetchError: `Fetched ${url} successfully but found no quoted testimonials or case-study/success-story mentions.`,
    };
  }

  return { ok: true, data: { caseStudies }, evidence };
}

// ---------------------------------------------------------------------------
// Content hashing (for websiteChangeDetection.ts)
// ---------------------------------------------------------------------------

/**
 * sha256 of a canonical (sorted-keys) JSON.stringify of `data` — stable
 * across key-insertion-order differences so the same logical structured
 * data always hashes the same way. Used for website_intelligence_snapshots
 * .content_hash (hash of extracted_data, never raw HTML — see
 * websiteChangeDetection.ts's doc comment for why).
 */
export function hashExtractedData(data: unknown): string {
  const canonical = canonicalize(data);
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}
