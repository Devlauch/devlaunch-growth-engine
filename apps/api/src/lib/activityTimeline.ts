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
 *   - audit_events: id, tenant_id, actor_type, actor_user_id,
 *     actor_agent_instance_id, action, entity_type, entity_id, metadata,
 *     created_at (packages/db/migrations/012_create_audit_events.sql).
 *     This is the fix for a real, confirmed gap: lifecycle actions on a
 *     lead that don't land in any of the six tables above — most notably
 *     routes/leadPromotion.ts's POST .../promote-to-crm (action
 *     'lead.promoted_to_crm'), routes/discovery.ts's POST .../promote-to-
 *     lead (action 'lead.promoted_from_discovery'), lib/leadIngestion.ts's
 *     initial capture (action 'lead.created'), and routes/deals.ts's
 *     'lead.assigned' — were previously invisible on this timeline even
 *     though a real row was already being written for every one of them.
 *     No new write path was added; this just reads the audit_events rows
 *     that already existed for entity_type = 'lead' and entity_id =
 *     leadId. audit_events has no project_id column of its own, so this
 *     query scopes by tenant_id + entity_id only — safe because leadId is
 *     a globally-unique uuid the caller (routes/leadActivity.ts) already
 *     verified belongs to this tenant+project before calling here.
 *
 * KNOWN LIMITATION (documented honestly rather than fabricated): deals has
 * no stage-history table, only the single `stage_changed_at` timestamp for
 * its CURRENT stage. So a deal contributes exactly one 'stage_change' item
 * to the timeline — the most recent transition — not a full history of
 * every stage it has ever passed through. If finer-grained stage history
 * is ever needed, that requires a real deal_stage_history table (out of
 * scope here); this function does not invent one.
 *
 * --- Phase 2 reconciliation additions (Agent C2) ---
 *
 * The event types below were ported from the independently-built
 * milestone3-phase2 branch's activityTimeline.ts, adapted to the columns
 * that actually exist on THIS tree (verified against the real migrations,
 * not assumed from the other branch):
 *   - lead_created: leads.source/origin/custom_fields/created_at
 *     (015_create_leads.sql)
 *   - lead_scored: lead_scores.total_score/why_summary/computed_at
 *     (032_create_lead_scores.sql)
 *   - deal_created: deals.created_at (278_create_deals.sql) — a second,
 *     distinct item from the existing 'stage_change' item, which uses
 *     stage_changed_at. A deal therefore now contributes up to two items:
 *     its creation and its latest stage.
 *   - crm_task_created: crm_tasks.created_at (049_create_crm_tasks.sql) —
 *     likewise a second, distinct item alongside the existing 'task' item
 *     (latest status via updated_at).
 *   - discovery_sourced: ONLY when leads.custom_fields.discoveredOrganizationId
 *     is present (the actual convention apps/api/src/routes/discovery.ts's
 *     promote-to-lead endpoint uses on this tree). Phase 2's version joined
 *     through a `prospecting_campaign_organizations` table and read a
 *     `discovered_contacts.source_provider` column — NEITHER exists on this
 *     tree. This tree's actual schema links a discovered org to a campaign
 *     via a direct `discovered_organizations.prospecting_campaign_id` FK
 *     (323_create_prospecting_campaigns.sql), so the query below joins
 *     through that column instead, and drops the fabricated
 *     source_provider read entirely rather than guessing at one.
 *
 * Deliberately NOT ported (merge reconciliation, orchestrator — this file
 * does not guess at an interface that didn't exist when each piece landed):
 *   - deal_stage won/lost reason: phase2's deal_stage item reads
 *     deals.lost_reason / deals.won_reason. These columns now exist on this
 *     tree (packages/db/migrations/442_add_outcome_reasons_to_deals.sql,
 *     merged alongside this file) — surfacing them on the 'stage_change'
 *     item's `detail` is a small, well-scoped follow-up, not done here to
 *     keep this merge change strictly additive/mechanical.
 *   - crm_task_status as a distinct item kind: phase2 emitted a separate
 *     'crm_task_status' entry for completed/skipped tasks. This tree's
 *     existing 'task' item already surfaces the task's current status at
 *     its updated_at timestamp (crm_tasks has no dedicated
 *     completed_at/status-changed-at column, same limitation phase2 itself
 *     documented) — adding a second, separately-labeled item for the same
 *     single column would duplicate the same fact under two different
 *     labels, not add real information. Not ported; 'task' already covers
 *     this.
 */

export type ActivityItemType =
  | "assignment"
  | "stage_change"
  | "meeting"
  | "task"
  | "note"
  | "reply"
  | "audit_event"
  | "lead_created"
  | "discovery_sourced"
  | "lead_scored"
  | "deal_created"
  | "crm_task_created";

/** "lead.promoted_to_crm" -> "lead promoted to crm" — a plain reformat of
 * the real action string already recorded on the audit_events row, never a
 * guessed/invented description. */
function humanizeAuditAction(action: string): string {
  return action.replace(/[._]/g, " ");
}

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
  // The route (leadActivity.ts) already confirmed this lead exists in this
  // tenant/project with a cheap `SELECT 1` before ever calling this
  // function — this is a second, deliberate query because that existence
  // check never reads the columns actually needed here (source/origin/
  // custom_fields/created_at, for the 'lead_created' item and to detect
  // discovery provenance below). Not folded into one query: the route's
  // existence check and this lib's own data needs are separate concerns
  // (same separation of concerns as every other table this file reads).
  const leadResult = await tenantDb.query(
    `SELECT source, origin, custom_fields, created_at
     FROM leads
     WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, tenantId, projectId],
  );
  const leadRow = leadResult.rows[0] as
    | { source: string; origin: string | null; custom_fields: Record<string, unknown>; created_at: string }
    | undefined;

  const [assignments, deals, meetings, tasks, notes, replies, auditEvents, scores] = await Promise.all([
    tenantDb.query(
      `SELECT id, assigned_user_id, assigned_by, assigned_at
       FROM lead_assignments
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
       ORDER BY assigned_at DESC`,
      [tenantId, projectId, leadId],
    ),
    tenantDb.query(
      `SELECT id, stage, value_amount, stage_changed_at, created_at
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
      `SELECT id, task_type, title, status, due_at, updated_at, created_at
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
    tenantDb.query(
      `SELECT id, action, metadata, created_at
       FROM audit_events
       WHERE tenant_id = $1 AND entity_type = 'lead' AND entity_id = $2
       ORDER BY created_at DESC`,
      [tenantId, leadId],
    ),
    // lead_scores: at most one row per lead (UNIQUE (lead_id), see
    // 032_create_lead_scores.sql) — the lead's current computed score, not
    // a history of every recomputation.
    tenantDb.query(
      `SELECT id, total_score, why_summary, computed_at
       FROM lead_scores
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
      [tenantId, projectId, leadId],
    ),
  ]);

  const items: ActivityItem[] = [];

  if (leadRow) {
    items.push({
      type: "lead_created",
      timestamp: leadRow.created_at,
      summary: `Lead created (source: ${leadRow.source})`,
      detail: leadRow.origin ? `Origin: ${leadRow.origin}` : null,
      sourceId: leadId,
    });
  }

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
    created_at: string;
  }>) {
    // Ported from phase2 (Agent C2): the deal's own creation is a distinct,
    // real event from its latest stage — see this file's header comment for
    // why 'stage_change' alone (the pre-existing item) can only ever show
    // the CURRENT stage, never the deal's full history.
    items.push({
      type: "deal_created",
      timestamp: row.created_at,
      summary: "Deal created",
      detail: null,
      sourceId: row.id,
    });
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
    created_at: string;
  }>) {
    // Ported from phase2 (Agent C2): the task's own creation is a distinct
    // real event from its current status (the pre-existing 'task' item
    // below, which can only ever show the CURRENT status via updated_at —
    // see this file's header comment for why a separate 'crm_task_status'
    // item type was deliberately NOT also added).
    items.push({
      type: "crm_task_created",
      timestamp: row.created_at,
      summary: `CRM task created: ${row.title}`,
      detail: null,
      sourceId: row.id,
    });
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

  for (const row of auditEvents.rows as Array<{
    id: string;
    action: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>) {
    const metadata = row.metadata ?? {};
    items.push({
      type: "audit_event",
      timestamp: row.created_at,
      summary: humanizeAuditAction(row.action),
      detail: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      sourceId: row.id,
    });
  }

  // Ported from phase2 (Agent C2): at most one row (UNIQUE (lead_id), see
  // 032_create_lead_scores.sql) — the lead's current computed score.
  for (const row of scores.rows as Array<{
    id: string;
    total_score: string | number;
    why_summary: string;
    computed_at: string;
  }>) {
    items.push({
      type: "lead_scored",
      timestamp: row.computed_at,
      summary: `Lead scored ${Number(row.total_score)}/100`,
      detail: row.why_summary,
      sourceId: row.id,
    });
  }

  // Ported from phase2 (Agent C2), adapted to this tree's actual schema
  // (see this file's header comment for the full rationale): only emitted
  // when the lead was sourced from discovery, detected the same way
  // discovery.ts's promote-to-lead endpoint itself records it —
  // custom_fields.discoveredOrganizationId. A single query, joined through
  // this tree's real `discovered_organizations.prospecting_campaign_id`
  // direct FK (not phase2's non-existent junction table), never fabricates
  // a provider/campaign when the underlying rows don't show one.
  const discoveredOrganizationId =
    leadRow && typeof leadRow.custom_fields?.discoveredOrganizationId === "string"
      ? (leadRow.custom_fields.discoveredOrganizationId as string)
      : null;
  if (discoveredOrganizationId) {
    const discoveryResult = await tenantDb.query(
      `SELECT o.id, o.name, o.source_url, o.discovered_at,
              ds.name AS discovery_source_name,
              ds.connector_type AS discovery_source_connector_type,
              pc.name AS campaign_name
       FROM discovered_organizations o
       LEFT JOIN discovery_sources ds ON ds.id = o.discovery_source_id
       LEFT JOIN prospecting_campaigns pc ON pc.id = o.prospecting_campaign_id
       WHERE o.id = $1 AND o.tenant_id = $2 AND o.project_id = $3`,
      [discoveredOrganizationId, tenantId, projectId],
    );
    const org = discoveryResult.rows[0] as
      | {
          id: string;
          name: string;
          source_url: string | null;
          discovered_at: string;
          discovery_source_name: string | null;
          discovery_source_connector_type: string | null;
          campaign_name: string | null;
        }
      | undefined;
    if (org) {
      // row gone (e.g. hard-deleted) — never invent one
      const providerLabel = org.discovery_source_name ?? org.discovery_source_connector_type;
      const detailParts: string[] = [];
      if (org.campaign_name) detailParts.push(`Campaign: ${org.campaign_name}`);
      if (org.name) detailParts.push(`Org: ${org.name}`);
      items.push({
        type: "discovery_sourced",
        timestamp: org.discovered_at,
        summary: providerLabel ? `Discovered via ${providerLabel}` : "Discovered",
        detail: detailParts.length > 0 ? detailParts.join(" | ") : null,
        sourceId: org.id,
      });
    }
  }

  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return items;
}
