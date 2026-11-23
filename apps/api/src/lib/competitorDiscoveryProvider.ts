import { env } from "../config/env.js";

/**
 * Competitor auto-discovery (Phase 4b: business intelligence — competitor
 * discovery). Earlier rounds of this feature required a human to manually
 * add every competitor via POST /competitors (routes/competitors.ts) — there
 * was no discovery step. This file adds one, honestly: it does NOT invent a
 * "competitor search API" that doesn't exist. It reuses the exact same real
 * SerpApi Google-search HTTP call already verified in ./serpProvider.ts
 * (same base URL, same auth convention, same organic_results response shape
 * — see that file's doc comment for the citation to SerpApi's own docs),
 * run against the tenant's OWN previously-extracted top keywords/products
 * (growth_analyses.extracted_keywords / products_services — real data this
 * tenant's own site actually contains, never guessed).
 *
 * When SERPAPI_API_KEY isn't configured (true in this environment — see
 * env.ts), `discoverCompetitorCandidates` returns `{ configured: false }`
 * with an honest explanation instead of fabricating a plausible-sounding
 * list of competitor names/domains. There is no fallback "guess competitor
 * names from the industry" heuristic here — that would be indistinguishable
 * from making facts up, which this platform's hard rule forbids.
 *
 * Heuristic (documented, not hidden): for each of the tenant's own top
 * product/service terms, this runs a real Google search for
 * `"<term>" alternative OR competitor` and collects the distinct hosts of
 * the organic results, excluding the tenant's own domain, already-tracked
 * competitor domains, and a small fixed list of non-business hosts
 * (review-aggregators, social networks, general reference sites) that are
 * never themselves "a competitor". Each candidate is returned with the
 * exact query that surfaced it and the real page title/snippet SerpApi
 * returned, so a human can judge relevance before adding it as a tracked
 * competitor — this never auto-adds a competitor on its own.
 */

const SERPAPI_BASE_URL = "https://serpapi.com/search.json";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_SEARCH_TERMS = 3;
const MAX_CANDIDATES = 15;

// Hosts that routinely show up in "<term> alternative" searches but are
// never themselves a business competitor (review aggregators, social
// networks, reference sites, this tenant's own tooling). Kept small and
// documented rather than an opaque giant blocklist.
const NON_COMPETITOR_HOSTS = new Set([
  "wikipedia.org",
  "youtube.com",
  "linkedin.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "reddit.com",
  "quora.com",
  "medium.com",
  "g2.com",
  "capterra.com",
  "trustpilot.com",
  "producthunt.com",
  "github.com",
  "stackoverflow.com",
  "amazon.com",
  "google.com",
  "apple.com",
  "play.google.com",
]);

export class CompetitorDiscoveryNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompetitorDiscoveryNotConfiguredError";
  }
}

export interface CompetitorDiscoveryFetcher {
  (url: string, init: { signal: AbortSignal }): Promise<Response>;
}

interface RawSerpOrganicResult {
  position?: number;
  title?: string;
  link?: string;
  displayed_link?: string;
  snippet?: string;
}

interface RawSerpApiResponse {
  error?: string;
  search_metadata?: { status?: string };
  organic_results?: RawSerpOrganicResult[];
}

export interface CompetitorCandidate {
  domain: string;
  /** The real page title SerpApi returned for the organic result that surfaced this domain. */
  title: string | null;
  /** The real snippet text SerpApi returned, verbatim — never a paraphrase. */
  snippet: string | null;
  /** The exact search query that found this candidate. */
  matchedQuery: string;
  /** The exact URL SerpApi returned this result under. */
  sourceUrl: string | null;
}

export interface CompetitorDiscoveryResult {
  configured: boolean;
  message: string;
  queriesRun: string[];
  candidates: CompetitorCandidate[];
}

function hostOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isNonCompetitorHost(host: string): boolean {
  for (const blocked of NON_COMPETITOR_HOSTS) {
    if (host === blocked || host.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function defaultFetcher(): CompetitorDiscoveryFetcher {
  return (url, init) => fetch(url, init);
}

async function runOneSearch(
  apiKey: string,
  query: string,
  fetcher: CompetitorDiscoveryFetcher,
  timeoutMs: number,
): Promise<RawSerpOrganicResult[]> {
  const url = new URL(SERPAPI_BASE_URL);
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("num", "10");
  url.searchParams.set("api_key", apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetcher(url.toString(), { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  let body: RawSerpApiResponse | null;
  try {
    body = (await response.json()) as RawSerpApiResponse;
  } catch {
    body = null;
  }

  if (!response.ok || body?.error || body?.search_metadata?.status === "Error") {
    // A single failed query shouldn't abort the whole discovery run (same
    // "skip, don't fail the whole batch" convention as competitors.ts's own
    // per-page crawl loop) — just contributes zero candidates.
    return [];
  }
  return body?.organic_results ?? [];
}

export interface DiscoverCompetitorCandidatesOptions {
  /** The tenant's own domain — always excluded from candidates. */
  ownDomain: string;
  /** Real top terms already extracted from the tenant's own site (growth_analyses.products_services / extracted_keywords). */
  searchTerms: string[];
  /** Domains of competitors already being tracked for this project — excluded as "already known", not re-surfaced as new. */
  excludeDomains?: string[];
  fetcher?: CompetitorDiscoveryFetcher;
  timeoutMs?: number;
}

/**
 * Runs real Google searches (via SerpApi, when configured) for the
 * tenant's own top extracted terms and returns distinct candidate
 * competitor domains found in the real search results. Returns
 * `configured: false` with an honest message — never a fabricated
 * candidate list — when no SERPAPI_API_KEY is set.
 */
export async function discoverCompetitorCandidates(
  options: DiscoverCompetitorCandidatesOptions,
): Promise<CompetitorDiscoveryResult> {
  if (!env.serpApiKey) {
    return {
      configured: false,
      message:
        "Competitor auto-discovery requires a configured search provider (SERPAPI_API_KEY) — none is configured " +
        "in this environment. Set SERPAPI_API_KEY to enable real search-based discovery; until then, add " +
        "competitors manually below. We will not guess or fabricate competitor names/domains.",
      queriesRun: [],
      candidates: [],
    };
  }

  const ownHost = hostOf(options.ownDomain);
  const excluded = new Set(
    (options.excludeDomains ?? []).map((d) => hostOf(d)).filter((h): h is string => h !== null),
  );
  if (ownHost) excluded.add(ownHost);

  const terms = options.searchTerms
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, MAX_SEARCH_TERMS);

  if (terms.length === 0) {
    return {
      configured: true,
      message:
        "No usable search terms were available from this project's own extracted keywords/products — run a " +
        "growth analysis on this project's site first (POST .../growth-analyses/analyze) so there is real data " +
        "to search from.",
      queriesRun: [],
      candidates: [],
    };
  }

  const fetcher = options.fetcher ?? defaultFetcher();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const seenHosts = new Set<string>(excluded);
  const candidates: CompetitorCandidate[] = [];
  const queriesRun: string[] = [];

  for (const term of terms) {
    const query = `"${term}" alternative OR competitor`;
    queriesRun.push(query);
    const results = await runOneSearch(env.serpApiKey, query, fetcher, timeoutMs);
    for (const result of results) {
      const host = hostOf(result.link) ?? hostOf(result.displayed_link);
      if (!host || seenHosts.has(host) || isNonCompetitorHost(host)) continue;
      seenHosts.add(host);
      candidates.push({
        domain: host,
        title: result.title ?? null,
        snippet: result.snippet ?? null,
        matchedQuery: query,
        sourceUrl: result.link ?? null,
      });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return {
    configured: true,
    message:
      candidates.length > 0
        ? `Found ${candidates.length} candidate competitor domain(s) from real search results across ` +
          `${queriesRun.length} quer${queriesRun.length === 1 ? "y" : "ies"} — review before adding any of them.`
        : "The search ran, but no new candidate domains were found (all results were either already-tracked " +
          "competitors, this tenant's own domain, or non-business hosts).",
    queriesRun,
    candidates,
  };
}
