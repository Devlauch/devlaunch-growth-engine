import type { PoolClient } from "pg";
import { Errors } from "./httpError.js";
import {
  findDecisionMakers,
  buildDecisionMakerWaterfallForTenant,
  type DecisionMakerCandidate,
  type DecisionMakerLookupOutcome,
} from "./decisionMakerProvider.js";

/**
 * companyIntelligence.ts: Workstream G1 — a READ-AGGREGATING function over
 * data this codebase already collects for a company. It is NOT a new
 * source of truth for company facts: every field below is either a direct
 * read of an existing row, or the direct, unmodified output of the
 * EXISTING decision-maker provider waterfall (decisionMakerProvider.ts).
 * Nothing here fabricates a name/title/firmographic fact, and nothing
 * duplicates data another table already owns.
 *
 * Data model note (verified against the actual migrations/routes, not
 * guessed): `companies` (302_create_companies.sql) is the first-class CRM
 * company entity (apps/api/src/routes/companies.ts). It is NOT the same
 * row as `discovered_organizations` (the discovery-pipeline org table the
 * decision-maker waterfall and company_enrichment key off of) — there is
 * no FK between them today. This function bridges that gap the same
 * honest way companyEnrichment.ts's DiscoveredOrganizationMatchProvider
 * already does: by domain, then by normalized name — never by invented
 * identity.
 *
 * Sources aggregated here:
 *   1. The `companies` row itself (name/domain/industry/size_range/notes).
 *   2. Decision-makers: (a) real tracked `contacts` rows linked to this
 *      company via contacts.company_id (307_create_contacts.sql) — CRM
 *      data a rep entered directly — PLUS (b) a live run of the existing
 *      decision-maker provider waterfall (decisionMakerProvider.ts),
 *      keyed off this company's name/domain, so a tenant also sees
 *      provider-sourced candidates even before anyone has manually added a
 *      contact. The two lists are kept distinct (`trackedContacts` vs
 *      `providerDecisionMakers`) rather than silently merged, since a
 *      tracked contact is a confirmed CRM record and a provider candidate
 *      may be `inferred`/`unconfirmed` — collapsing that distinction would
 *      lose real provenance.
 *   3. Firmographics: company_enrichment (companyEnrichment.ts's existing
 *      table/waterfall), joined via a lead that belongs to this company
 *      (leads.company_id, 303_add_company_id_to_leads.sql) — the one path
 *      company_enrichment is reachable from today, since it is keyed by
 *      lead_id, not company_id. Best-effort: a company with no linked
 *      leads yet (or no enrichment run for any of them) simply has
 *      `firmographics: null`, never a guess.
 *   4. Website intelligence: `website_intelligence_snapshots` — grepped
 *      the whole codebase for this table/migration and it does not exist
 *      yet (no sibling workstream has built it as of this writing). This
 *      join is therefore fully optional/best-effort: `getCompanyIntelligence`
 *      probes `information_schema.tables` at call time and only queries it
 *      when present, so this function starts returning real snapshot data
 *      automatically the moment that table is added, with zero changes
 *      required here. Until then `websiteIntelligence` is always
 *      `{ status: "not_available", snapshot: null }` — an honest, visible
 *      gap, not a silent omission.
 *   5. Deal/lead history: every `leads` row with `company_id` = this
 *      company, and every `deals` row for those leads (278_create_deals.sql),
 *      the existing CRM pipeline tables — reused directly, not duplicated.
 *
 * No new source-of-truth table is created for any of this (see
 * decisionMakerIdentification.ts / prospectResearchSummary.ts siblings,
 * same rule). This file deliberately also adds no cache table: every query
 * here is a handful of indexed lookups (companies.id PK,
 * idx_contacts_tenant_project_company_id, idx_leads_company_id,
 * idx_deals_lead_id) against small, tenant-scoped result sets, so a cache
 * would add write-complexity (invalidation on every contact/deal/lead
 * change) for a read path that is already fast. If this is ever called
 * from a high-traffic, low-latency path (e.g. inline in a list view
 * rendering hundreds of companies) rather than a single company-detail
 * view, that would be the trigger to revisit a cache.
 */

export interface TrackedContactRow {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
}

export type WebsiteIntelligenceStatus = "not_available" | "no_snapshot" | "found";

export interface WebsiteIntelligenceResult {
  status: WebsiteIntelligenceStatus;
  snapshot: Record<string, unknown> | null;
}

export interface FirmographicsResult {
  status: "found" | "not_found";
  firmographics: Record<string, unknown> | null;
  dataSources: string[];
  sourceConfidence: string | null;
  /** Which lead this firmographic data was reached through — for
   * auditability, since company_enrichment is keyed by lead_id, not
   * company_id. */
  viaLeadId: string | null;
}

export interface CompanyDealSummary {
  id: string;
  leadId: string;
  stage: string;
  valueAmount: string | null;
  stageChangedAt: string;
}

export interface CompanyLeadSummary {
  id: string;
  name: string | null;
  status: string | null;
  createdAt: string;
}

export interface CompanyIntelligenceResult {
  company: {
    id: string;
    name: string;
    domain: string | null;
    industry: string | null;
    sizeRange: string | null;
    notes: string | null;
  };
  decisionMakers: {
    trackedContacts: TrackedContactRow[];
    providerLookup: DecisionMakerLookupOutcome;
    providerDecisionMakers: DecisionMakerCandidate[];
  };
  firmographics: FirmographicsResult;
  websiteIntelligence: WebsiteIntelligenceResult;
  dealHistory: {
    leads: CompanyLeadSummary[];
    deals: CompanyDealSummary[];
  };
}

async function loadCompanyOrThrow(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  companyId: string,
) {
  const result = await tenantDb.query(
    `SELECT id, name, domain, industry, size_range, notes
     FROM companies WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [companyId, tenantId, projectId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Company not found");
  return result.rows[0] as {
    id: string;
    name: string;
    domain: string | null;
    industry: string | null;
    size_range: string | null;
    notes: string | null;
  };
}

async function loadTrackedContacts(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  companyId: string,
): Promise<TrackedContactRow[]> {
  const result = await tenantDb.query(
    `SELECT id, name, title, email, phone FROM contacts
     WHERE tenant_id = $1 AND project_id = $2 AND company_id = $3
     ORDER BY created_at DESC
     LIMIT 200`,
    [tenantId, projectId, companyId],
  );
  return result.rows as TrackedContactRow[];
}

/**
 * Best-effort website_intelligence_snapshots lookup. This table does not
 * exist in this codebase as of this writing (verified by grep across the
 * whole repo) — see this file's header comment. Probes
 * information_schema.tables first so a missing table degrades to
 * `"not_available"` rather than throwing, and so this starts working the
 * moment a sibling workstream adds the table, without any code change
 * here.
 */
async function loadWebsiteIntelligence(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  companyId: string,
  domain: string | null,
): Promise<WebsiteIntelligenceResult> {
  try {
    const tableCheck = await tenantDb.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'website_intelligence_snapshots' LIMIT 1`,
    );
    if (tableCheck.rowCount === 0) {
      return { status: "not_available", snapshot: null };
    }

    // Table exists (a sibling workstream has shipped it) — join as
    // leniently as possible: prefer a direct company_id column if present,
    // otherwise fall back to domain. Both branches are guarded by a
    // second information_schema probe so an unexpected column shape still
    // degrades to "not_available" instead of throwing.
    const columnCheck = await tenantDb.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'website_intelligence_snapshots'`,
    );
    const columns = new Set((columnCheck.rows as { column_name: string }[]).map((r) => r.column_name));

    if (columns.has("company_id")) {
      const snap = await tenantDb.query(
        `SELECT * FROM website_intelligence_snapshots
         WHERE tenant_id = $1 AND project_id = $2 AND company_id = $3
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, projectId, companyId],
      );
      if (snap.rowCount && snap.rowCount > 0) return { status: "found", snapshot: snap.rows[0] };
      return { status: "no_snapshot", snapshot: null };
    }

    if (domain && columns.has("domain")) {
      const snap = await tenantDb.query(
        `SELECT * FROM website_intelligence_snapshots
         WHERE tenant_id = $1 AND project_id = $2 AND domain = $3
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, projectId, domain],
      );
      if (snap.rowCount && snap.rowCount > 0) return { status: "found", snapshot: snap.rows[0] };
      return { status: "no_snapshot", snapshot: null };
    }

    return { status: "not_available", snapshot: null };
  } catch {
    // Any unexpected shape/permission error on this optional, possibly
    // not-yet-existing table must never break the rest of company
    // intelligence — degrade honestly instead.
    return { status: "not_available", snapshot: null };
  }
}

/**
 * Firmographics via company_enrichment, reached through this company's
 * linked leads (see header comment — company_enrichment is keyed by
 * lead_id, there is no direct company_id column on it). Picks the most
 * recently enriched row among this company's leads, if any.
 */
async function loadFirmographics(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  companyId: string,
): Promise<FirmographicsResult> {
  const result = await tenantDb.query(
    `SELECT ce.lead_id, ce.firmographics, ce.data_sources, ce.source_confidence
     FROM company_enrichment ce
     JOIN leads l ON l.id = ce.lead_id AND l.tenant_id = ce.tenant_id AND l.project_id = ce.project_id
     WHERE ce.tenant_id = $1 AND ce.project_id = $2 AND l.company_id = $3
     ORDER BY ce.enriched_at DESC
     LIMIT 1`,
    [tenantId, projectId, companyId],
  );
  if (result.rowCount === 0) {
    return { status: "not_found", firmographics: null, dataSources: [], sourceConfidence: null, viaLeadId: null };
  }
  const row = result.rows[0] as {
    lead_id: string;
    firmographics: Record<string, unknown>;
    data_sources: string[];
    source_confidence: string;
  };
  return {
    status: "found",
    firmographics: row.firmographics,
    dataSources: row.data_sources,
    sourceConfidence: row.source_confidence,
    viaLeadId: row.lead_id,
  };
}

async function loadDealHistory(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  companyId: string,
): Promise<{ leads: CompanyLeadSummary[]; deals: CompanyDealSummary[] }> {
  const leadsResult = await tenantDb.query(
    `SELECT id, name, status, created_at FROM leads
     WHERE tenant_id = $1 AND project_id = $2 AND company_id = $3
     ORDER BY created_at DESC
     LIMIT 200`,
    [tenantId, projectId, companyId],
  );
  const leads = leadsResult.rows as { id: string; name: string | null; status: string | null; created_at: string }[];

  if (leads.length === 0) {
    return { leads: [], deals: [] };
  }

  const leadIds = leads.map((l) => l.id);
  const dealsResult = await tenantDb.query(
    `SELECT id, lead_id, stage, value_amount, stage_changed_at FROM deals
     WHERE tenant_id = $1 AND project_id = $2 AND lead_id = ANY($3::uuid[])
     ORDER BY stage_changed_at DESC
     LIMIT 200`,
    [tenantId, projectId, leadIds],
  );

  return {
    leads: leads.map((l) => ({ id: l.id, name: l.name, status: l.status, createdAt: l.created_at })),
    deals: (dealsResult.rows as { id: string; lead_id: string; stage: string; value_amount: string | null; stage_changed_at: string }[]).map(
      (d) => ({ id: d.id, leadId: d.lead_id, stage: d.stage, valueAmount: d.value_amount, stageChangedAt: d.stage_changed_at }),
    ),
  };
}

/**
 * Aggregates everything this codebase already real-knows about one
 * `companies` row: tracked contacts + a live decision-maker waterfall run,
 * firmographics (via company_enrichment), website intelligence (best-
 * effort, see header), and deal/lead history. Throws Errors.notFound if
 * the company doesn't exist in this tenant/project (same convention as
 * routes/companies.ts's loadCompanyOr404).
 */
export async function getCompanyIntelligence(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  companyId: string,
): Promise<CompanyIntelligenceResult> {
  const companyRow = await loadCompanyOrThrow(tenantDb, tenantId, projectId, companyId);

  const [trackedContacts, providerWaterfall, firmographics, websiteIntelligence, dealHistory] = await Promise.all([
    loadTrackedContacts(tenantDb, tenantId, projectId, companyId),
    buildDecisionMakerWaterfallForTenant(tenantDb, tenantId, projectId),
    loadFirmographics(tenantDb, tenantId, projectId, companyId),
    loadWebsiteIntelligence(tenantDb, tenantId, projectId, companyId, companyRow.domain),
    loadDealHistory(tenantDb, tenantId, projectId, companyId),
  ]);

  const providerLookup = await findDecisionMakers(
    { organizationName: companyRow.name, domain: companyRow.domain },
    providerWaterfall,
  );

  return {
    company: {
      id: companyRow.id,
      name: companyRow.name,
      domain: companyRow.domain,
      industry: companyRow.industry,
      sizeRange: companyRow.size_range,
      notes: companyRow.notes,
    },
    decisionMakers: {
      trackedContacts,
      providerLookup,
      providerDecisionMakers: providerLookup.contacts,
    },
    firmographics,
    websiteIntelligence,
    dealHistory,
  };
}
