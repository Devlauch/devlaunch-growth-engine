import { describe, it, expect, vi } from "vitest";
import {
  enrichLead,
  buildCompanyEnrichmentWaterfall,
  DiscoveredOrganizationMatchProvider,
  NotConfiguredCompanyDataProvider,
  NotConfiguredError,
  type CompanyEnrichmentProvider,
} from "../src/lib/companyEnrichment.js";

/**
 * Milestone 3 Phase 2 completion pass: companyEnrichment.ts had zero direct
 * unit tests before this round (only ever exercised through route-level
 * mocks — flagged as a real gap in docs/FEATURE_STATUS.md's Broader
 * Workstream Audit). These tests exercise enrichLead's actual matching/
 * waterfall logic against a fake tenantDb, with no real Postgres.
 */

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const LEAD_ID = "44444444-4444-4444-4444-444444444444";

function fakeTenantDb(responses: Record<string, unknown>) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM leads")) return responses.lead ?? { rowCount: 0, rows: [] };
    if (sql.includes("normalized_domain")) return responses.byDomain ?? { rowCount: 0, rows: [] };
    if (sql.includes("normalized_name")) return responses.byName ?? { rowCount: 0, rows: [] };
    if (sql.includes("INSERT INTO company_enrichment")) return responses.upsert ?? { rowCount: 1, rows: [{}] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { query };
}

describe("buildCompanyEnrichmentWaterfall", () => {
  it("is [real deterministic match, NotConfigured paid-provider stub] — a real provider added later only needs to be prepended", () => {
    const providers = buildCompanyEnrichmentWaterfall();
    expect(providers).toHaveLength(2);
    expect(providers[0]).toBeInstanceOf(DiscoveredOrganizationMatchProvider);
    expect(providers[1]).toBeInstanceOf(NotConfiguredCompanyDataProvider);
    expect(providers[1]?.name).toBe("not_configured");
  });
});

describe("NotConfiguredCompanyDataProvider", () => {
  it("always throws NotConfiguredError — never returns a fabricated firmographic fact", async () => {
    const provider = new NotConfiguredCompanyDataProvider();
    await expect(
      provider.enrichCompany({ tenantDb: fakeTenantDb({}), tenantId: TENANT_ID, projectId: PROJECT_ID, lead: {} }),
    ).rejects.toThrow(NotConfiguredError);
  });
});

describe("DiscoveredOrganizationMatchProvider", () => {
  it("returns null (no result, not an error) when there's no email domain and no company name to match", async () => {
    const provider = new DiscoveredOrganizationMatchProvider();
    const result = await provider.enrichCompany({
      tenantDb: fakeTenantDb({}),
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      lead: {},
    });
    expect(result).toBeNull();
  });

  it("matches by email domain first and propagates the matched org's own source_confidence", async () => {
    const provider = new DiscoveredOrganizationMatchProvider();
    const matchedOrg = {
      id: "org-1",
      name: "Acme Inc",
      domain: "acme.com",
      source_confidence: "verified",
      raw_metadata: { industry: "software" },
    };
    const tenantDb = fakeTenantDb({ byDomain: { rowCount: 1, rows: [matchedOrg] } });

    const result = await provider.enrichCompany({
      tenantDb,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      lead: { email: "jane@acme.com" },
    });

    expect(result).not.toBeNull();
    expect(result?.matchedOrganizationId).toBe("org-1");
    expect(result?.domain).toBe("acme.com");
    expect(result?.sourceConfidence).toBe("verified");
    expect(result?.firmographics.matchedOrganizationName).toBe("Acme Inc");
    expect(result?.firmographics.rawMetadata).toEqual({ industry: "software" });
    expect(result?.dataSources).toContain("lead.email:domain");
    expect(result?.dataSources.some((s) => s.startsWith("discovered_organizations:domain_match"))).toBe(true);
  });

  it("falls back to normalized company-name matching when there's no email domain match", async () => {
    const provider = new DiscoveredOrganizationMatchProvider();
    const matchedOrg = { id: "org-2", name: "Beta Co", domain: null, source_confidence: "inferred", raw_metadata: {} };
    const tenantDb = fakeTenantDb({
      byDomain: { rowCount: 0, rows: [] },
      byName: { rowCount: 1, rows: [matchedOrg] },
    });

    const result = await provider.enrichCompany({
      tenantDb,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      lead: { company: "Beta Co, Inc." },
    });

    expect(result?.matchedOrganizationId).toBe("org-2");
    expect(result?.sourceConfidence).toBe("inferred");
    expect(result?.dataSources.some((s) => s.startsWith("discovered_organizations:name_match"))).toBe(true);
  });

  it("never invents firmographics beyond what the matched org's raw_metadata actually has", async () => {
    const provider = new DiscoveredOrganizationMatchProvider();
    const matchedOrg = { id: "org-3", name: "Gamma LLC", domain: "gamma.com", source_confidence: "verified", raw_metadata: { revenue: null, notes: "" } };
    const tenantDb = fakeTenantDb({ byDomain: { rowCount: 1, rows: [matchedOrg] } });

    const result = await provider.enrichCompany({
      tenantDb,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      lead: { email: "a@gamma.com" },
    });

    // null/empty-string raw_metadata keys are filtered out, not fabricated
    // into firmographics.
    expect(result?.firmographics.rawMetadata).toBeUndefined();
  });
});

describe("enrichLead", () => {
  it("throws notFound when the lead doesn't exist", async () => {
    const tenantDb = fakeTenantDb({ lead: { rowCount: 0, rows: [] } });
    await expect(enrichLead(tenantDb as any, TENANT_ID, PROJECT_ID, LEAD_ID)).rejects.toThrow(/not found/i);
  });

  it("upserts an honest empty row (unconfirmed, {} firmographics) when nothing matches and no real provider is configured", async () => {
    const tenantDb = fakeTenantDb({ lead: { rowCount: 1, rows: [{ id: LEAD_ID, email: null, company: null }] } });
    await enrichLead(tenantDb as any, TENANT_ID, PROJECT_ID, LEAD_ID);

    const insertCall = (tenantDb.query as any).mock.calls.find(([sql]: [string]) =>
      sql.includes("INSERT INTO company_enrichment"),
    );
    expect(insertCall).toBeTruthy();
    const params = insertCall[1];
    // [tenantId, projectId, leadId, matchedOrgId, domain, firmographics, dataSources, sourceConfidence]
    expect(params[3]).toBeNull(); // matched_organization_id
    expect(params[4]).toBeNull(); // domain
    expect(JSON.parse(params[5])).toEqual({}); // firmographics
    expect(JSON.parse(params[6])).toEqual([]); // data_sources
    expect(params[7]).toBe("unconfirmed"); // source_confidence
  });

  it("upserts real matched firmographics with the propagated source_confidence when a match is found", async () => {
    const matchedOrg = { id: "org-9", name: "Delta Corp", domain: "delta.com", source_confidence: "verified", raw_metadata: {} };
    const tenantDb = fakeTenantDb({
      lead: { rowCount: 1, rows: [{ id: LEAD_ID, email: "x@delta.com", company: null }] },
      byDomain: { rowCount: 1, rows: [matchedOrg] },
    });

    const result = await enrichLead(tenantDb as any, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(result.matchedOrganization).toEqual(matchedOrg);

    const insertCall = (tenantDb.query as any).mock.calls.find(([sql]: [string]) =>
      sql.includes("INSERT INTO company_enrichment"),
    );
    const params = insertCall[1];
    expect(params[3]).toBe("org-9");
    expect(params[4]).toBe("delta.com");
    expect(params[7]).toBe("verified");
  });

  it("is a drop-in extension point: a custom providers list runs before the deterministic match without changing enrichLead itself", async () => {
    const fakeRealProvider: CompanyEnrichmentProvider = {
      name: "fake-real-paid-provider",
      enrichCompany: async () => ({
        matchedOrganizationId: null,
        matchedOrganization: null,
        domain: "paid-provider.example",
        firmographics: { employeeCount: 42 },
        dataSources: ["fake-real-paid-provider:lookup"],
        sourceConfidence: "verified",
      }),
    };
    const tenantDb = fakeTenantDb({ lead: { rowCount: 1, rows: [{ id: LEAD_ID, email: null, company: null }] } });

    const result = await enrichLead(tenantDb as any, TENANT_ID, PROJECT_ID, LEAD_ID, [fakeRealProvider]);
    expect(result.enrichment).toBeTruthy();

    const insertCall = (tenantDb.query as any).mock.calls.find(([sql]: [string]) =>
      sql.includes("INSERT INTO company_enrichment"),
    );
    const params = insertCall[1];
    expect(params[4]).toBe("paid-provider.example");
    expect(JSON.parse(params[5])).toEqual({ employeeCount: 42 });
    expect(params[7]).toBe("verified");
  });
});
