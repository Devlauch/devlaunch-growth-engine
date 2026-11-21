import type { EvidenceItem } from "@devlaunch/agent-sdk";

/**
 * Pluggable research backend for the `market-research` agent. Phase 1 ships
 * only `MockResearchAdapter` (fixture data, no network calls). A later phase
 * adds `Crawl4AIResearchAdapter`, which would call a separate crawl4ai
 * Docker service over HTTP and return the same EvidenceItem[] shape — the
 * agent itself does not need to change, only which adapter it is given.
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
 * Later-phase adapter (NOT implemented in Phase 1): would call a separate
 * crawl4ai Docker service over HTTP (e.g. `POST http://crawl4ai:11235/crawl`)
 * and map its response into EvidenceItem[]. Left here only as a documented
 * extension point so the registry/agent code has a concrete place to wire
 * it in once that service exists; it deliberately throws if constructed so
 * it can never be used accidentally in Phase 1.
 */
export class Crawl4AIResearchAdapter implements ResearchAdapter {
  constructor(_opts: { baseUrl: string }) {
    throw new Error(
      "Crawl4AIResearchAdapter is not implemented in Phase 1 (see apps/worker/src/agents/researchAdapter.ts). " +
        "Use MockResearchAdapter instead.",
    );
  }

  research(): Promise<EvidenceItem[]> {
    throw new Error("Crawl4AIResearchAdapter is not implemented in Phase 1.");
  }
}
