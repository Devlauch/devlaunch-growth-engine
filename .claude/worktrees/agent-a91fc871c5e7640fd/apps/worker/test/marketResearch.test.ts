import { describe, it, expect } from "vitest";
import { runMarketResearch, marketResearchOutputSchema } from "../src/agents/marketResearch.js";
import { MockResearchAdapter } from "../src/agents/researchAdapter.js";

describe("market-research agent", () => {
  it("returns schema-valid, clearly-mocked output", async () => {
    const output = await runMarketResearch(
      {
        industry: "education",
        geography: "United States",
        segment: "career_switchers",
        question: "What channels convert best for career switchers?",
      },
      new MockResearchAdapter(),
    );

    const parsed = marketResearchOutputSchema.safeParse(output);
    expect(parsed.success).toBe(true);
    expect(output.mock).toBe(true);
    expect(output.evidence.length).toBeGreaterThan(0);
    for (const item of output.evidence) {
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("rejects invalid input before calling the adapter", async () => {
    await expect(runMarketResearch({ industry: "" })).rejects.toThrow();
  });
});
