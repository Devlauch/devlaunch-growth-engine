/**
 * Worker-side structured website extraction (Workstream E) — same
 * deterministic parsing logic as apps/api/src/lib/structuredExtraction.ts,
 * duplicated here rather than imported cross-app: apps/worker has no
 * runtime dependency on apps/api (the reverse of the already-documented
 * "apps/api has no runtime dependency on apps/worker" rule — see
 * apps/api/src/lib/crawl4aiClient.ts's doc comment), and this codebase's
 * existing convention for small, genuinely-shared pure logic without a
 * shared-package home is exactly this kind of deliberate, documented
 * duplication (see keywordExtraction.ts/htmlText.ts/ssrfGuard.ts, each
 * duplicated between apps/api and apps/worker with a "keep in sync" note).
 * KEEP IN SYNC with apps/api/src/lib/structuredExtraction.ts's parsing
 * heuristics if either changes.
 *
 * Fetching: uses apps/worker's own `HttpCrawl4AIBackend`
 * (./agents/websiteCrawler.ts) — the full backend already used by
 * `crawlOrganizationSite`/`runCompetitorIntelligence` — rather than a
 * second, slimmer HTTP client, since this module lives in the same
 * process/package as that backend already.
 */
import { createHash } from "node:crypto";
import { assertSafeUrl } from "./ssrfGuard.js";
import { HttpCrawl4AIBackend, CrawlServiceUnreachableError, stripHtml, extractTitle } from "../agents/websiteCrawler.js";

export interface SourceEvidence {
  selectorOrText: string;
  sourceUrl: string;
  fetchedAt: string;
}

export interface ExtractionResult<T> {
  ok: boolean;
  data: T;
  evidence: SourceEvidence[];
  fetchError?: string;
}

async function fetchPageHonestly(
  url: string,
): Promise<{ html: string; fetchedAt: string } | { error: string }> {
  try {
    await assertSafeUrl(url);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const baseUrl = process.env.CRAWL4AI_BASE_URL;
  if (!baseUrl) {
    return { error: "CRAWL4AI_BASE_URL is not configured — cannot crawl a site without a real Crawl4AI service." };
  }

  try {
    const backend = new HttpCrawl4AIBackend(baseUrl);
    const result = await backend.fetchPage(url);
    if (!result.html) {
      return { error: `No content returned for ${url} (HTTP ${result.statusCode})` };
    }
    return { html: result.html, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (err instanceof CrawlServiceUnreachableError) return { error: err.message };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Pricing-page extraction (identical heuristic to the apps/api copy)
// ---------------------------------------------------------------------------

export interface PricingPlan {
  name: string;
  priceText: string;
  currency?: string;
  amount?: number;
  interval?: "month" | "year" | "one_time" | "unknown";
  features: string[];
}

export interface PricingExtraction {
  plans: PricingPlan[];
}

const PRICE_RE =
  /([$€£])\s?(\d{1,3}(?:[,.]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(\/\s*(mo|month|yr|year|user|seat))?/gi;

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

export async function extractPricingPage(url: string): Promise<ExtractionResult<PricingExtraction>> {
  const fetched = await fetchPageHonestly(url);
  if ("error" in fetched) {
    return { ok: false, data: { plans: [] }, evidence: [], fetchError: fetched.error };
  }

  const text = stripHtml(fetched.html);
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

    const before = text.slice(windowStart, match.index).trim();
    const beforeWords = before.split(/\s+/).filter(Boolean);
    const candidateHeading = beforeWords.slice(-4).join(" ");
    const name = candidateHeading.length > 0 && candidateHeading.length <= 40 ? candidateHeading : "Unnamed plan";

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

    evidence.push({ selectorOrText: window.trim().slice(0, 300), sourceUrl: url, fetchedAt: fetched.fetchedAt });
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
  description?: string;
}

export interface ProductCatalogExtraction {
  products: ProductCatalogEntry[];
}

const CATALOG_SECTION_TRIGGERS = ["our products", "our services", "products", "services", "solutions", "what we offer", "features"];

// Splits a catalog section by real HTML block boundaries rather than
// whitespace — see apps/api/src/lib/structuredExtraction.ts's identical
// constant doc comment for why (stripHtml collapses all whitespace runs,
// so same-paragraph entries can't be told apart by spacing alone).
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
      if (candidate.length > 0 && candidate.length <= 50 && !/[.!?]$/.test(candidate)) {
        const key = candidate.toLowerCase();
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        products.push({ name: candidate });
        evidence.push({ selectorOrText: candidate, sourceUrl: url, fetchedAt: fetched.fetchedAt });
        if (products.length >= 20) break;
      } else if (products.length > 0 && candidate.length > 10 && candidate.length <= 240) {
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
  text: string;
  attribution?: string;
}

export interface CaseStudiesExtraction {
  caseStudies: CaseStudyEntry[];
}

const QUOTE_RE = /["“]([^"”]{20,400})["”]/g;
const ATTRIBUTION_RE = /^[\s-–—]*([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3}(?:,\s*[A-Za-z0-9&.,'\s-]{2,60})?)/;
const CASE_STUDY_TRIGGERS = ["case study", "success story", "customer story", "testimonial"];

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

    evidence.push({ selectorOrText: match[0].trim().slice(0, 300), sourceUrl: url, fetchedAt: fetched.fetchedAt });
    if (caseStudies.length >= 15) break;
  }

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
// Content hashing — must match apps/api/src/lib/structuredExtraction.ts's
// hashExtractedData exactly, since both sides may write rows for the same
// target_url/snapshot_type and content_hash is compared across them.
// ---------------------------------------------------------------------------

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

// Re-exported so job code doesn't need a second import from htmlText-style helpers.
export { extractTitle };
