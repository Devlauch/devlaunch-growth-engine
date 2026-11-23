import type { PoolClient } from "pg";
import { Errors } from "./httpError.js";
import { getLeadActivityTimeline, type ActivityItem } from "./activityTimeline.js";
import { computeDealHealthForDeal, type DealHealthResult } from "./dealHealth.js";
import type { DealStage } from "./salesPipeline.js";

/**
 * Meeting preparation brief: assembles a REAL, data-backed prep brief for
 * an upcoming (or past) meeting by pulling together data that ALREADY
 * exists elsewhere in this codebase — the lead's core record, its linked
 * company + contacts, ICP match scores (icpMatching.ts /
 * icp_match_scores), company enrichment firmographics
 * (companyEnrichment.ts / company_enrichment), the full per-lead activity
 * timeline (activityTimeline.ts's getLeadActivityTimeline — reused
 * directly, not reimplemented), the lead's current deal, and recent notes.
 *
 * Deliberately NOT a new cached/stored artifact: every call recomputes the
 * brief from live data with real, tenant/project-scoped queries. A stored
 * "meeting_prep_briefs" table was considered and rejected — the brief is
 * cheap to assemble (a handful of indexed lookups keyed by lead_id, all of
 * which already have indexes for their own routes) and a cached copy would
 * risk going stale the moment a new note/reply/deal-stage-change lands
 * between caching and the meeting. On-demand computation is simpler and
 * can never be stale, so no new migration is needed for this feature.
 *
 * Every section below is labeled and explicitly honest about absence: a
 * section with nothing to show always says so (`available: false` plus a
 * human-readable note), rather than being omitted — so a rep reading the
 * brief can tell "we checked and there's nothing" apart from "this wasn't
 * checked at all".
 */

interface QueryableDb {
  query: PoolClient["query"];
}

export interface MeetingPrepSection<T> {
  available: boolean;
  data: T | null;
  note: string;
}

export interface MeetingPrepBrief {
  meeting: Record<string, unknown>;
  lead: Record<string, unknown>;
  company: MeetingPrepSection<Record<string, unknown>>;
  contacts: MeetingPrepSection<Record<string, unknown>[]>;
  icpMatch: MeetingPrepSection<Record<string, unknown>[]>;
  companyEnrichment: MeetingPrepSection<Record<string, unknown>>;
  deal: MeetingPrepSection<Record<string, unknown>>;
  recentNotes: MeetingPrepSection<Record<string, unknown>[]>;
  activityTimeline: MeetingPrepSection<ActivityItem[]>;
}

const MEETING_COLUMNS = `id, tenant_id, project_id, lead_id, deal_id, type, scheduled_at, status, outcome_notes, next_step, booking_provider, created_at, updated_at`;

/**
 * Loads the meeting (scoped to tenant/project, and verified to belong to
 * the given leadId), then assembles the full prep brief around it.
 * Throws Errors.notFound if the meeting doesn't exist in this
 * tenant/project, or doesn't belong to the given lead.
 */
export async function buildMeetingPrepBrief(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  leadId: string,
  meetingId: string,
): Promise<MeetingPrepBrief> {
  const meetingResult = await tenantDb.query(
    `SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [meetingId, tenantId, projectId],
  );
  if (meetingResult.rowCount === 0) throw Errors.notFound("Meeting not found");
  const meeting = meetingResult.rows[0] as Record<string, unknown>;
  if (meeting.lead_id !== leadId) throw Errors.notFound("Meeting not found for this lead");

  const leadResult = await tenantDb.query(`SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
    leadId,
    tenantId,
    projectId,
  ]);
  if (leadResult.rowCount === 0) throw Errors.notFound("Lead not found");
  const lead = leadResult.rows[0] as Record<string, unknown>;

  const [companyResult, contactsResult, icpResult, enrichmentResult, dealResult, notesResult, activityItems] =
    await Promise.all([
      lead.company_id
        ? tenantDb.query(
            `SELECT id, name, domain, industry, size_range, notes, created_at, updated_at
             FROM companies WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
            [lead.company_id, tenantId, projectId],
          )
        : Promise.resolve({ rowCount: 0, rows: [] } as { rowCount: number; rows: Record<string, unknown>[] }),
      tenantDb.query(
        `SELECT id, company_id, name, email, phone, title, created_at
         FROM contacts WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
         ORDER BY created_at DESC`,
        [tenantId, projectId, leadId],
      ),
      tenantDb.query(
        `SELECT s.id, s.icp_profile_id, p.name AS icp_profile_name, s.match_score, s.match_reasons, s.computed_at
         FROM icp_match_scores s
         JOIN icp_profiles p ON p.id = s.icp_profile_id
         WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.lead_id = $3
         ORDER BY s.match_score DESC`,
        [tenantId, projectId, leadId],
      ),
      tenantDb.query(
        `SELECT id, matched_organization_id, domain, firmographics, data_sources, source_confidence, enriched_at
         FROM company_enrichment WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
        [tenantId, projectId, leadId],
      ),
      tenantDb.query(
        `SELECT id, stage, value_amount, expected_close_date, owner_user_id, stage_changed_at, created_at, updated_at
         FROM deals WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId, projectId, leadId],
      ),
      tenantDb.query(
        `SELECT id, body, created_at
         FROM notes WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
         ORDER BY created_at DESC
         LIMIT 10`,
        [tenantId, projectId, leadId],
      ),
      getLeadActivityTimeline(tenantDb, tenantId, projectId, leadId),
    ]);

  const company: MeetingPrepSection<Record<string, unknown>> =
    companyResult.rowCount && companyResult.rowCount > 0
      ? { available: true, data: companyResult.rows[0], note: "Linked company record found." }
      : {
          available: false,
          data: null,
          note: lead.company_id
            ? "Lead has a company_id but no matching company row was found."
            : "This lead is not linked to a company record (leads.company_id is null).",
        };

  const contacts: MeetingPrepSection<Record<string, unknown>[]> =
    contactsResult.rowCount && contactsResult.rowCount > 0
      ? { available: true, data: contactsResult.rows, note: `${contactsResult.rowCount} linked contact(s) found.` }
      : { available: false, data: null, note: "No contacts are linked to this lead (contacts.lead_id)." };

  const icpMatch: MeetingPrepSection<Record<string, unknown>[]> =
    icpResult.rowCount && icpResult.rowCount > 0
      ? { available: true, data: icpResult.rows, note: `Scored against ${icpResult.rowCount} ICP profile(s).` }
      : {
          available: false,
          data: null,
          note: "No ICP match scores exist for this lead yet (icp_match_scores is empty — matching may not have been run).",
        };

  const companyEnrichment: MeetingPrepSection<Record<string, unknown>> =
    enrichmentResult.rowCount && enrichmentResult.rowCount > 0
      ? { available: true, data: enrichmentResult.rows[0], note: "Company enrichment data found." }
      : {
          available: false,
          data: null,
          note: "No company enrichment has been run for this lead yet (company_enrichment has no row).",
        };

  // When a deal exists, fold in its REAL health score + "why" breakdown by
  // reusing dealHealth.ts's computeDealHealthForDeal directly (the same
  // function apps/api/src/routes/dealHealth.ts's GET /:dealId/health uses)
  // rather than recomputing deal-health signals a second time here — a rep
  // reading this brief sees exactly the same score/why the deal-health
  // endpoint would return for this deal, never a second, possibly-divergent
  // number.
  let dealHealth: DealHealthResult | null = null;
  if (dealResult.rowCount && dealResult.rowCount > 0) {
    const dealRow = dealResult.rows[0] as {
      id: string;
      stage: DealStage;
      value_amount: string | number | null;
      stage_changed_at: string;
      created_at: string;
    };
    dealHealth = await computeDealHealthForDeal(tenantDb, tenantId, projectId, {
      id: dealRow.id,
      lead_id: leadId,
      stage: dealRow.stage,
      stage_changed_at: dealRow.stage_changed_at,
      created_at: dealRow.created_at,
      value_amount: dealRow.value_amount,
    });
  }

  const deal: MeetingPrepSection<Record<string, unknown>> =
    dealResult.rowCount && dealResult.rowCount > 0
      ? {
          available: true,
          data: { ...dealResult.rows[0], health: dealHealth },
          note: "Most recently created deal for this lead, including its real, freshly-computed health score (see dealHealth.ts).",
        }
      : { available: false, data: null, note: "No deal has been created for this lead yet." };

  const recentNotes: MeetingPrepSection<Record<string, unknown>[]> =
    notesResult.rowCount && notesResult.rowCount > 0
      ? { available: true, data: notesResult.rows, note: `${notesResult.rowCount} most recent note(s) (up to 10).` }
      : { available: false, data: null, note: "No notes have been recorded for this lead." };

  const activityTimeline: MeetingPrepSection<ActivityItem[]> =
    activityItems.length > 0
      ? { available: true, data: activityItems, note: `${activityItems.length} activity item(s) across the lead's history.` }
      : { available: false, data: null, note: "No activity has been recorded for this lead yet." };

  return {
    meeting,
    lead,
    company,
    contacts,
    icpMatch,
    companyEnrichment,
    deal,
    recentNotes,
    activityTimeline,
  };
}
