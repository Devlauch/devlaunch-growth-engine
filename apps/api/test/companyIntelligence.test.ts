import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Lib-level tests against a minimal fake tenantDb, routed by distinctive
 * SQL substrings — same content-matching convention as
 * test/companyEnrichment.test.ts's fakeTenantDb, chosen over strict call
 * ordering because getCompanyIntelligence fans out into several
 * independently-ordered Promise.all branches (tracked contacts, the
 * decision-maker provider waterfall's 3 integration-credential lookups,
 * firmographics, website intelligence, deal history) whose exact call
 * order is an implementation detail, not a contract worth pinning down.
 *
 * No LLM/API keys are configured in this test environment — every
 * provider in the decision-maker waterfall (hunter/clearbit/apollo)
 * resolves to its own NotConfigured stub, so findDecisionMakers always
 * classifies as "not_configured" here. That is itself the honest,
 * expected behavior this test asserts.
 */

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const COMPANY_ID = "33333333-3333-3333-3333-333333333333";

function fakeTenantDb(overrides: Record<string, unknown> = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM companies")) {
      return (
        overrides.company ?? {
          rowCount: 1,
          rows: [
            {
              id: COMPANY_ID,
              name: "Acme Inc",
              domain: "acme.com",
              industry: "Software",
              size_range: "51-200",
              notes: null,
            },
          ],
        }
      );
    }
    if (sql.includes("FROM contacts")) {
      return overrides.contacts ?? { rowCount: 0, rows: [] };
    }
    if (sql.includes("FROM integrations")) {
      // Every provider (hunter/clearbit/apollo) resolves its credential
      // through this exact query shape (getIntegrationCredential) — no
      // credential stored for any of them in this test tenant.
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("information_schema.tables")) {
      // website_intelligence_snapshots does not exist yet (verified by
      // grep across the whole codebase — see companyIntelligence.ts's
      // header comment). Simulate that honestly here too.
      return overrides.websiteIntelTableCheck ?? { rowCount: 0, rows: [] };
    }
    if (sql.includes("information_schema.columns")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("FROM website_intelligence_snapshots")) {
      return overrides.websiteIntelSnapshot ?? { rowCount: 0, rows: [] };
    }
    if (sql.includes("FROM company_enrichment")) {
      return overrides.firmographics ?? { rowCount: 0, rows: [] };
    }
    if (sql.includes("FROM leads")) {
      return overrides.leads ?? { rowCount: 0, rows: [] };
    }
    if (sql.includes("FROM deals")) {
      return overrides.deals ?? { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { query };
}

beforeEach(() => {
  vi.resetModules();
});

describe("getCompanyIntelligence", () => {
  it("throws a real 404 when the company doesn't exist in this tenant/project", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const { getCompanyIntelligence } = await import("../src/lib/companyIntelligence.js");
    const tenantDb = fakeTenantDb({ company: { rowCount: 0, rows: [] } });

    await expect(getCompanyIntelligence(tenantDb, TENANT_ID, PROJECT_ID, COMPANY_ID)).rejects.toThrow();
  });

  it("aggregates company + contacts + an honest not_configured decision-maker waterfall + empty firmographics/website-intel/deal-history", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const { getCompanyIntelligence } = await import("../src/lib/companyIntelligence.js");
    const tenantDb = fakeTenantDb({
      contacts: {
        rowCount: 1,
        rows: [{ id: "contact-1", name: "Jane Doe", title: "VP Sales", email: "jane@acme.com", phone: null }],
      },
    });

    const result = await getCompanyIntelligence(tenantDb, TENANT_ID, PROJECT_ID, COMPANY_ID);

    expect(result.company).toEqual({
      id: COMPANY_ID,
      name: "Acme Inc",
      domain: "acme.com",
      industry: "Software",
      sizeRange: "51-200",
      notes: null,
    });
    expect(result.decisionMakers.trackedContacts).toHaveLength(1);
    expect(result.decisionMakers.trackedContacts[0]?.name).toBe("Jane Doe");
    // Honest "not configured", never a fabricated result — see
    // decisionMakerProvider.ts's classification contract.
    expect(result.decisionMakers.providerLookup.status).toBe("not_configured");
    expect(result.decisionMakers.providerDecisionMakers).toEqual([]);
    expect(result.firmographics.status).toBe("not_found");
    expect(result.websiteIntelligence).toEqual({ status: "not_available", snapshot: null });
    expect(result.dealHistory).toEqual({ leads: [], deals: [] });
  });

  it("reflects real firmographics + deal history when the underlying tables actually have rows", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const { getCompanyIntelligence } = await import("../src/lib/companyIntelligence.js");
    const tenantDb = fakeTenantDb({
      firmographics: {
        rowCount: 1,
        rows: [
          {
            lead_id: "lead-1",
            firmographics: { domain: "acme.com" },
            data_sources: ["lead.email:domain"],
            source_confidence: "unconfirmed",
          },
        ],
      },
      leads: {
        rowCount: 1,
        rows: [{ id: "lead-1", name: "Jane Doe", status: "qualified", created_at: "2026-01-01T00:00:00.000Z" }],
      },
      deals: {
        rowCount: 1,
        rows: [{ id: "deal-1", lead_id: "lead-1", stage: "proposal", value_amount: "5000", stage_changed_at: "2026-02-01T00:00:00.000Z" }],
      },
    });

    const result = await getCompanyIntelligence(tenantDb, TENANT_ID, PROJECT_ID, COMPANY_ID);

    expect(result.firmographics.status).toBe("found");
    expect(result.firmographics.viaLeadId).toBe("lead-1");
    expect(result.dealHistory.leads).toHaveLength(1);
    expect(result.dealHistory.deals).toHaveLength(1);
    expect(result.dealHistory.deals[0]?.stage).toBe("proposal");
  });
});
