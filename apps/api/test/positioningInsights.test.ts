import { describe, it, expect } from "vitest";
import { extractPricingSignals, buildPricingSummaryLine } from "../src/lib/positioningInsights.js";
import type { SnapshotPage } from "../src/lib/competitorChangeDetection.js";

function page(url: string, extractedText: string): SnapshotPage {
  return { url, pageType: "pricing", extractedText, contentHash: "irrelevant" };
}

describe("extractPricingSignals", () => {
  it("returns real, verbatim sentences that mention pricing/plan trigger phrases", () => {
    const pages = [
      page(
        "https://competitor.com/pricing",
        "Our Pro plan starts at $49/month per user. Enterprise plan pricing is available on request. " +
          "We help teams ship faster.",
      ),
    ];
    const signals = extractPricingSignals(pages);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].sentence).toContain("Our Pro plan starts at $49/month per user.");
    expect(signals[0].pageUrl).toBe("https://competitor.com/pricing");
    // Sentence with no pricing trigger must not be included.
    expect(signals.some((s) => s.sentence.includes("We help teams ship faster"))).toBe(false);
  });

  it("returns an empty array (never a fabricated signal) when no trigger phrase is present", () => {
    const pages = [page("https://competitor.com/about", "We are a company that builds software for teams.")];
    expect(extractPricingSignals(pages)).toEqual([]);
  });

  it("dedupes near-identical sentences across pages", () => {
    const pages = [
      page("https://competitor.com/pricing", "Plans start at $10/month."),
      page("https://competitor.com/pricing-old", "Plans start at $10/month."),
    ];
    expect(extractPricingSignals(pages)).toHaveLength(1);
  });

  it("respects the limit parameter", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Plan tier ${i} costs $${i}/month.`).join(" ");
    const pages = [page("https://competitor.com/pricing", text)];
    expect(extractPricingSignals(pages, 3)).toHaveLength(3);
  });
});

describe("buildPricingSummaryLine", () => {
  it("reports an honest zero-signal message", () => {
    expect(buildPricingSummaryLine([])).toMatch(/no pricing\/plan language/i);
  });

  it("reports the real count found", () => {
    const line = buildPricingSummaryLine([
      { sentence: "Plans start at $10/month.", pageUrl: "https://competitor.com/pricing" },
    ]);
    expect(line).toMatch(/^1 pricing\/plan sentence\(s\) found/);
  });
});
