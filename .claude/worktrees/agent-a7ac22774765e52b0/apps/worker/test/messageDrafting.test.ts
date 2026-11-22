import { describe, it, expect } from "vitest";
import { runMessageDrafting, messageDraftingOutputSchema } from "../src/agents/messageDrafting.js";

describe("message-drafting agent", () => {
  it("produces one variant per required channel, schema-valid", async () => {
    const output = await runMessageDrafting({
      leadId: "lead-1",
      approvedClaims: ["We cut onboarding time in half"],
      evidence: {
        summary: "Acme Corp recently expanded its sales team",
        facts: ["Acme Corp recently expanded its sales team", "Acme Corp uses Salesforce"],
      },
    });

    const parsed = messageDraftingOutputSchema.safeParse(output);
    expect(parsed.success).toBe(true);

    const channels = output.variants.map((v) => v.channel).sort();
    expect(channels).toEqual(["call_script", "email", "linkedin_note", "whatsapp"]);
  });

  it("grounds the email variant in the approved claim and evidence facts", async () => {
    const output = await runMessageDrafting({
      leadId: "lead-2",
      approvedClaims: ["We cut onboarding time in half"],
      evidence: {
        summary: "Acme Corp recently expanded its sales team",
        facts: ["Acme Corp recently expanded its sales team"],
      },
    });

    const email = output.variants.find((v) => v.channel === "email")!;
    expect(email.body).toContain("We cut onboarding time in half");
    expect(email.body).toContain("Acme Corp recently expanded its sales team");
    expect(email.subject).toContain("We cut onboarding time in half");
  });

  it("keeps the linkedin note under 300 characters", async () => {
    const output = await runMessageDrafting({
      leadId: "lead-3",
      approvedClaims: ["A".repeat(200)],
      evidence: {
        summary: "x".repeat(500),
        facts: ["y".repeat(500)],
      },
    });

    const linkedin = output.variants.find((v) => v.channel === "linkedin_note")!;
    expect(linkedin.body.length).toBeLessThan(300);
  });

  it("flags candidate claims with no approved-claim or evidence source as unsourced", async () => {
    const output = await runMessageDrafting({
      leadId: "lead-4",
      approvedClaims: ["We cut onboarding time in half"],
      evidence: {
        summary: "Acme Corp recently expanded its sales team",
        facts: [],
      },
    });

    expect(output.unsourcedClaims.length).toBeGreaterThan(0);
    expect(output.unsourcedClaims).toContain("the #1 solution in the market");
  });

  it("does not flag a candidate claim that is itself approved", async () => {
    const output = await runMessageDrafting({
      leadId: "lead-5",
      approvedClaims: ["the #1 solution in the market"],
      evidence: { summary: "n/a", facts: [] },
    });

    expect(output.unsourcedClaims).not.toContain("the #1 solution in the market");
  });

  it("does not flag a candidate claim that is directly backed by an evidence fact", async () => {
    const output = await runMessageDrafting({
      leadId: "lead-6",
      approvedClaims: [],
      evidence: {
        summary: "n/a",
        facts: ["Independent analysts rank us the #1 solution in the market this year"],
      },
    });

    expect(output.unsourcedClaims).not.toContain("the #1 solution in the market");
  });

  it("is deterministic across repeated calls with the same input", async () => {
    const input = {
      leadId: "lead-7",
      approvedClaims: ["We cut onboarding time in half"],
      evidence: { summary: "Acme Corp recently expanded", facts: ["Acme Corp recently expanded"] },
    };
    const first = await runMessageDrafting(input);
    const second = await runMessageDrafting(input);
    expect(first).toEqual(second);
  });
});
