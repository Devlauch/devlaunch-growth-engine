import type { PoolClient } from "pg";
import { normalizeDomain, normalizeOrgName } from "./dedup.js";
import { Errors } from "./httpError.js";
import { runProviderWaterfall } from "./providerWaterfall.js";

/**
 * Company enrichment: a complementary intelligence layer on top of the
 * EXISTING rubric-based scoring system (scoring_rubrics/lead_scores, see
 * apps/api/src/routes/scoring.ts / src/lib/scoreLead.ts).
 *
 * Milestone 3 Phase 2 completion pass: this now follows the exact same
 * pluggable-provider convention as decisionMakerProvider.ts/
 * keywordRankingStub.ts, reusing the generic providerWaterfall.ts rather
 * than a second bespoke orchestrator:
 *
 *   1. `CompanyEnrichmentProvider` — the stable interface a real paid
 *      company-data provider (Clearbit/BuiltWith/Crunchbase/etc.) implements
 *      later, without any caller needing to change.
 *   2. `DiscoveredOrganizationMatchProvider` — the one REAL implementation
 *      available today. It reuses the exact same domain-then-name match
 *      order against `discovered_organizations` that scoreLead.ts's
 *      recompute route uses (via dedup.ts's normalizeDomain/
 *      normalizeOrgName), and builds firmographics/data_sources honestly
 *      from whatever real fields are actually found. It never invents
 *      employee-count/revenue/etc numbers that weren't actually sourced.
 *   3. `NotConfiguredCompanyDataProvider` — an honest stand-in for a paid
 *      provider we don't have credentials for. Always throws rather than
 *      ever returning a fabricated firmographic fact.
 *
 * Swapping in a real paid provider later is a drop-in: implement
 * `CompanyEnrichmentProvider` and prepend it in `buildCompanyEnrichmentWaterfall`
 * — `enrichLead` below doesn't change at all.
 */

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export type SourceConfidence = "verified" | "inferred" | "unconfirmed";

export interface CompanyEnrichmentRow {
  id: string;
  tenant_id: string;
  project_id: string;
  lead_id: string;
  matched_organization_id: string | null;
  domain: string | null;
  firmographics: Record<string, unknown>;
  data_sources: string[];
  source_confidence: SourceConfidence;
  enriched_at: string;
  created_at: string;
  updated_at: string;
}

export interface EnrichLeadResult {
  enrichment: CompanyEnrichmentRow;
  matchedOrganization: Record<string, unknown> | null;
}

/** A single provider's enrichment output. Never fabricated — every field
 * must trace back to something the provider actually found. `null` means
 * "this provider has nothing to add" (the waterfall's honest "no result",
 * distinct from throwing NotConfiguredError). */
export interface CompanyEnrichmentCandidate {
  matchedOrganizationId: string | null;
  matchedOrganization: Record<string, unknown> | null;
  domain: string | null;
  firmographics: Record<string, unknown>;
  dataSources: string[];
  sourceConfidence: SourceConfidence;
}

export interface CompanyEnrichmentLookupInput {
  tenantDb: Pick<PoolClient, "query">;
  tenantId: string;
  projectId: string;
  lead: Record<string, unknown>;
}

/** Pluggable backend for company enrichment. Implement this against a real
 * paid provider (Clearbit, BuiltWith, Crunchbase, etc.) to back enrichment
 * with that provider — the rest of the app only ever depends on this
 * interface. */
export interface CompanyEnrichmentProvider {
  /** Stable, human-readable provider name, recorded in the waterfall's
   * `answeredBy` / in company_enrichment's data_sources. */
  readonly name: string;
  enrichCompany(input: CompanyEnrichmentLookupInput): Promise<CompanyEnrichmentCandidate | null>;
}

/**
 * The real, free implementation available today: matches a lead to a
 * `discovered_organizations` row by email domain first, then normalized
 * company name (same order as scoreLead.ts's recompute route), and builds
 * an honest firmographics/data_sources payload from whatever real fields
 * are actually present. Returns `null` (not an error) when there's nothing
 * at all to enrich from (no email domain and no name match) — a genuine
 * "this provider looked and found nothing", not a failure.
 */
export class DiscoveredOrganizationMatchProvider implements CompanyEnrichmentProvider {
  readonly name = "discovered_organizations_match";

  async enrichCompany(input: CompanyEnrichmentLookupInput): Promise<CompanyEnrichmentCandidate | null> {
    const { tenantDb, tenantId, projectId, lead } = input;

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

    const domain = emailDomain ?? (typeof matchedOrg?.domain === "string" ? (matchedOrg.domain as string) : null);
    if (!domain && !matchedOrg) {
      // Nothing real to enrich from — honest "no result", lets the
      // waterfall fall through to the next provider (if any).
      return null;
    }

    const firmographics: Record<string, unknown> = {};
    const dataSources: string[] = [];

    if (domain) {
      firmographics.domain = domain;
      dataSources.push(emailDomain ? "lead.email:domain" : `discovered_organizations:${matchedVia}`);
    }

    // The matched organization's own source_confidence (verified/inferred/
    // unconfirmed, see 268_add_prospect_discovery_fields.sql) is the
    // strongest honest confidence signal available for this enrichment —
    // propagate it rather than defaulting to 'unconfirmed' when we do have
    // a confirmed match. A domain match with no matchedOrg row (email
    // domain only, nothing in discovered_organizations) stays 'unconfirmed'
    // since nothing actually vouches for it.
    let sourceConfidence: SourceConfidence = "unconfirmed";

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

      const orgConfidence = matchedOrg.source_confidence as SourceConfidence | undefined;
      if (orgConfidence === "verified" || orgConfidence === "inferred") {
        sourceConfidence = orgConfidence;
      }
    }

    return {
      matchedOrganizationId: matchedOrg ? (matchedOrg.id as string) : null,
      matchedOrganization: matchedOrg,
      domain,
      firmographics,
      dataSources,
      sourceConfidence,
    };
  }
}

/**
 * Honest stand-in for a licensed company-data provider we don't have
 * credentials for in this environment. Always throws — never returns a
 * fabricated firmographic fact (employee count, revenue, tech stack,
 * etc.).
 */
export class NotConfiguredCompanyDataProvider implements CompanyEnrichmentProvider {
  constructor(
    private readonly providerName = "company data enrichment provider (e.g. Clearbit/BuiltWith/Crunchbase)",
  ) {}

  readonly name = "not_configured";

  async enrichCompany(_input: CompanyEnrichmentLookupInput): Promise<never> {
    throw new NotConfiguredError(
      `${this.providerName} is not configured (no API key available in this environment). ` +
        `Implement CompanyEnrichmentProvider against a real provider and add it to the waterfall ` +
        `once credentials are available. Refusing to fabricate a firmographic fact.`,
    );
  }
}

/**
 * The company-enrichment provider waterfall used in production. The real
 * deterministic match against discovered_organizations runs first (it's
 * free and already proven); a real paid provider, once credentials exist,
 * is added here (typically prepended, so it only has to fill gaps the
 * deterministic match leaves — see `enrichCompany`'s "returns null" case)
 * without `enrichLead` below changing at all, since it only ever depends
 * on the `CompanyEnrichmentProvider` interface via `runProviderWaterfall`.
 * Exported (rather than inlined) so a test or an alternate caller can swap
 * it out without reimplementing the wiring.
 */
export function buildCompanyEnrichmentWaterfall(): CompanyEnrichmentProvider[] {
  return [new DiscoveredOrganizationMatchProvider(), new NotConfiguredCompanyDataProvider()];
}

/**
 * Loads the lead, runs the company-enrichment provider waterfall (see
 * buildCompanyEnrichmentWaterfall) against it, and upserts the
 * company_enrichment row (one per lead) with an honest source_confidence
 * tag. When every provider is either not configured or genuinely finds
 * nothing, the row is still written (firmographics `{}`, data_sources
 * `[]`, source_confidence `'unconfirmed'`) so "enrichment was attempted and
 * came back empty" is itself recorded, distinct from "never attempted".
 */
export async function enrichLead(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  leadId: string,
  providers: CompanyEnrichmentProvider[] = buildCompanyEnrichmentWaterfall(),
): Promise<EnrichLeadResult> {
  const leadResult = await tenantDb.query(
    `SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, tenantId, projectId],
  );
  if (leadResult.rowCount === 0) throw Errors.notFound("Lead not found");
  const lead = leadResult.rows[0] as Record<string, unknown>;

  const outcome = await runProviderWaterfall<CompanyEnrichmentLookupInput, CompanyEnrichmentCandidate | null>(
    providers.map((p) => ({ name: p.name, run: (i) => p.enrichCompany(i) })),
    { tenantDb, tenantId, projectId, lead },
    { isEmpty: (result) => result === null },
  );

  const candidate = outcome.result;

  const upserted = await tenantDb.query(
    `INSERT INTO company_enrichment (tenant_id, project_id, lead_id, matched_organization_id, domain, firmographics, data_sources, source_confidence, enriched_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, now())
     ON CONFLICT (lead_id) DO UPDATE SET
       matched_organization_id = EXCLUDED.matched_organization_id,
       domain = EXCLUDED.domain,
       firmographics = EXCLUDED.firmographics,
       data_sources = EXCLUDED.data_sources,
       source_confidence = EXCLUDED.source_confidence,
       enriched_at = EXCLUDED.enriched_at
     RETURNING *`,
    [
      tenantId,
      projectId,
      leadId,
      candidate?.matchedOrganizationId ?? null,
      candidate?.domain ?? null,
      JSON.stringify(candidate?.firmographics ?? {}),
      JSON.stringify(candidate?.dataSources ?? []),
      candidate?.sourceConfidence ?? "unconfirmed",
    ],
  );

  return {
    enrichment: upserted.rows[0] as CompanyEnrichmentRow,
    matchedOrganization: candidate?.matchedOrganization ?? null,
  };
}
