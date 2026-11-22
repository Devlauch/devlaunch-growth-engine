import type { PoolClient } from "pg";
import { Errors } from "./httpError.js";
import { normalizeDomain, normalizeOrgName } from "./dedup.js";
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
 * (a human already marked it so) OR its lead_scores.total_score crosses the
 * qualification threshold (default QUALIFIED_SCORE_THRESHOLD = 50, the same
 * constant value those other call sites also duplicate locally — an
 * existing, deliberate convention in this codebase for small pure constants,
 * see scoreLead.ts's header comment for the identical reasoning applied to a
 * whole function). Ported from milestone3-phase2: a project can override
 * this default via a `qualification_settings.min_score_to_qualify` row
 * (packages/db/migrations/443_create_qualification_settings.sql,
 * apps/api/src/routes/qualificationSettings.ts) — see
 * getQualificationThreshold() below. Only the THRESHOLD SOURCE is
 * configurable; the reason taxonomy (status_qualified / score_threshold /
 * not_qualified) and every other call site's own copy of the constant are
 * unchanged by this.
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

/**
 * Pure — no DB access. Reuses the existing codebase-wide qualification
 * rule. `threshold` defaults to QUALIFIED_SCORE_THRESHOLD (this function's
 * behavior for any caller that doesn't pass one is byte-for-byte unchanged
 * from before qualification_settings existed) but callers that want a
 * project's configured threshold should resolve it first via
 * getQualificationThreshold() and pass it in here.
 */
export function evaluateQualification(
  lead: Pick<LeadRow, "status">,
  score: LeadScoreRow | null,
  threshold: number = QUALIFIED_SCORE_THRESHOLD,
): QualificationResult {
  const totalScore = score ? Number(score.total_score) : null;
  if (lead.status === "qualified") {
    return { met: true, reason: "status_qualified", threshold, totalScore };
  }
  if (totalScore !== null && totalScore >= threshold) {
    return { met: true, reason: "score_threshold", threshold, totalScore };
  }
  return { met: false, reason: "not_qualified", threshold, totalScore };
}

/**
 * Resolves the qualification threshold to use for this project:
 * `qualification_settings.min_score_to_qualify` when a project has
 * configured one, otherwise QUALIFIED_SCORE_THRESHOLD — never an error,
 * never left undefined. This is the ONLY place that reads
 * qualification_settings for the promotion-gating decision; it never
 * writes to leads/deals and never auto-creates anything — it just answers
 * "what number should evaluateQualification compare against for this
 * project."
 */
export async function getQualificationThreshold(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<number> {
  const result = await tenantDb.query<{ min_score_to_qualify: number }>(
    `SELECT min_score_to_qualify FROM qualification_settings WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  if (result.rowCount && result.rowCount > 0) {
    return Number(result.rows[0].min_score_to_qualify);
  }
  return QUALIFIED_SCORE_THRESHOLD;
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
