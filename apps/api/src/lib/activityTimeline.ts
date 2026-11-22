import type { PoolClient } from "pg";

/**
 * Unified activity timeline for a single lead (CRM module "Activity
 * timeline"). This is a READ-ONLY aggregation over existing tables — NOT a
 * new duplicate event-log table. Every item below is produced by a real
 * query against a table that already exists for its own reason
 * (lead_assignments, deals, meetings, crm_tasks, notes); nothing here is
 * written or cached anywhere.
 *
 * Column names were verified against the actual migrations/routes, not
 * guessed:
 *   - lead_assignments: id, tenant_id, project_id, lead_id, assigned_user_id,
 *     assigned_by, assigned_at, created_at
 *     (packages/db/migrations/279_create_lead_assignments.sql)
 *   - deals: id, tenant_id, project_id, lead_id, stage, value_amount,
 *     stage_changed_at, created_at, updated_at
 *     (packages/db/migrations/278_create_deals.sql,
 *     apps/api/src/routes/deals.ts's DEAL_COLUMNS)
 *   - meetings: id, tenant_id, project_id, lead_id, deal_id, type,
 *     scheduled_at, status, outcome_notes, next_step, created_at
 *     (packages/db/migrations/280_create_meetings.sql,
 *     apps/api/src/routes/meetings.ts's MEETING_COLUMNS)
 *   - crm_tasks: id, tenant_id, project_id, lead_id, task_type, title,
 *     status, due_at, assigned_user_id, created_at, updated_at
 *     (packages/db/migrations/049_create_crm_tasks.sql)
 *   - notes: id, tenant_id, project_id, lead_id, deal_id, company_id,
 *     contact_id, body, created_by, created_at, updated_at
 *     (packages/db/migrations/312_create_notes.sql)
 *   - lead_replies: id, tenant_id, project_id, lead_id, channel, raw_content,
 *     classification, classification_confidence, received_at, created_at
 *     (packages/db/migrations/058_create_lead_replies.sql)
 *
 * KNOWN LIMITATION (documented honestly rather than fabricated): deals has
 * no stage-history table, only the single `stage_changed_at` timestamp for
 * its CURRENT stage. So a deal contributes exactly one 'stage_change' item
 * to the timeline — the most recent transition — not a full history of
 * every stage it has ever passed through. If finer-grained stage history
 * is ever needed, that requires a real deal_stage_history table (out of
 * scope here); this function does not invent one.
 */

export type ActivityItemType = "assignment" | "stage_change" | "meeting" | "task" | "note" | "reply";

export interface ActivityItem {
  type: ActivityItemType;
  timestamp: string;
  summary: string;
  detail: string | null;
  sourceId: string;
}

interface QueryableDb {
  query: PoolClient["query"];
}

/**
 * Returns the full activity timeline for one lead, newest first. Every
 * query is scoped to tenant_id + project_id + lead_id — RLS (already
 * scoped to tenant via app.current_tenant_id on req.tenantDb) is the real
 * isolation boundary; the explicit WHERE clauses here are defense in depth
 * / so this also reads correctly if ever called with a plain pool client.
 */
export async function getLeadActivityTimeline(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<ActivityItem[]> {
  const [assignments, deals, meetings, tasks, notes, replies] = await Promise.all([
    tenantDb.query(
      `SELECT id, assigned_user_id, assigned_by, assigned_at
       FROM lead_assignments
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
       ORDER BY assigned_at DESC`,
      [tenantId, projectId, leadId],
    ),
    tenantDb.query(
      `SELECT id, stage, value_amount, stage_changed_at
       FROM deals
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
      [tenantId, projectId, leadId],
    ),
    tenantDb.query(
      `SELECT id, type, status, scheduled_at, outcome_notes, next_step
       FROM meetings
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
       ORDER BY scheduled_at DESC`,
      [tenantId, projectId, leadId],
    ),
    tenantDb.query(
      `SELECT id, task_type, title, status, due_at, updated_at
       FROM crm_tasks
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
       ORDER BY updated_at DESC`,
      [tenantId, projectId, leadId],
    ),
    tenantDb.query(
      `SELECT id, body, created_at
       FROM notes
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
       ORDER BY created_at DESC`,
      [tenantId, projectId, leadId],
    ),
    tenantDb.query(
      `SELECT id, channel, classification, classification_confidence, received_at
       FROM lead_replies
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
       ORDER BY received_at DESC`,
      [tenantId, projectId, leadId],
    ),
  ]);

  const items: ActivityItem[] = [];

  for (const row of assignments.rows as Array<{
    id: string;
    assigned_user_id: string;
    assigned_by: string | null;
    assigned_at: string;
  }>) {
    items.push({
      type: "assignment",
      timestamp: row.assigned_at,
      summary: `Lead assigned to user ${row.assigned_user_id}`,
      detail: row.assigned_by ? `Assigned by user ${row.assigned_by}` : null,
      sourceId: row.id,
    });
  }

  for (const row of deals.rows as Array<{
    id: string;
    stage: string;
    value_amount: string | null;
    stage_changed_at: string;
  }>) {
    // See this file's header comment: one entry per deal (its latest
    // transition only), never a fabricated full stage history.
    items.push({
      type: "stage_change",
      timestamp: row.stage_changed_at,
      summary: `Deal moved to stage "${row.stage}"`,
      detail: row.value_amount ? `Value: ${row.value_amount}` : null,
      sourceId: row.id,
    });
  }

  for (const row of meetings.rows as Array<{
    id: string;
    type: string;
    status: string;
    scheduled_at: string;
    outcome_notes: string | null;
    next_step: string | null;
  }>) {
    const detailParts: string[] = [];
    if (row.outcome_notes) detailParts.push(`Outcome: ${row.outcome_notes}`);
    if (row.next_step) detailParts.push(`Next step: ${row.next_step}`);
    items.push({
      type: "meeting",
      timestamp: row.scheduled_at,
      summary: `${row.type === "demo" ? "Demo" : "Call"} meeting — ${row.status}`,
      detail: detailParts.length > 0 ? detailParts.join(" | ") : null,
      sourceId: row.id,
    });
  }

  for (const row of tasks.rows as Array<{
    id: string;
    task_type: string;
    title: string;
    status: string;
    due_at: string | null;
    updated_at: string;
  }>) {
    items.push({
      type: "task",
      // updated_at is the best available signal for "when this task's
      // current status happened" — crm_tasks has no separate
      // completed_at/status-changed-at column (049_create_crm_tasks.sql).
      timestamp: row.updated_at,
      summary: `Task "${row.title}" (${row.task_type}) — ${row.status}`,
      detail: row.due_at ? `Due: ${row.due_at}` : null,
      sourceId: row.id,
    });
  }

  for (const row of notes.rows as Array<{ id: string; body: string; created_at: string }>) {
    items.push({
      type: "note",
      timestamp: row.created_at,
      summary: "Note added",
      detail: row.body.length > 280 ? `${row.body.slice(0, 280)}…` : row.body,
      sourceId: row.id,
    });
  }

  for (const row of replies.rows as Array<{
    id: string;
    channel: string;
    classification: string;
    classification_confidence: string;
    received_at: string;
  }>) {
    items.push({
      type: "reply",
      timestamp: row.received_at,
      summary: `Reply received via ${row.channel} — classified "${row.classification}" (${row.classification_confidence} confidence)`,
      detail: null,
      sourceId: row.id,
    });
  }

  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return items;
}
