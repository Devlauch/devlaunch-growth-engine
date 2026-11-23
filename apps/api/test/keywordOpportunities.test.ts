import { describe, it, expect } from "vitest";
import { computeKeywordOpportunities } from "../src/lib/keywordOpportunities.js";

describe("computeKeywordOpportunities", () => {
  it("returns keywords competitors use that the tenant's own site doesn't, ranked by competitor count then combined frequency", () => {
    const own = [
      { keyword: "invoicing", frequency: 10 },
      { keyword: "payments", frequency: 5 },
    ];
    const competitors = [
      {
        competitorName: "Acme",
        keywords: [
          { keyword: "invoicing", frequency: 8 }, // already on own site -> excluded
          { keyword: "payroll", frequency: 6 },
          { keyword: "benefits", frequency: 2 },
        ],
      },
      {
        competitorName: "Globex",
        keywords: [
          { keyword: "payroll", frequency: 4 },
          { keyword: "onboarding", frequency: 9 },
        ],
      },
    ];

    const result = computeKeywordOpportunities(own, competitors);

    // "payroll" appears for 2 competitors (higher competitorCount) -> ranked first
    expect(result[0]).toEqual({
      keyword: "payroll",
      competitorCount: 2,
      combinedFrequency: 10,
      competitors: [
        { competitorName: "Acme", frequency: 6 },
        { competitorName: "Globex", frequency: 4 },
      ],
    });

    // "invoicing" must never appear — it's already on the tenant's own site
    expect(result.find((r) => r.keyword === "invoicing")).toBeUndefined();

    const keywords = result.map((r) => r.keyword);
    expect(keywords).toContain("onboarding");
    expect(keywords).toContain("benefits");
  });

  it("returns an empty array when there is no competitor data", () => {
    expect(computeKeywordOpportunities([], [])).toEqual([]);
  });

  it("returns an empty array when every competitor keyword is already on the tenant's own site", () => {
    const own = [{ keyword: "widgets", frequency: 1 }];
    const competitors = [{ competitorName: "Acme", keywords: [{ keyword: "widgets", frequency: 3 }] }];
    expect(computeKeywordOpportunities(own, competitors)).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const competitors = [
      {
        competitorName: "Acme",
        keywords: Array.from({ length: 30 }, (_, i) => ({ keyword: `term${i}`, frequency: 1 })),
      },
    ];
    const result = computeKeywordOpportunities([], competitors, 5);
    expect(result).toHaveLength(5);
  });
});
