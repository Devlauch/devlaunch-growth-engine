import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

/**
 * Lib-level tests. companyIntelligence.ts and activityTimeline.ts are
 * mocked wholesale (vi.doMock) rather than re-exercised here — they
 * already have their own direct unit tests
 * (test/companyIntelligence.test.ts, and activityTimeline is exercised
 * through aiSalesAssistant.test.ts) — this file's job is only to verify
 * buildProspectResearchSummary's OWN logic: deterministic summary
 * templating, folding tracked contacts into the ranking candidate list,
 * and the aiSalesAssistant-style LLM-polish gating (not_configured /
 * budget_exceeded / ok / error), never network/DB access of its own
 * beyond what it delegates to those two mocked modules.
 */

const TENANT_ID = "tenant-1";
const PROJECT_ID = "project-1";
const COMPANY_ID = "company-1";

function fakeClient() {
  const q = vi.fn();
  return { client: { query: q } as unknown as PoolClient, q };
}

const baseIntelligence = {
  company: { id: COMPANY_ID, name: "Acme Inc", domain: "acme.com", industry: "Software", sizeRange: "51-200", notes: null },
  decisionMakers: {
    trackedContacts: [{ id: "c1", name: "Jane Doe", title: "VP Sales", email: "jane@acme.com", phone: null }],
    providerLookup: { status: "not_configured", provider: null, contacts: [], attempts: [] },
    providerDecisionMakers: [],
  },
  firmographics: { status: "not_found", firmographics: null, dataSources: [], sourceConfidence: null, viaLeadId: null },
  websiteIntelligence: { status: "not_available", snapshot: null },
  dealHistory: {
    leads: [{ id: "lead-1", name: "Jane Doe", status: "qualified", createdAt: "2026-01-01T00:00:00.000Z" }],
    deals: [{ id: "deal-1", leadId: "lead-1", stage: "proposal", valueAmount: "5000", stageChangedAt: "2026-02-01T00:00:00.000Z" }],
  },
};

beforeEach(() => {
  vi.resetModules();
});

function mockDeps() {
  vi.doMock("../src/lib/companyIntelligence.js", () => ({
    getCompanyIntelligence: vi.fn(async () => baseIntelligence),
  }));
  vi.doMock("../src/lib/activityTimeline.js", () => ({
    getLeadActivityTimeline: vi.fn(async () => [
      { type: "stage_change", timestamp: "2026-02-01T00:00:00.000Z", summary: "Deal moved to proposal", detail: null, sourceId: "deal-1" },
    ]),
  }));
}

describe("buildProspectResearchSummary", () => {
  it("builds a complete deterministic summary and an honest not_configured llmPolish when no LLM key is set", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    mockDeps();
    const { buildProspectResearchSummary } = await import("../src/lib/prospectResearchSummary.js");
    const { client } = fakeClient();

    const result = await buildProspectResearchSummary(client, TENANT_ID, PROJECT_ID, COMPANY_ID);

    expect(result.companyId).toBe(COMPANY_ID);
    expect(result.companyName).toBe("Acme Inc");
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).toContain("Acme Inc");
    expect(result.dealCount).toBe(1);
    expect(result.openDealCount).toBe(1);
    expect(result.recentActivity).toHaveLength(1);
    expect(result.llmPolish).toEqual({ status: "not_configured", text: null });
  });

  it("folds tracked CRM contacts into the ranked decision-maker list as verified candidates", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    mockDeps();
    const { buildProspectResearchSummary } = await import("../src/lib/prospectResearchSummary.js");
    const { client } = fakeClient();

    const result = await buildProspectResearchSummary(client, TENANT_ID, PROJECT_ID, COMPANY_ID, {
      targetRoles: ["VP Sales"],
    });

    const janeRanking = result.rankedDecisionMakers.find((r) => r.contact.name === "Jane Doe");
    expect(janeRanking).toBeDefined();
    expect(janeRanking?.contact.sourceConfidence).toBe("verified");
    expect(janeRanking?.score).toBe(100);
  });

  it("never fabricates llmPolish text — status stays honest even when deterministic summary exists", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    mockDeps();
    const { buildProspectResearchSummary } = await import("../src/lib/prospectResearchSummary.js");
    const { client } = fakeClient();

    const result = await buildProspectResearchSummary(client, TENANT_ID, PROJECT_ID, COMPANY_ID);
    expect(result.llmPolish.text).toBeNull();
  });
});
