import { describe, it, expect } from "vitest";
import { assembleLeadEvidence } from "../src/lib/leadEvidence.js";

describe("assembleLeadEvidence (pure)", () => {
  it("returns null when none of the three evidence sources has anything for this lead", () => {
    const result = assembleLeadEvidence({ leadScore: null, buyingSignals: [], icpMatches: [] });
    expect(result).toBeNull();
  });

  it("composes facts from present rubric criteria evidence summaries, in order, skipping absent criteria", () => {
    const result = assembleLeadEvidence({
      leadScore: {
        totalScore: 72,
        whySummary: "This lead scores 72/100 against the active rubric.",
        criteriaEvidence: {
          budget: { present: true, evidenceSummary: "Lead's custom_fields.budget is set" },
          timeline: { present: false },
          authority: { present: true, evidenceSummary: "Found 'decision maker' in discovered contact data" },
        },
      },
      buyingSignals: [],
      icpMatches: [],
    });

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("This lead scores 72/100 against the active rubric.");
    expect(result!.facts).toEqual([
      "Lead's custom_fields.budget is set",
      "Found 'decision maker' in discovered contact data",
    ]);
  });

  it("appends buying signals and the best ICP match as additional real facts", () => {
    const result = assembleLeadEvidence({
      leadScore: null,
      buyingSignals: [{ signalType: "hiring", detail: "Posted 3 sales roles", confidence: "high" }],
      icpMatches: [{ icpProfileName: "Mid-market SaaS", matchScore: 88, matchReasons: ["Matches company size band"] }],
    });

    expect(result).not.toBeNull();
    expect(result!.facts).toEqual([
      "hiring signal: Posted 3 sales roles (high confidence)",
      "Matches the 'Mid-market SaaS' ICP (88% fit: Matches company size band)",
    ]);
    // No lead_scores row -> summary falls back to the first assembled fact.
    expect(result!.summary).toBe("hiring signal: Posted 3 sales roles (high confidence)");
  });

  it("never invents a fact for a zero-score ICP match (match_score must be > 0)", () => {
    const result = assembleLeadEvidence({
      leadScore: null,
      buyingSignals: [{ signalType: "funding", detail: "Raised Series B", confidence: "medium" }],
      icpMatches: [{ icpProfileName: "Mid-market SaaS", matchScore: 0, matchReasons: [] }],
    });

    expect(result!.facts).toEqual(["funding signal: Raised Series B (medium confidence)"]);
  });
});
