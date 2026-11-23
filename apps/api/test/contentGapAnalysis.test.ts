import { describe, it, expect } from "vitest";
import { analyzeContentGap } from "../src/lib/contentGapAnalysis.js";

describe("analyzeContentGap", () => {
  it("honestly reports not comparable when either snapshot is missing", () => {
    const result = analyzeContentGap(null, { snapshotType: "pricing", extractedData: { plans: [] } });
    expect(result.comparable).toBe(false);
    expect(result.missingPlanFeatures).toEqual([]);
  });

  it("honestly reports not comparable when snapshot types differ", () => {
    const ours = { snapshotType: "pricing" as const, extractedData: { plans: [{ name: "Starter", priceText: "$29/mo", features: ["Email support"] }] } };
    const theirs = { snapshotType: "product_catalog" as const, extractedData: { products: [{ name: "Analytics" }] } };
    expect(analyzeContentGap(ours, theirs).comparable).toBe(false);
  });

  it("finds real missing plan features present in competitor but not ours", () => {
    const ours = {
      snapshotType: "pricing" as const,
      extractedData: {
        plans: [{ name: "Starter", priceText: "$29/mo", features: ["Email support", "Basic reports"] }],
      },
    };
    const theirs = {
      snapshotType: "pricing" as const,
      extractedData: {
        plans: [
          { name: "Starter", priceText: "$25/mo", features: ["Email support", "SSO login", "Audit logs"] },
        ],
      },
    };
    const result = analyzeContentGap(ours, theirs);
    expect(result.comparable).toBe(true);
    const phrases = result.missingPlanFeatures.map((g) => g.phrase);
    expect(phrases).toContain("SSO login");
    expect(phrases).toContain("Audit logs");
    expect(phrases).not.toContain("Email support");
  });

  it("finds real missing products", () => {
    const ours = { snapshotType: "product_catalog" as const, extractedData: { products: [{ name: "Analytics Suite" }] } };
    const theirs = {
      snapshotType: "product_catalog" as const,
      extractedData: { products: [{ name: "Analytics Suite" }, { name: "Automation Engine" }] },
    };
    const result = analyzeContentGap(ours, theirs);
    expect(result.missingProducts.map((g) => g.phrase)).toEqual(["Automation Engine"]);
  });

  it("returns empty gap lists (not comparable:false) when both sides genuinely have the same content", () => {
    const snapshot = { snapshotType: "product_catalog" as const, extractedData: { products: [{ name: "Analytics Suite" }] } };
    const result = analyzeContentGap(snapshot, snapshot);
    expect(result.comparable).toBe(true);
    expect(result.missingProducts).toEqual([]);
  });
});
