import type { PoolClient } from "pg";
import { assertActiveTenantMember } from "./salesPipeline.js";

/**
 * Phase 2 (Section B, "assign leads to sales representatives"): a thin
 * wrapper around `lead_assignments` (279_create_lead_assignments.sql,
 * already existed before this pass — this file just adds the missing
 * read/write helpers, it does not reinvent the table). Per that
 * migration's own doc comment: this is a history table, not a mutable
 * "assigned to" column — every assignment (including reassignment) inserts
 * a new row, and "who is this lead currently assigned to" is always "the
 * most recent row for this lead_id."
 *
 * Shared between the new deals/leadAssignments routes and the new activity
 * timeline (both need "who is this lead assigned to right now") so neither
 * track reimplements the same query.
 */

export interface LeadAssignmentRow {
  id: string;
  leadId: string;
  assignedUserId: string;
  assignedBy: string | null;
  assignedAt: string;
}

function mapRow(row: {
  id: string;
  lead_id: string;
  assigned_user_id: string;
  assigned_by: string | null;
  assigned_at: string;
}): LeadAssignmentRow {
  return {
    id: row.id,
    leadId: row.lead_id,
    assignedUserId: row.assigned_user_id,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
  };
}

/**
 * Assigns (or reassigns) a lead to a tenant member. Validates the assignee
 * is a real, currently-active member of this tenant first (never fabricate
 * an assignment to a user who isn't actually on this tenant) — reuses
 * salesPipeline.ts's existing assertActiveTenantMember rather than
 * duplicating that check.
 */
export async function assignLead(
  tenantDb: PoolClient,
  params: {
    tenantId: string;
    projectId: string;
    leadId: string;
    assignedUserId: string;
    assignedBy: string | null;
  },
): Promise<LeadAssignmentRow> {
  await assertActiveTenantMember(tenantDb, params.tenantId, params.assignedUserId);

  const result = await tenantDb.query<{
    id: string;
    lead_id: string;
    assigned_user_id: string;
    assigned_by: string | null;
    assigned_at: string;
  }>(
    `INSERT INTO lead_assignments (tenant_id, project_id, lead_id, assigned_user_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, lead_id, assigned_user_id, assigned_by, assigned_at`,
    [params.tenantId, params.projectId, params.leadId, params.assignedUserId, params.assignedBy],
  );
  return mapRow(result.rows[0]);
}

/** The most recent assignment row for a lead, or null if it has never been assigned. */
export async function getCurrentAssignment(tenantDb: PoolClient, leadId: string): Promise<LeadAssignmentRow | null> {
  const result = await tenantDb.query<{
    id: string;
    lead_id: string;
    assigned_user_id: string;
    assigned_by: string | null;
    assigned_at: string;
  }>(
    `SELECT id, lead_id, assigned_user_id, assigned_by, assigned_at
     FROM lead_assignments
     WHERE lead_id = $1
     ORDER BY assigned_at DESC
     LIMIT 1`,
    [leadId],
  );
  return result.rowCount ? mapRow(result.rows[0]) : null;
}

/** Full reassignment history for a lead, most recent first — the
 * auditable trail the 279 migration's doc comment describes. */
export async function getAssignmentHistory(tenantDb: PoolClient, leadId: string): Promise<LeadAssignmentRow[]> {
  const result = await tenantDb.query<{
    id: string;
    lead_id: string;
    assigned_user_id: string;
    assigned_by: string | null;
    assigned_at: string;
  }>(
    `SELECT id, lead_id, assigned_user_id, assigned_by, assigned_at
     FROM lead_assignments
     WHERE lead_id = $1
     ORDER BY assigned_at DESC`,
    [leadId],
  );
  return result.rows.map(mapRow);
}
