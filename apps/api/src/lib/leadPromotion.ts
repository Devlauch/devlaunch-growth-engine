import type { PoolClient } from "pg";
import { Errors } from "./httpError.js";
import { normalizeDomain, normalizeOrgName, normalizeEmail } from "./dedup.js";
import { assertActiveTenantMember } from "./salesPipeline.js";

/**
 * leadPromotion.ts: closes the single highest-leverage gap flagged by the
 * Milestone 3 "Broader Workstream Audit" (docs/FEATURE_STATUS.md, "Milestone
 * 3 audit" section) — "Scoring and CRM are two fully-built islands that
 * never talk to each other — no deal auto-creation from a high score, no
 * auto-assignment". This is NOT automatic/silent: it is one explicit action
 * (POST .../leads/:leadId/promote-to-crm, apps/api/src/routes/
 * leadPromotion.ts) a human triggers for one specific lead, same convention
 * as every other write in this schema (nothing here ever fires from a
 * cron/webhook).
 *
 * "Qualification threshold" reuses the EXISTING rubric/scoring concept
 * already used throughout this codebase (analytics.ts, growthRevenueAnalytics
 * .ts, funnelDropoff.ts, reportGenerator.ts, nextBestAction.ts) rather than
 * inventing a new one: a lead is CRM-ready when leads.status = 'qualified'
 * (a human already marked it so) OR its lead_scores.total_score crosses
 * QUALIFIED_SCORE_THRESHOLD (=50, the same constant value — kept as its own
 * local copy since each of those call sites also duplicates it locally
 * rather than share a cross-file import, an existing, deliberate convention
 * in this codebase for small pure constants — see scoreLead.ts's header
 * comment for the identical reasoning applied to a whole function).
 *
 * Promotion does three real things, each idempotent (safe to call again for
 * the same lead without duplicating data):
 *   1. Links the lead to a real `companies` row (reusing an existing company
 *      matched by normalized name/domain within the project, never creating
 *      a duplicate) — sets leads.company_id if not already set
 *      (303_add_company_id_to_leads.sql's intended use).
 *   2. Creates exactly one `contacts` row for this lead (skipped if one
 *      already exists with this lead_id).
 *   3. Optionally assigns the lead via `lead_assignments` — either to an
 *      explicit assignedUserId (validated as a real active tenant member,
 *      same invariant as apps/api/src/routes/deals.ts's POST
 *      /deals/assignments) or, if requested and the lead has no current
 *      assignment yet, via a real round-robin rule among active tenant
 *      members (see pickRoundRobinAssignee below) — the "simple real
 *      assignment-rule concept" called for when no configured-rules table
 *      exists yet.
 *
 * Never fabricates: a lead with no `company` text gets no company link (no
 * invented name); a tenant with no active members gets no auto-assignment
 * (returned as a named, honest reason, never silently skipped without
 * saying why).
 */

export const QUALIFIED_SCORE_THRESHOLD = 50;

export interface LeadRow {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  company_id: string | null;
  status: string;
  custom_fields: Record<string, unknown>;
}

export interface LeadScoreRow {
  total_score: string | number;
}

export interface QualificationResult {
  met: boolean;
  reason: "status_qualified" | "score_threshold" | "not_qualified";
  threshold: number;
  totalScore: number | null;
}

/** Pure — no DB access. Reuses the existing codebase-wide qualification rule. */
export function evaluateQualification(lead: Pick<LeadRow, "status">, score: LeadScoreRow | null): QualificationResult {
  const totalScore = score ? Number(score.total_score) : null;
  if (lead.status === "qualified") {
    return { met: true, reason: "status_qualified", threshold: QUALIFIED_SCORE_THRESHOLD, totalScore };
  }
  if (totalScore !== null && totalScore >= QUALIFIED_SCORE_THRESHOLD) {
    return { met: true, reason: "score_threshold", threshold: QUALIFIED_SCORE_THRESHOLD, totalScore };
  }
  return { met: false, reason: "not_qualified", threshold: QUALIFIED_SCORE_THRESHOLD, totalScore };
}

export interface CompanyLinkResult {
  company: Record<string, unknown> | null;
  created: boolean;
}

/**
 * Finds-or-creates the company this lead belongs to, never fabricating one:
 * if the lead has no `company` text at all, returns { company: null,
 * created: false } rather than inventing a name. Matching against existing
 * companies in the project reuses the same normalizers dedup.ts already
 * uses for discovered_organizations (companies has no normalized_name/
 * normalized_domain column of its own, so normalization happens here, at
 * query time, over the small per-project company list).
 */
export async function findOrCreateCompanyForLead(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  userId: string,
  lead: LeadRow,
): Promise<CompanyLinkResult> {
  if (lead.company_id) {
    const existing = await tenantDb.query(
      `SELECT id, tenant_id, project_id, name, domain, industry, size_range, notes, created_by, created_at, updated_at
       FROM companies WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [lead.company_id, tenantId, projectId],
    );
    return { company: existing.rows[0] ?? null, created: false };
  }

  const candidateName = (lead.company ?? "").trim();
  if (candidateName.length === 0) {
    return { company: null, created: false };
  }

  const normalizedTarget = normalizeOrgName(candidateName);
  const emailDomain = lead.email ? normalizeDomain(lead.email.split("@")[1]) : null;

  const existingCompanies = await tenantDb.query(
    `SELECT id, tenant_id, project_id, name, domain, industry, size_range, notes, created_by, created_at, updated_at
     FROM companies WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  for (const row of existingCompanies.rows as Array<Record<string, unknown>>) {
    const rowName = typeof row.name === "string" ? row.name : "";
    const rowDomain = typeof row.domain === "string" ? row.domain : null;
    const sameName = normalizedTarget.length > 0 && normalizeOrgName(rowName) === normalizedTarget;
    const sameDomain = emailDomain !== null && normalizeDomain(rowDomain) === emailDomain;
    if (sameName || sameDomain) {
      return { company: row, created: false };
    }
  }

  const inserted = await tenantDb.query(
    `INSERT INTO companies (tenant_id, project_id, name, domain, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenant_id, project_id, name, domain, industry, size_range, notes, created_by, created_at, updated_at`,
    [tenantId, projectId, candidateName, emailDomain, userId],
  );
  return { company: inserted.rows[0], created: true };
}

export interface ContactLinkResult {
  contact: Record<string, unknown>;
  created: boolean;
}

/**
 * Finds-or-creates the `contacts` row for this lead. Idempotent: a repeat
 * promotion call for the same lead returns the same contact row rather than
 * creating a second one. phone/title are only populated from the lead's own
 * custom_fields when an obviously-matching key is present and non-empty —
 * never guessed.
 *
 * Also dedupes ACROSS leads: `contacts.email` has only an index, no unique
 * constraint (307_create_contacts.sql), and this function used to match
 * solely on `lead_id`. That meant the same real person promoted from two
 * different `leads` rows (e.g. one captured by the public widget, a second
 * one later created from a discovery run for the same email — see
 * routes/discovery.ts's POST .../promote-to-lead, which creates a fresh
 * `leads` row with no existing-contact check of its own) would get a
 * second, duplicate `contacts` row instead of reusing the one that already
 * represents them. Before inserting, this now also looks for an existing
 * contact in this tenant+project whose normalized email matches the lead's
 * email (reusing dedup.ts's normalizeEmail, the same normalizer
 * findDuplicateContact already uses for discovered_contacts) and reuses it
 * instead of creating a duplicate. It does not rewrite that contact's
 * lead_id/company_id — a contact already tied to another lead keeps that
 * link; this promotion just avoids fabricating a second row for the same
 * person.
 */
export async function findOrCreateContactForLead(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  userId: string,
  lead: LeadRow,
  companyId: string | null,
): Promise<ContactLinkResult> {
  const existing = await tenantDb.query(
    `SELECT id, tenant_id, project_id, company_id, lead_id, name, email, phone, title, created_by, created_at, updated_at
     FROM contacts WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
    [tenantId, projectId, lead.id],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return { contact: existing.rows[0], created: false };
  }

  const normalizedEmail = normalizeEmail(lead.email);
  if (normalizedEmail) {
    const byEmail = await tenantDb.query(
      `SELECT id, tenant_id, project_id, company_id, lead_id, name, email, phone, title, created_by, created_at, updated_at
       FROM contacts WHERE tenant_id = $1 AND project_id = $2 AND lower(trim(email)) = $3
       LIMIT 1`,
      [tenantId, projectId, normalizedEmail],
    );
    if (byEmail.rowCount && byEmail.rowCount > 0) {
      return { contact: byEmail.rows[0], created: false };
    }
  }

  const customFields = lead.custom_fields ?? {};
  const customFieldsLower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(customFields)) {
    customFieldsLower.set(k.toLowerCase(), v);
  }
  const phoneCandidate = customFieldsLower.get("phone");
  const titleCandidate = customFieldsLower.get("title") ?? customFieldsLower.get("role_title") ?? customFieldsLower.get("role");

  // contacts.name is NOT NULL (307_create_contacts.sql); leads guarantees at
  // least an email or a name (015_create_leads.sql's leads_identity_present
  // check), so this fallback never produces an empty string.
  const contactName = (lead.name && lead.name.trim().length > 0 ? lead.name : lead.email) as string;

  const inserted = await tenantDb.query(
    `INSERT INTO contacts (tenant_id, project_id, company_id, lead_id, name, email, phone, title, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, tenant_id, project_id, company_id, lead_id, name, email, phone, title, created_by, created_at, updated_at`,
    [
      tenantId,
      projectId,
      companyId,
      lead.id,
      contactName,
      lead.email ?? null,
      typeof phoneCandidate === "string" && phoneCandidate.trim() ? phoneCandidate.trim() : null,
      typeof titleCandidate === "string" && titleCandidate.trim() ? titleCandidate.trim() : null,
      userId,
    ],
  );
  return { contact: inserted.rows[0], created: true };
}

export interface RoundRobinMember {
  user_id: string;
}

/**
 * Pure round-robin selection — no DB access, easy to unit test directly.
 * Active members are already ordered deterministically (by user_id) by the
 * caller. Picks the member after `lastAssignedUserId` in that order,
 * wrapping around; if `lastAssignedUserId` is null or no longer an active
 * member (e.g. deactivated since their last assignment), starts back at the
 * first member. Returns null only when there are no active members at all.
 */
export function pickRoundRobinAssignee(members: RoundRobinMember[], lastAssignedUserId: string | null): string | null {
  if (members.length === 0) return null;
  if (lastAssignedUserId === null) return members[0].user_id;
  const idx = members.findIndex((m) => m.user_id === lastAssignedUserId);
  if (idx === -1) return members[0].user_id;
  return members[(idx + 1) % members.length].user_id;
}

export type AssignmentSkipReason = "no_active_members" | "already_assigned";

export interface AssignmentResult {
  assignment: Record<string, unknown> | null;
  created: boolean;
  skippedReason?: AssignmentSkipReason;
}

const ASSIGNMENT_COLUMNS = `id, tenant_id, project_id, lead_id, assigned_user_id, assigned_by, assigned_at, created_at`;

/** Explicit "assign to this specific person" path — always inserts a new history row, same convention as POST /deals/assignments. */
export async function assignLeadToUser(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  leadId: string,
  assignedUserId: string,
  assignedBy: string,
): Promise<AssignmentResult> {
  await assertActiveTenantMember(tenantDb, tenantId, assignedUserId);
  const inserted = await tenantDb.query(
    `INSERT INTO lead_assignments (tenant_id, project_id, lead_id, assigned_user_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ASSIGNMENT_COLUMNS}`,
    [tenantId, projectId, leadId, assignedUserId, assignedBy],
  );
  return { assignment: inserted.rows[0], created: true };
}

/**
 * Real round-robin auto-assignment rule (the "simple real one" to add,
 * since no configurable assignment-rules table exists yet in this schema).
 * Only acts when the lead has no current assignment at all — auto-assign is
 * meant to hand off an unowned lead, not silently reassign/churn an already
 * worked one on a repeat promotion call.
 */
export async function autoAssignLeadRoundRobin(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  leadId: string,
  assignedBy: string,
): Promise<AssignmentResult> {
  const current = await tenantDb.query(
    `SELECT id, tenant_id, project_id, lead_id, assigned_user_id, assigned_by, assigned_at, created_at
     FROM lead_assignments WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
     ORDER BY assigned_at DESC LIMIT 1`,
    [tenantId, projectId, leadId],
  );
  if (current.rowCount && current.rowCount > 0) {
    return { assignment: current.rows[0], created: false, skippedReason: "already_assigned" };
  }

  const members = await tenantDb.query<RoundRobinMember>(
    `SELECT user_id FROM memberships WHERE tenant_id = $1 AND status = 'active' ORDER BY user_id ASC`,
    [tenantId],
  );
  if (members.rowCount === 0) {
    return { assignment: null, created: false, skippedReason: "no_active_members" };
  }

  const lastProjectAssignment = await tenantDb.query<{ assigned_user_id: string }>(
    `SELECT assigned_user_id FROM lead_assignments WHERE tenant_id = $1 AND project_id = $2
     ORDER BY assigned_at DESC LIMIT 1`,
    [tenantId, projectId],
  );
  const lastAssignedUserId = lastProjectAssignment.rows[0]?.assigned_user_id ?? null;
  const nextUserId = pickRoundRobinAssignee(members.rows, lastAssignedUserId);
  if (!nextUserId) {
    return { assignment: null, created: false, skippedReason: "no_active_members" };
  }

  const inserted = await tenantDb.query(
    `INSERT INTO lead_assignments (tenant_id, project_id, lead_id, assigned_user_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ASSIGNMENT_COLUMNS}`,
    [tenantId, projectId, leadId, nextUserId, assignedBy],
  );
  return { assignment: inserted.rows[0], created: true };
}

/**
 * Score threshold above which a lead's sequence cadence is accelerated
 * further than the standard "qualified" acceleration below. Kept as its own
 * local constant, same convention as QUALIFIED_SCORE_THRESHOLD's header
 * comment explains for small pure constants duplicated across call sites.
 */
export const HIGH_PRIORITY_SCORE_THRESHOLD = 80;

export type CadenceTier = "accelerated_high_priority" | "accelerated_qualified" | "standard";

export interface CadenceDecision {
  /** Multiplies sequence_steps.day_offset for this enrollment: < 1 fires steps sooner than the sequence's authored cadence. */
  multiplier: number;
  tier: CadenceTier;
  reason: string;
}

/**
 * Pure — no DB access. Closes the gap flagged for Phase 6a: qualification
 * scoring (scoring.ts's rubric engine) previously had no link at all to
 * sequence follow-up cadence (advanceSequences.ts) — every enrolled lead,
 * regardless of how strongly qualified, waited the exact same
 * sequence_steps.day_offset before its next touch. This reuses the SAME
 * qualification concept promote-to-CRM already established
 * (evaluateQualification above) rather than inventing a second scoring
 * notion: a lead scoring at/above HIGH_PRIORITY_SCORE_THRESHOLD gets every
 * step fired at half the authored cadence (fires twice as fast); a lead
 * that merely meets the ordinary CRM-qualification bar (QUALIFIED_SCORE_
 * THRESHOLD, or a human-set 'qualified' status) gets a 25% faster cadence;
 * any other lead — not yet qualified, or not yet scored at all — keeps the
 * sequence's normal, unaccelerated cadence (an absent/low score never SLOWS
 * a lead down below the sequence's authored pace, it just doesn't speed it
 * up).
 */
export function computeCadenceMultiplier(qualification: QualificationResult): CadenceDecision {
  if (qualification.totalScore !== null && qualification.totalScore >= HIGH_PRIORITY_SCORE_THRESHOLD) {
    return {
      multiplier: 0.5,
      tier: "accelerated_high_priority",
      reason: `Lead score ${qualification.totalScore} is at/above the high-priority threshold (${HIGH_PRIORITY_SCORE_THRESHOLD}): sequence steps fire at half the authored cadence.`,
    };
  }
  if (qualification.met) {
    return {
      multiplier: 0.75,
      tier: "accelerated_qualified",
      reason: `Lead meets the qualification threshold (${qualification.reason}): sequence steps fire 25% faster than the authored cadence.`,
    };
  }
  return {
    multiplier: 1,
    tier: "standard",
    reason: "Lead is not yet qualified (or not yet scored): sequence keeps its normal, authored cadence.",
  };
}

export function requireQualifiedOrOverride(qualification: QualificationResult, override: boolean): void {
  if (!qualification.met && !override) {
    throw Errors.badRequest(
      `This lead has not crossed the CRM-promotion qualification threshold yet ` +
        `(needs leads.status = 'qualified' or a lead score >= ${qualification.threshold}; ` +
        `current score: ${qualification.totalScore ?? "not yet computed"}). ` +
        `Pass { "override": true } to promote it anyway.`,
    );
  }
}
