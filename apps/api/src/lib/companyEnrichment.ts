import type { PoolClient } from "pg";
import { normalizeDomain, normalizeOrgName } from "./dedup.js";
import { Errors } from "./httpError.js";

/**
 * Company enrichment: a complementary intelligence layer on top of the
 * EXISTING rubric-based scoring system (scoring_rubrics/lead_scores, see
 * apps/api/src/routes/scoring.ts / src/lib/scoreLead.ts). This module does
 * NOT reinvent evidence matching — it reuses the exact same
 * domain-then-name match order against `discovered_organizations` that
 * scoreLead.ts's recompute route uses (via dedup.ts's normalizeDomain /
 * normalizeOrgName), and builds firmographics/data_sources honestly from
 * whatever real fields are actually found. It never invents
 * employee-count/revenue/etc numbers that weren't actually sourced.
 */

export interface CompanyEnrichmentRow {
  id: string;
  tenant_id: string;
  project_id: string;
  lead_id: string;
  matched_organization_id: string | null;
  domain: string | null;
  firmographics: Record<string, unknown>;
  data_sources: string[];
  enriched_at: string;
  created_at: string;
  updated_at: string;
}

export interface EnrichLeadResult {
  enrichment: CompanyEnrichmentRow;
  matchedOrganization: Record<string, unknown> | null;
}

/**
 * Loads the lead, attempts to match it to a discovered_organizations row
 * (domain first, then normalized company name — same order as
 * scoreLead.ts's recompute route), builds an honest firmographics/
 * data_sources payload from whatever real fields are present, and upserts
 * the company_enrichment row (one per lead).
 */
export async function enrichLead(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<EnrichLeadResult> {
  const leadResult = await tenantDb.query(
    `SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, tenantId, projectId],
  );
  if (leadResult.rowCount === 0) throw Errors.notFound("Lead not found");
  const lead = leadResult.rows[0] as Record<string, unknown>;

  const emailDomain =
    typeof lead.email === "string" && lead.email.includes("@")
      ? normalizeDomain(lead.email.split("@")[1])
      : null;
  const companyName = typeof lead.company === "string" ? normalizeOrgName(lead.company) : null;

  let matchedOrg: Record<string, unknown> | null = null;
  let matchedVia: "domain_match" | "name_match" | null = null;

  if (emailDomain) {
    const byDomain = await tenantDb.query(
      `SELECT * FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2 AND normalized_domain = $3 LIMIT 1`,
      [tenantId, projectId, emailDomain],
    );
    if (byDomain.rowCount && byDomain.rowCount > 0) {
      matchedOrg = byDomain.rows[0];
      matchedVia = "domain_match";
    }
  }
  if (!matchedOrg && companyName) {
    const byName = await tenantDb.query(
      `SELECT * FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2 AND normalized_name = $3 LIMIT 1`,
      [tenantId, projectId, companyName],
    );
    if (byName.rowCount && byName.rowCount > 0) {
      matchedOrg = byName.rows[0];
      matchedVia = "name_match";
    }
  }

  const firmographics: Record<string, unknown> = {};
  const dataSources: string[] = [];
  const domain = emailDomain ?? (typeof matchedOrg?.domain === "string" ? matchedOrg.domain : null);

  if (domain) {
    firmographics.domain = domain;
    dataSources.push(emailDomain ? "lead.email:domain" : `discovered_organizations:${matchedVia}`);
  }

  if (matchedOrg) {
    firmographics.matchedOrganizationName = matchedOrg.name;
    dataSources.push(`discovered_organizations:${matchedVia}`);

    const rawMetadata = (matchedOrg.raw_metadata ?? {}) as Record<string, unknown>;
    const presentKeys = Object.keys(rawMetadata).filter((key) => {
      const value = rawMetadata[key];
      if (value === null || value === undefined) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
      return true;
    });
    if (presentKeys.length > 0) {
      firmographics.rawMetadata = Object.fromEntries(presentKeys.map((key) => [key, rawMetadata[key]]));
      dataSources.push(`discovered_organizations:raw_metadata(${presentKeys.join(",")})`);
    }
  }

  const upserted = await tenantDb.query(
    `INSERT INTO company_enrichment (tenant_id, project_id, lead_id, matched_organization_id, domain, firmographics, data_sources, enriched_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now())
     ON CONFLICT (lead_id) DO UPDATE SET
       matched_organization_id = EXCLUDED.matched_organization_id,
       domain = EXCLUDED.domain,
       firmographics = EXCLUDED.firmographics,
       data_sources = EXCLUDED.data_sources,
       enriched_at = EXCLUDED.enriched_at
     RETURNING *`,
    [
      tenantId,
      projectId,
      leadId,
      matchedOrg ? (matchedOrg.id as string) : null,
      domain,
      JSON.stringify(firmographics),
      JSON.stringify(dataSources),
    ],
  );

  return {
    enrichment: upserted.rows[0] as CompanyEnrichmentRow,
    matchedOrganization: matchedOrg,
  };
}
