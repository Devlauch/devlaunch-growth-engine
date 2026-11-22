/**
 * Workflow stage: lead_generation.
 *
 * "Lead generation agents — Discover, enrich, qualify and score leads."
 * Composes four already-built, real Phase 1/2 features rather than
 * reinventing any of them:
 *   1. Discovery (apps/api/src/routes/discovery.ts's discovery_sources /
 *      discovered_organizations / discovered_contacts logic) — reuses or
 *      creates a 'public_directory' discovery_sources row for this project
 *      and runs the real registered connector (packages/agent-sdk's
 *      PublicDirectoryConnector, via getConnector), persisting whatever it
 *      genuinely finds with the same dedup rules discovery.ts's /run
 *      handler uses.
 *   2. Lead creation — a bounded number (MAX_NEW_LEADS) of newly discovered
 *      organizations/contacts that don't already match an existing lead by
 *      email become real `leads` rows (source: 'agent').
 *   3. Enrichment (companyEnrichment.ts's enrichLead) and ICP matching
 *      (icpMatching.ts's matchLeadToAllIcps) run for each new lead.
 *   4. Scoring — the project's active scoring_rubrics row is recomputed for
 *      each new lead using the exact same evidence-assembly heuristic and
 *      pure scoring math apps/api/src/routes/scoring.ts's /recompute route
 *      uses (ported here as recomputeRubricScore/buildEvidenceMap, same
 *      "duplicate a small pure/glue computation instead of adding a
 *      cross-file dependency on route internals" precedent scoreLead.ts
 *      itself documents — scoring.ts does not export its route-local
 *      buildRecomputeEvidenceMap helper, so it can't be imported directly).
 *      "Missing evidence scores zero" is preserved exactly: a lead with no
 *      real evidence gets a real zero, never a fabricated score.
 *
 * NOTE ON apps/api/src/workflow/types.ts: by the time this file was written,
 * types.ts already existed on disk (the parallel "orchestration core" agent
 * had landed it), matching the contract specified for this task exactly, so
 * no local fallback type copy was needed.
 */
import type { PoolClient } from "pg";
import {
  getConnector,
  UnsupportedIndustryError,
  type ConnectorConfig,
  type DiscoveredContact as ConnectorDiscoveredContact,
} from "@devlaunch/agent-sdk";
import type { StageExecutor, StageResult } from "../types.js";
import {
  findDuplicateOrganization,
  findDuplicateContact,
  normalizeDomain,
  normalizeOrgName,
  normalizeEmail,
} from "../../lib/dedup.js";
import { verifyEmail } from "../../lib/emailVerification.js";
import { normalizePhone } from "../../lib/phoneVerification.js";
import { enrichLead } from "../../lib/companyEnrichment.js";
import { matchLeadToAllIcps } from "../../lib/icpMatching.js";
import { scoreLead, type ScoreLeadCriterion, type ScoreLeadEvidenceEntry } from "../../lib/scoreLead.js";

/** Same registry id discovery.ts uses for the 'public_directory' connector_type. */
const PUBLIC_DIRECTORY_CONNECTOR_ID = "public-directory";

/** Keeps each run bounded — new-lead creation is capped, not discovery itself. */
const MAX_NEW_LEADS = 10;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Rubric scoring (ported from routes/scoring.ts's /recompute — see file doc
// comment above for why this isn't imported instead).
// ---------------------------------------------------------------------------

function isNonEmptyEvidenceValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function buildEvidenceMap(
  lead: Row,
  criteria: ScoreLeadCriterion[],
  matchedOrg: Row | null,
  contacts: Row[],
): Record<string, ScoreLeadEvidenceEntry> {
  const customFields = (lead.custom_fields ?? {}) as Record<string, unknown>;
  const customFieldsLower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(customFields)) {
    customFieldsLower.set(k.toLowerCase(), v);
  }

  const orgHaystackParts: string[] = [];
  if (matchedOrg) {
    orgHaystackParts.push(String(matchedOrg.name ?? ""));
    orgHaystackParts.push(JSON.stringify(matchedOrg.raw_metadata ?? {}));
  }
  for (const contact of contacts) {
    orgHaystackParts.push(
      [contact.name, contact.role_title, contact.email, contact.phone, contact.source_url]
        .filter((v): v is string => typeof v === "string")
        .join(" "),
    );
  }
  const orgHaystack = orgHaystackParts.join(" \n ").toLowerCase();

  const evidence: Record<string, ScoreLeadEvidenceEntry> = {};
  for (const criterion of criteria) {
    const fieldValue = customFieldsLower.get(criterion.key.toLowerCase());
    if (isNonEmptyEvidenceValue(fieldValue)) {
      evidence[criterion.key] = {
        present: true,
        summary: `Lead's custom_fields.${criterion.key} is set`,
        source: "lead.custom_fields",
      };
      continue;
    }

    if (matchedOrg) {
      const keyPhrase = criterion.key.replace(/[_-]+/g, " ").trim().toLowerCase();
      const labelLower = criterion.label.trim().toLowerCase();
      const matchedKeyPhrase = keyPhrase.length >= 3 && orgHaystack.includes(keyPhrase);
      const matchedLabel = labelLower.length >= 3 && orgHaystack.includes(labelLower);
      if (matchedKeyPhrase || matchedLabel) {
        evidence[criterion.key] = {
          present: true,
          summary: `Found "${matchedKeyPhrase ? keyPhrase : labelLower}" in discovered org/contact data for ${String(matchedOrg.name ?? "this organization")}`,
          source: `discovered_organizations:${String(matchedOrg.id)}`,
        };
        continue;
      }
    }

    evidence[criterion.key] = { present: false };
  }

  return evidence;
}

/**
 * Recomputes and upserts this lead's lead_scores row against the project's
 * active rubric, exactly like POST /lead-scores/:leadId/recompute. Returns
 * null (not zero) when there is no active rubric at all — distinct from a
 * real, honest zero score computed against a rubric with no evidence.
 */
async function recomputeRubricScore(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<number | null> {
  const rubricResult = await tenantDb.query(
    `SELECT * FROM scoring_rubrics WHERE tenant_id = $1 AND project_id = $2 AND is_active = true
     ORDER BY updated_at DESC LIMIT 1`,
    [tenantId, projectId],
  );
  if (rubricResult.rowCount === 0) return null;
  const rubric = rubricResult.rows[0] as Row;
  const criteria = (rubric.criteria ?? []) as ScoreLeadCriterion[];

  const leadResult = await tenantDb.query(
    `SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, tenantId, projectId],
  );
  const lead = leadResult.rows[0] as Row;

  const emailDomain =
    typeof lead.email === "string" && lead.email.includes("@")
      ? normalizeDomain(lead.email.split("@")[1])
      : null;
  const companyName = typeof lead.company === "string" ? normalizeOrgName(lead.company) : null;

  let matchedOrg: Row | null = null;
  if (emailDomain) {
    const byDomain = await tenantDb.query(
      `SELECT * FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2 AND normalized_domain = $3 LIMIT 1`,
      [tenantId, projectId, emailDomain],
    );
    if (byDomain.rowCount && byDomain.rowCount > 0) matchedOrg = byDomain.rows[0];
  }
  if (!matchedOrg && companyName) {
    const byName = await tenantDb.query(
      `SELECT * FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2 AND normalized_name = $3 LIMIT 1`,
      [tenantId, projectId, companyName],
    );
    if (byName.rowCount && byName.rowCount > 0) matchedOrg = byName.rows[0];
  }

  let contacts: Row[] = [];
  if (matchedOrg) {
    const contactsResult = await tenantDb.query(
      `SELECT * FROM discovered_contacts WHERE organization_id = $1 AND tenant_id = $2`,
      [matchedOrg.id, tenantId],
    );
    contacts = contactsResult.rows;
  }

  const evidence = buildEvidenceMap(lead, criteria, matchedOrg, contacts);
  const scored = scoreLead(criteria, evidence);

  await tenantDb.query(
    `INSERT INTO lead_scores (tenant_id, project_id, lead_id, rubric_id, total_score, criteria_evidence, why_summary, next_research_note, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())
     ON CONFLICT (lead_id) DO UPDATE SET
       rubric_id = EXCLUDED.rubric_id,
       total_score = EXCLUDED.total_score,
       criteria_evidence = EXCLUDED.criteria_evidence,
       why_summary = EXCLUDED.why_summary,
       next_research_note = EXCLUDED.next_research_note,
       computed_at = EXCLUDED.computed_at`,
    [
      tenantId,
      projectId,
      leadId,
      rubric.id,
      scored.totalScore,
      JSON.stringify(scored.criteriaEvidence),
      scored.whySummary,
      scored.nextResearchNote,
    ],
  );

  return scored.totalScore;
}

// ---------------------------------------------------------------------------
// Discovery (same glue as discovery.ts's POST /:id/run, re-homed here since
// this stage runs inside a workflow transaction rather than an HTTP route).
// ---------------------------------------------------------------------------

async function getOrCreateDiscoverySource(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  inputConfig: Record<string, unknown>,
): Promise<{ source: Row; created: boolean }> {
  const existing = await tenantDb.query(
    `SELECT * FROM discovery_sources WHERE tenant_id = $1 AND project_id = $2 AND connector_type = 'public_directory'
     ORDER BY created_at ASC LIMIT 1`,
    [tenantId, projectId],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return { source: existing.rows[0], created: false };
  }

  const config: Record<string, unknown> = {};
  if (typeof inputConfig.industry === "string") config.industry = inputConfig.industry;
  if (typeof inputConfig.geography === "string") config.geography = inputConfig.geography;

  const inserted = await tenantDb.query(
    `INSERT INTO discovery_sources (tenant_id, project_id, connector_type, name, enabled, rate_limit_per_minute, config)
     VALUES ($1, $2, 'public_directory', $3, true, 10, $4::jsonb)
     RETURNING *`,
    [tenantId, projectId, "Workflow lead generation (public directory)", JSON.stringify(config)],
  );
  return { source: inserted.rows[0], created: true };
}

async function persistDiscoveredOrganizations(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  sourceId: string,
  organizations: { name: string; domain?: string; sourceUrl: string; discoveredAt: string; rawMetadata: Record<string, unknown> }[],
  contactsByOrgName: Record<string, ConnectorDiscoveredContact[]>,
): Promise<{ organizationsCreated: number; persistedOrganizations: (Row & { contacts: Row[] })[] }> {
  let organizationsCreated = 0;
  const persistedOrganizations: (Row & { contacts: Row[] })[] = [];

  for (const discoveredOrg of organizations) {
    const duplicate = await findDuplicateOrganization(tenantDb, projectId, {
      domain: discoveredOrg.domain,
      name: discoveredOrg.name,
    });

    let orgRow: Row;
    if (duplicate) {
      const existing = await tenantDb.query(
        `SELECT * FROM discovered_organizations WHERE id = $1 AND tenant_id = $2`,
        [duplicate.id, tenantId],
      );
      orgRow = existing.rows[0];
    } else {
      const normalizedDomain = normalizeDomain(discoveredOrg.domain);
      const normalizedName = normalizeOrgName(discoveredOrg.name);
      const inserted = await tenantDb.query(
        `INSERT INTO discovered_organizations
           (tenant_id, project_id, discovery_source_id, name, domain, normalized_domain, normalized_name, source_url, raw_metadata, discovered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (tenant_id, project_id, normalized_domain) WHERE normalized_domain IS NOT NULL DO NOTHING
         RETURNING *`,
        [
          tenantId,
          projectId,
          sourceId,
          discoveredOrg.name,
          discoveredOrg.domain ?? null,
          normalizedDomain,
          normalizedName,
          discoveredOrg.sourceUrl,
          JSON.stringify(discoveredOrg.rawMetadata ?? {}),
          discoveredOrg.discoveredAt,
        ],
      );
      if (inserted.rowCount && inserted.rowCount > 0) {
        organizationsCreated += 1;
        orgRow = inserted.rows[0];
      } else {
        const winner = await tenantDb.query(
          `SELECT * FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2 AND normalized_domain = $3`,
          [tenantId, projectId, normalizedDomain],
        );
        orgRow = winner.rows[0];
      }
    }

    const orgContacts = contactsByOrgName[discoveredOrg.name] ?? [];
    const persistedContacts: Row[] = [];
    for (const contact of orgContacts) {
      const contactDuplicate = await findDuplicateContact(tenantDb, orgRow.id as string, {
        email: contact.email,
        name: contact.name,
      });
      if (contactDuplicate) {
        const existingContact = await tenantDb.query(
          `SELECT * FROM discovered_contacts WHERE id = $1 AND tenant_id = $2`,
          [contactDuplicate.id, tenantId],
        );
        if (existingContact.rowCount && existingContact.rowCount > 0) persistedContacts.push(existingContact.rows[0]);
        continue;
      }

      const normalizedEmail = normalizeEmail(contact.email);
      const normalizedPhone = contact.phone ? normalizePhone(contact.phone) : null;
      let verificationStatus = "unverified";
      let emailVerification: Record<string, unknown> = {};
      if (contact.email) {
        const verification = await verifyEmail(contact.email);
        verificationStatus = verification.verificationStatus;
        emailVerification = verification as unknown as Record<string, unknown>;
      }

      const insertedContact = await tenantDb.query(
        `INSERT INTO discovered_contacts
           (tenant_id, organization_id, name, role_title, email, normalized_email, phone, contact_channel, verification_status, email_verification, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         ON CONFLICT (organization_id, normalized_email) WHERE normalized_email IS NOT NULL DO NOTHING
         RETURNING *`,
        [
          tenantId,
          orgRow.id,
          contact.name ?? null,
          contact.roleTitle ?? null,
          contact.email ?? null,
          normalizedEmail,
          normalizedPhone ?? contact.phone ?? null,
          contact.contactChannel,
          verificationStatus,
          JSON.stringify(emailVerification),
          contact.sourceUrl ?? null,
        ],
      );
      if (insertedContact.rowCount && insertedContact.rowCount > 0) {
        persistedContacts.push(insertedContact.rows[0]);
      }
    }

    persistedOrganizations.push({ ...orgRow, contacts: persistedContacts });
  }

  return { organizationsCreated, persistedOrganizations };
}

// ---------------------------------------------------------------------------
// Stage executor
// ---------------------------------------------------------------------------

export const runLeadGenerationStage: StageExecutor = async (input) => {
  const { tenantDb, tenantId, projectId, inputConfig } = input;

  const { source, created: sourceCreated } = await getOrCreateDiscoverySource(
    tenantDb,
    tenantId,
    projectId,
    inputConfig,
  );

  if (!source.enabled) {
    return {
      stage: "lead_generation",
      status: "completed",
      summary: `Discovery source "${String(source.name)}" is disabled for this project, so no new organizations were discovered and no new leads were created this run.`,
      data: {
        discoverySourceId: source.id,
        discoverySourceCreated: sourceCreated,
        discoveredCount: 0,
        organizationsCreated: 0,
        leadsCreated: [],
        scores: [],
      },
    };
  }

  const connector = getConnector(PUBLIC_DIRECTORY_CONNECTOR_ID);
  if (!connector) {
    // Should be unreachable — the connector is registered unconditionally
    // in packages/agent-sdk/src/connectors/registry.ts.
    throw new Error(`Connector "${PUBLIC_DIRECTORY_CONNECTOR_ID}" is not registered`);
  }

  const storedConfig = (source.config ?? {}) as Record<string, unknown>;
  const discoverInput = {
    industry: typeof inputConfig.industry === "string" ? inputConfig.industry : storedConfig.industry,
    geography: typeof inputConfig.geography === "string" ? inputConfig.geography : storedConfig.geography,
    limit: typeof inputConfig.limit === "number" ? inputConfig.limit : (storedConfig.limit ?? MAX_NEW_LEADS),
  };
  const connectorConfig: ConnectorConfig = {
    rateLimitPerMinute: source.rate_limit_per_minute as number,
    enabled: source.enabled as boolean,
    termsNote: (source.terms_note as string | null) ?? connector.termsNote,
  };

  let discovery;
  try {
    discovery = await connector.discover(discoverInput, connectorConfig);
  } catch (err) {
    const message =
      err instanceof UnsupportedIndustryError ? err.message : err instanceof Error ? err.message : String(err);
    return {
      stage: "lead_generation",
      status: "completed",
      summary: `Discovery run against the public-directory connector failed (${message}); 0 new leads were created this run.`,
      data: {
        discoverySourceId: source.id,
        discoverySourceCreated: sourceCreated,
        discoveredCount: 0,
        organizationsCreated: 0,
        leadsCreated: [],
        scores: [],
        error: message,
      },
    };
  }

  const { organizationsCreated, persistedOrganizations } = await persistDiscoveredOrganizations(
    tenantDb,
    tenantId,
    projectId,
    source.id as string,
    discovery.organizations,
    discovery.contacts,
  );

  // For each persisted organization, create at most one lead per contact
  // (or one org-only lead when it has no contacts), capped at MAX_NEW_LEADS
  // new leads total, skipping anyone who already has a leads row matched by
  // email.
  const leadsCreated: string[] = [];
  const scores: { leadId: string; icpAverage: number | null; rubricScore: number | null }[] = [];

  outer: for (const org of persistedOrganizations) {
    const contacts = org.contacts;
    const candidates: (Row | null)[] = contacts.length > 0 ? contacts : [null];

    for (const contact of candidates) {
      if (leadsCreated.length >= MAX_NEW_LEADS) break outer;

      const email = (contact?.email as string | undefined) ?? null;
      const name = (contact?.name as string | undefined) ?? (org.name as string | undefined) ?? null;
      if (!email && !name) continue; // can't satisfy leads_identity_present

      if (email) {
        const existingLead = await tenantDb.query(
          `SELECT id FROM leads WHERE tenant_id = $1 AND project_id = $2 AND lower(email) = lower($3) LIMIT 1`,
          [tenantId, projectId, email],
        );
        if (existingLead.rowCount && existingLead.rowCount > 0) continue;
      }

      const leadInsert = await tenantDb.query(
        `INSERT INTO leads (tenant_id, project_id, name, email, company, message, custom_fields, source, status, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'agent', 'new', $8)
         RETURNING id`,
        [
          tenantId,
          projectId,
          name,
          email,
          (org.domain as string | null) ?? (org.name as string | null),
          contact?.role_title ? `Role: ${contact.role_title}` : null,
          JSON.stringify({
            discoveredOrganizationId: org.id,
            discoveredContactId: contact?.id ?? null,
            discoverySourceId: source.id,
            sourceUrl: org.source_url,
          }),
          org.source_url,
        ],
      );
      const leadId = leadInsert.rows[0].id as string;
      leadsCreated.push(leadId);

      await enrichLead(tenantDb, tenantId, projectId, leadId);
      const icpScores = await matchLeadToAllIcps(tenantDb, tenantId, projectId, leadId);
      const icpAverage =
        icpScores.length > 0
          ? icpScores.reduce((sum, row) => sum + Number(row.match_score), 0) / icpScores.length
          : null;
      const rubricScore = await recomputeRubricScore(tenantDb, tenantId, projectId, leadId);

      scores.push({ leadId, icpAverage, rubricScore });
    }
  }

  const summaryParts: string[] = [
    `Discovered ${discovery.organizations.length} organization(s) via the public-directory connector` +
      (sourceCreated ? " (created a new discovery source for this project)" : " (reused the project's existing discovery source)") +
      `, persisted ${organizationsCreated} new discovered organization(s), and created ${leadsCreated.length} new lead(s).`,
  ];
  if (leadsCreated.length > 0) {
    const withIcp = scores.filter((s) => s.icpAverage !== null);
    const avgIcp = withIcp.length > 0 ? withIcp.reduce((sum, s) => sum + (s.icpAverage ?? 0), 0) / withIcp.length : null;
    const withRubric = scores.filter((s) => s.rubricScore !== null);
    const avgRubric =
      withRubric.length > 0 ? withRubric.reduce((sum, s) => sum + (s.rubricScore ?? 0), 0) / withRubric.length : null;

    summaryParts.push(
      avgIcp !== null ? `Average ICP match ${Math.round(avgIcp)}%.` : "No ICP profiles exist yet for this project to match against.",
    );
    summaryParts.push(
      avgRubric !== null
        ? `Average rubric score ${Math.round(avgRubric)}/100.`
        : "No active scoring rubric exists yet for this project, so no rubric score was computed.",
    );
  } else {
    summaryParts.push("No new leads were created this run.");
  }

  const result: StageResult = {
    stage: "lead_generation",
    status: "completed",
    summary: summaryParts.join(" "),
    data: {
      discoverySourceId: source.id,
      discoverySourceCreated: sourceCreated,
      discoveredCount: discovery.organizations.length,
      organizationsCreated,
      leadsCreated,
      scores,
    },
  };
  return result;
};
