import { describe, it, expect } from "vitest";
import { runLeadScoring, leadScoringOutputSchema } from "../src/agents/leadScoring.js";

const rubric = {
  criteria: [
    { key: "company_size", label: "Company size fits ICP", weight: 40 },
    { key: "decision_maker", label: "Contact is a decision maker", weight: 35 },
    { key: "budget_signal", label: "Budget signal present", weight: 25 },
  ],
};

describe("lead-scoring agent", () => {
  it("awards full credit for every criterion with present evidence", async () => {
    const output = await runLeadScoring({
      leadId: "lead-1",
      rubric,
      evidence: {
        company_size: { present: true, summary: "51-200 employees", source: "discovered_organizations" },
        decision_maker: { present: true, summary: "VP of Sales", source: "discovered_contacts" },
        budget_signal: { present: true, summary: "Recently raised Series B", source: "crawl" },
      },
    });

    const parsed = leadScoringOutputSchema.safeParse(output);
    expect(parsed.success).toBe(true);
    expect(output.totalScore).toBe(100);
    expect(output.criteriaEvidence.company_size.score).toBe(40);
    expect(output.criteriaEvidence.decision_maker.score).toBe(35);
    expect(output.criteriaEvidence.budget_signal.score).toBe(25);
    for (const key of Object.keys(output.criteriaEvidence)) {
      expect(output.criteriaEvidence[key].hasEvidence).toBe(true);
    }
    expect(output.nextResearchNote).toMatch(/no further research is required/i);
  });

  it("scores zero for criteria with missing or absent evidence", async () => {
    const output = await runLeadScoring({
      leadId: "lead-2",
      rubric,
      evidence: {
        company_size: { present: true, summary: "51-200 employees" },
        decision_maker: { present: false },
        // budget_signal intentionally absent from the evidence map entirely
      },
    });

    expect(output.criteriaEvidence.company_size.score).toBe(40);
    expect(output.criteriaEvidence.decision_maker.score).toBe(0);
    expect(output.criteriaEvidence.decision_maker.hasEvidence).toBe(false);
    expect(output.criteriaEvidence.budget_signal.score).toBe(0);
    expect(output.criteriaEvidence.budget_signal.hasEvidence).toBe(false);
  });

  it("computes totalScore as a weighted percentage of criteria with evidence", async () => {
    // company_size (40) + decision_maker (35) present, budget_signal (25) missing.
    // (40 + 35) / (40 + 35 + 25) * 100 = 75
    const output = await runLeadScoring({
      leadId: "lead-3",
      rubric,
      evidence: {
        company_size: { present: true },
        decision_maker: { present: true },
        budget_signal: { present: false },
      },
    });

    expect(output.totalScore).toBe(75);
  });

  it("produces a whySummary naming which criteria had evidence and which didn't, and a nextResearchNote naming gaps", async () => {
    const output = await runLeadScoring({
      leadId: "lead-4",
      rubric,
      evidence: {
        company_size: { present: true },
        decision_maker: { present: false },
        budget_signal: { present: false },
      },
    });

    expect(output.whySummary).toMatch(/Company size fits ICP/);
    expect(output.whySummary).toMatch(/Contact is a decision maker/);
    expect(output.whySummary).toMatch(/Budget signal present/);
    expect(output.nextResearchNote).toMatch(/Contact is a decision maker/);
    expect(output.nextResearchNote).toMatch(/Budget signal present/);
    expect(output.nextResearchNote).not.toMatch(/Company size fits ICP/);
  });

  it("rejects invalid input before scoring", async () => {
    await expect(runLeadScoring({ leadId: "lead-5" })).rejects.toThrow();
  });
});
