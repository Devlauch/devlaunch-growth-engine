import type { EvidenceItem } from "@devlaunch/agent-sdk";
import type { CrawlOrganizationSiteOptions, CrawlOrganizationSiteResult } from "./websiteCrawler.js";
import { crawlOrganizationSite } from "./websiteCrawler.js";

/**
 * Pluggable research backend for the `market-research` agent. Phase 1 ships
 * only `MockResearchAdapter` (fixture data, no network calls). `Crawl4AIResearchAdapter`
 * (below) calls a separate crawl4ai Docker service over HTTP and returns the
 * same EvidenceItem[] shape — the agent itself does not need to change, only
 * which adapter it is given.
 */
export interface ResearchAdapter {
  research(input: {
    industry: string;
    geography: string;
    segment: string;
    question: string;
  }): Promise<EvidenceItem[]>;
}

/**
 * Phase 1 stub adapter: returns deterministic, schema-valid fixture
 * evidence. No outbound HTTP calls of any kind. Clearly NOT real research —
 * swap for `Crawl4AIResearchAdapter` (later phase) to get real crawl-backed
 * results behind the same interface.
 */
export class MockResearchAdapter implements ResearchAdapter {
  async research(input: {
    industry: string;
    geography: string;
    segment: string;
    question: string;
  }): Promise<EvidenceItem[]> {
    const now = new Date().toISOString();
    return [
      {
        source: "mock-fixture:industry-overview",
        timestamp: now,
        confidence: 0.6,
        summary: `(MOCK) General overview of the "${input.industry}" industry in ${input.geography}, relevant to the "${input.segment}" segment.`,
        url: "https://example.invalid/mock/industry-overview",
      },
      {
        source: "mock-fixture:segment-pain-points",
        timestamp: now,
        confidence: 0.55,
        summary: `(MOCK) Commonly cited pain points for the "${input.segment}" segment when evaluating: "${input.question}".`,
        url: "https://example.invalid/mock/segment-pain-points",
      },
      {
        source: "mock-fixture:competitive-landscape",
        timestamp: now,
        confidence: 0.5,
        summary: `(MOCK) Placeholder competitive-landscape note for ${input.industry} / ${input.geography}. Replace with Crawl4AIResearchAdapter output in a later phase.`,
      },
    ];
  }
}

/**
 * Real adapter backed by a crawl4ai Docker HTTP service. It implements the
 * generic `ResearchAdapter` interface (so it's a drop-in swap for
 * `MockResearchAdapter` wherever one is expected), but that generic
 * industry/geography/segment/question interface has no organization domain
 * to crawl — there is no real "crawl the web for an industry overview"
 * operation here, and this adapter refuses to fabricate one.
 *
 * The real capability this adapter provides is crawling a SPECIFIC,
 * already-known organization's own website for business information
 * (contact, about, departments, placement/training, news pages) — see
 * `crawlOrganizationSite` in ./websiteCrawler.ts, exposed here both as a
 * re-export and as the `crawlOrganizationSite` instance method below.
 *
 * Honesty contract (mirrors MockResearchAdapter's explicit `mock: true`):
 * this adapter never returns fabricated/mocked results. If the crawl4ai
 * service at `baseUrl` is unreachable or errors, it throws
 * (see CrawlServiceUnreachableError in ./websiteCrawler.ts) rather than
 * silently falling back to placeholder data.
 */
export class Crawl4AIResearchAdapter implements ResearchAdapter {
  private readonly baseUrl: string;

  constructor(opts: { baseUrl: string }) {
    if (!opts?.baseUrl) {
      throw new Error("Crawl4AIResearchAdapter requires a { baseUrl } pointing at a running crawl4ai HTTP service.");
    }
    this.baseUrl = opts.baseUrl;
  }

  /**
   * Satisfies the generic ResearchAdapter contract, but intentionally does
   * NOT attempt real research here: the generic industry/geography/segment
   * input carries no organization domain to crawl, so any "answer" this
   * method could return would necessarily be vague fabricated text — the
   * exact anti-pattern this adapter exists to avoid. Callers that have a
   * specific organization (and its domain) should call
   * `crawlOrganizationSite` directly instead.
   */
  async research(_input: {
    industry: string;
    geography: string;
    segment: string;
    question: string;
  }): Promise<EvidenceItem[]> {
    throw new Error(
      "Crawl4AIResearchAdapter.research() (the generic ResearchAdapter interface) is not supported: real " +
        "website research requires a specific organization domain to crawl, which this generic " +
        "industry/geography/segment/question interface does not provide. Call " +
        "crawlOrganizationSite(orgDomain, opts) on this adapter (or the standalone crawlOrganizationSite() " +
        "export in ./websiteCrawler.ts) for the real Crawl4AI-backed site-crawling capability.",
    );
  }

  /**
   * The real deliverable: crawl a known organization's own website for
   * business-relevant pages. See ./websiteCrawler.ts for the crawling,
   * robots.txt, rate-limiting and extraction logic.
   */
  async crawlOrganizationSite(
    orgDomain: string,
    opts?: CrawlOrganizationSiteOptions,
  ): Promise<CrawlOrganizationSiteResult> {
    return crawlOrganizationSite(this.baseUrl, orgDomain, opts);
  }
}
