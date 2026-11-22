import type { PoolClient } from "pg";
import { Errors } from "./httpError.js";

/**
 * salesPipeline.ts: the real logic behind the Sales Conversion Agent
 * (roadmap items 6/7) that isn't simple CRUD — lead assignment validation,
 * stage-transition bookkeeping, and the two automatic follow-up triggers
 * ("Follow-up task automation"): a deal stalled in a non-terminal stage too
 * long, and a meeting outcome that needs a next step.
 *
 * Every automatically-created follow-up reuses the existing crm_tasks
 * table (049_create_crm_tasks.sql) for the actual task row — the same
 * real, trackable task shape apps/api/src/lib/advanceSequences.ts already
 * uses for call_task/linkedin_task sequence steps — rather than inventing
 * a second task model. follow_up_tasks
 * (281_create_follow_up_tasks.sql) is metadata only: which deal/meeting
 * triggered it and why, so the automatic checks below never create a
 * duplicate follow-up for the same stalled deal or the same meeting
 * outcome.
 */

export const DEAL_STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const TERMINAL_DEAL_STAGES = new Set<DealStage>(["won", "lost"]);

// How long a deal may sit in one non-terminal stage before it is
// considered stalled and gets an automatic follow-up task. A single,
// documented threshold rather than per-stage tuning — this is an MVP
// heuristic, not a configurable SLA engine.
export const STAGE_STALL_THRESHOLD_DAYS = 7;

export interface StalledFollowUpResult {
  dealId: string;
  leadId: string;
  crmTaskId: string;
  followUpTaskId: string;
}

/**
 * Scans this tenant/project's non-terminal deals for ones whose stage has
 * not changed in STAGE_STALL_THRESHOLD_DAYS, and ensures each has exactly
 * one OPEN auto-created follow-up (crm_tasks + follow_up_tasks row). A deal
 * that already has an open stage_stalled follow-up is left alone — this is
 * idempotent and safe to call repeatedly (e.g. from a manual "check
 * stalled deals" action; there is no cron/scheduler infra in this codebase
 * — see apps/api/src/lib/advanceSequences.ts's header comment, same gap,
 * same workaround: a manually-triggered POST endpoint).
 */
export async function checkStalledDeals(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<StalledFollowUpResult[]> {
  const stalled = await tenantDb.query<{
    id: string;
    lead_id: string;
    stage: string;
    owner_user_id: string | null;
    stage_changed_at: string;
  }>(
    `SELECT d.id, d.lead_id, d.stage, d.owner_user_id, d.stage_changed_at
     FROM deals d
     WHERE d.tenant_id = $1 AND d.project_id = $2
       AND d.stage NOT IN ('won', 'lost')
       AND d.stage_changed_at < now() - ($3 * interval '1 day')
       AND NOT EXISTS (
         SELECT 1 FROM follow_up_tasks fut
         JOIN crm_tasks ct ON ct.id = fut.crm_task_id AND ct.tenant_id = fut.tenant_id
         WHERE fut.tenant_id = $1 AND fut.deal_id = d.id
           AND fut.trigger_reason = 'stage_stalled'
           AND ct.status = 'open'
       )`,
    [tenantId, projectId, STAGE_STALL_THRESHOLD_DAYS],
  );

  const created: StalledFollowUpResult[] = [];
  for (const deal of stalled.rows) {
    const crmTask = await tenantDb.query<{ id: string }>(
      `INSERT INTO crm_tasks (tenant_id, project_id, lead_id, task_type, title, instructions, status, due_at, assigned_user_id)
       VALUES ($1, $2, $3, 'follow_up', $4, $5, 'open', now(), $6)
       RETURNING id`,
      [
        tenantId,
        projectId,
        deal.lead_id,
        `Deal stalled in '${deal.stage}' for over ${STAGE_STALL_THRESHOLD_DAYS} days`,
        `This deal has not changed stage since ${deal.stage_changed_at}. Follow up with the lead or update the deal's stage.`,
        deal.owner_user_id,
      ],
    );
    const followUp = await tenantDb.query<{ id: string }>(
      `INSERT INTO follow_up_tasks (tenant_id, project_id, lead_id, deal_id, crm_task_id, trigger_reason)
       VALUES ($1, $2, $3, $4, $5, 'stage_stalled')
       RETURNING id`,
      [tenantId, projectId, deal.lead_id, deal.id, crmTask.rows[0].id],
    );
    created.push({
      dealId: deal.id,
      leadId: deal.lead_id,
      crmTaskId: crmTask.rows[0].id,
      followUpTaskId: followUp.rows[0].id,
    });
  }
  return created;
}

/**
 * Called after a meeting's outcome is recorded (PATCH .../meetings/:id).
 * Creates exactly one automatic follow-up when the outcome itself implies a
 * human needs to act next:
 *   - 'no_show'              -> always needs a follow-up (reschedule/decide).
 *   - 'completed' + next_step set -> the rep recorded a concrete next step,
 *     which becomes the follow-up task's instructions.
 *   - 'completed' with no next_step, 'rescheduled', 'cancelled' -> no
 *     automatic follow-up (rescheduled already implies a new meetings row;
 *     cancelled needs no action; a completed meeting with no stated next
 *     step is not assumed to need one — never invent a next step that
 *     wasn't recorded).
 * Idempotent per meeting (one meeting_outcome follow-up per meeting id).
 */
export async function createMeetingOutcomeFollowUpIfNeeded(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  meeting: { id: string; lead_id: string; deal_id: string | null; status: string; next_step: string | null },
): Promise<StalledFollowUpResult | null> {
  const needsFollowUp =
    meeting.status === "no_show" || (meeting.status === "completed" && Boolean(meeting.next_step));
  if (!needsFollowUp) return null;

  const existing = await tenantDb.query(
    `SELECT 1 FROM follow_up_tasks WHERE tenant_id = $1 AND meeting_id = $2 AND trigger_reason = 'meeting_outcome'`,
    [tenantId, meeting.id],
  );
  if ((existing.rowCount ?? 0) > 0) return null;

  const title =
    meeting.status === "no_show"
      ? "Lead was a no-show — follow up to reschedule"
      : "Meeting completed — act on the recorded next step";
  const instructions = meeting.status === "no_show" ? "Reach out to reschedule the meeting." : meeting.next_step;

  const crmTask = await tenantDb.query<{ id: string }>(
    `INSERT INTO crm_tasks (tenant_id, project_id, lead_id, task_type, title, instructions, status, due_at)
     VALUES ($1, $2, $3, 'follow_up', $4, $5, 'open', now())
     RETURNING id`,
    [tenantId, projectId, meeting.lead_id, title, instructions],
  );
  const followUp = await tenantDb.query<{ id: string }>(
    `INSERT INTO follow_up_tasks (tenant_id, project_id, lead_id, deal_id, meeting_id, crm_task_id, trigger_reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'meeting_outcome')
     RETURNING id`,
    [tenantId, projectId, meeting.lead_id, meeting.deal_id, meeting.id, crmTask.rows[0].id],
  );

  return {
    dealId: meeting.deal_id ?? "",
    leadId: meeting.lead_id,
    crmTaskId: crmTask.rows[0].id,
    followUpTaskId: followUp.rows[0].id,
  };
}

/**
 * Validates that `userId` is a real, active member of this tenant before
 * it can be used as a lead assignee / deal owner — the same "attach a real
 * users row, never fabricate one" invariant
 * apps/api/src/routes/memberships.ts documents for invites. Read-only
 * against `memberships` (that file is mid-edit elsewhere and out of scope
 * to modify, but its table is freely queryable).
 */
export async function assertActiveTenantMember(
  tenantDb: PoolClient,
  tenantId: string,
  userId: string,
): Promise<void> {
  const result = await tenantDb.query(
    `SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
    [tenantId, userId],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw Errors.badRequest("assignedUserId must be an active member of this tenant");
  }
}
