import { describe, it, expect } from "vitest";
import { clusterKeywords, stemKeyword } from "../src/lib/keywordClustering.js";
import type { ExtractedKeyword } from "../src/lib/keywordExtraction.js";

function kw(keyword: string, frequency: number): ExtractedKeyword {
  return { keyword, frequency };
}

describe("stemKeyword", () => {
  it("strips common suffixes", () => {
    expect(stemKeyword("marketing")).toBe("market");
    expect(stemKeyword("marketers")).toBe("market");
    expect(stemKeyword("invoicing")).toBe("invoic");
    expect(stemKeyword("invoices")).toBe("invoic");
  });

  it("never strips below MIN_STEM_LENGTH (never reduces 'sales' to nothing)", () => {
    expect(stemKeyword("sales").length).toBeGreaterThanOrEqual(3);
  });

  it("leaves words with no matching suffix untouched", () => {
    expect(stemKeyword("platform")).toBe("platform");
  });
});

describe("clusterKeywords", () => {
  it("returns an empty array for no input", () => {
    expect(clusterKeywords([])).toEqual([]);
  });

  it("groups stem-sharing keywords into one cluster", () => {
    const keywords = [kw("marketing", 10), kw("marketer", 4), kw("marketers", 3), kw("platform", 8)];
    const clusters = clusterKeywords(keywords);

    const marketCluster = clusters.find((c) => c.keywords.some((k) => k.keyword === "marketing"));
    expect(marketCluster).toBeDefined();
    expect(marketCluster!.keywords.map((k) => k.keyword).sort()).toEqual(
      ["marketer", "marketers", "marketing"].sort(),
    );
    // Label is the highest-frequency member, not a generated name.
    expect(marketCluster!.label).toBe("marketing");
    expect(marketCluster!.totalFrequency).toBe(10 + 4 + 3);

    const platformCluster = clusters.find((c) => c.label === "platform");
    expect(platformCluster!.keywords).toHaveLength(1);
  });

  it("merges distinct stems that share a long substring", () => {
    const keywords = [kw("ecommerce", 6), kw("commerce", 5)];
    const clusters = clusterKeywords(keywords);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].keywords.map((k) => k.keyword).sort()).toEqual(["commerce", "ecommerce"]);
  });

  it("does not merge unrelated short keywords", () => {
    const keywords = [kw("api", 5), kw("saas", 5), kw("cloud", 5)];
    const clusters = clusterKeywords(keywords);
    expect(clusters).toHaveLength(3);
  });

  it("sorts clusters by total frequency desc", () => {
    const keywords = [kw("alpha", 1), kw("beta", 100)];
    const clusters = clusterKeywords(keywords);
    expect(clusters[0].label).toBe("beta");
    expect(clusters[1].label).toBe("alpha");
  });

  it("respects the limit option", () => {
    const keywords = [kw("alpha", 1), kw("beta", 2), kw("gamma", 3)];
    const clusters = clusterKeywords(keywords, { limit: 2 });
    expect(clusters).toHaveLength(2);
  });

  it("produces a stable, derived clusterKey (not a random uuid)", () => {
    const keywords = [kw("marketing", 10), kw("marketer", 4)];
    const c1 = clusterKeywords(keywords);
    const c2 = clusterKeywords(keywords);
    expect(c1[0].clusterKey).toBe(c2[0].clusterKey);
  });
});
