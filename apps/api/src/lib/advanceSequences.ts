import type { PoolClient } from "pg";
import { checkSendEligibility } from "./suppression.js";

/**
 * advanceDueEnrollments: the real, working engine behind roadmap item 10
 * ("Build editable sequences... Day 0 email, Day 3 call task, Day 7
 * follow-up email, Day 14 final note").
 *
 * For every 'active' sequence_enrollments row in the given tenant/project
 * whose sequence is_active, this finds the step at current_step_order and,
 * if `now() >= enrolled_at + step.day_offset days`, processes it:
 *
 *   - call_task / linkedin_task  -> inserts an open crm_tasks row (roadmap
 *     item 11: "Calls and manual LinkedIn messages as tasks in the CRM, not
 *     automation") with sequence_enrollment_id set, then advances the step.
 *   - email / follow_up_email    -> looks up a matching message_draft_variants
 *     row for this lead + channel (best-effort; the message_drafts/
 *     message_draft_variants tables are owned by a different, parallel
 *     effort — see routes/sequences.ts's header comment for the contract).
 *     If one exists, the step is advanced — that is as far as "sending"
 *     goes in this codebase today; a real send integration plugs in exactly
 *     here. If none exists, the step is left un-advanced (retried on the
 *     next call) and recorded in `skipped`, since fabricating message
 *     content is never acceptable.
 *   - final_note                 -> a plain internal note step with no
 *     external dependency; always advances once due.
 *
 * Before processing an email/call_task step, checkSendEligibility() (see
 * apps/api/src/lib/suppression.ts, roadmap item 18) is consulted so a
 * suppressed/non-consenting lead's step is skipped rather than fired. An
 * ineligible step is NOT advanced (so it is retried once eligibility
 * changes) and its enrollment/reason is recorded in `skipped` — this never
 * fails the whole batch.
 *
 * linkedin_task is a manual, human-driven CRM task (not an automated send),
 * and checkSendEligibility()'s channel union (email/whatsapp/phone/sms) has
 * no "linkedin" member — so no eligibility check applies to it; this is a
 * deliberate scope choice, not an oversight.
 *
 * Once current_step_order moves past the last step in the sequence, the
 * enrollment is marked 'completed'.
 *
 * There is no scheduler/cron wired up to call this automatically yet (see
 * POST .../sequences/advance in routes/sequences.ts) — a future scheduled
 * job should call it periodically (e.g. every few minutes) per
 * tenant/project, or across all active tenants/projects.
 */

export interface AdvanceSkipReason {
  enrollmentId: string;
  reason: string;
}

export interface AdvanceResult {
  advanced: number;
  tasksCreated: number;
  skipped: AdvanceSkipReason[];
}

const TASK_STEP_TYPES = new Set(["call_task", "linkedin_task"]);
const EMAIL_STEP_TYPES = new Set(["email", "follow_up_email"]);

interface DueRow {
  enrollment_id: string;
  sequence_id: string;
  lead_id: string;
  current_step_order: number;
  step_order: number;
  step_type: string;
  message_draft_variant_channel: string | null;
  task_instructions: string | null;
  lead_email: string | null;
}

function mapStepTypeToChannel(stepType: string): "email" | "phone" | null {
  if (EMAIL_STEP_TYPES.has(stepType)) return "email";
  if (stepType === "call_task") return "phone";
  return null; // linkedin_task / final_note: no eligibility-checked channel
}

export async function advanceDueEnrollments(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<AdvanceResult> {
  const result: AdvanceResult = { advanced: 0, tasksCreated: 0, skipped: [] };

  // 1. Enrollments that have run past the last step of their sequence are
  // marked completed (no sequence_steps row left at their current_step_order).
  await tenantDb.query(
    `UPDATE sequence_enrollments se
     SET status = 'completed'
     FROM sequences s
     WHERE se.sequence_id = s.id
       AND se.tenant_id = $1
       AND s.project_id = $2
       AND se.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM sequence_steps ss
         WHERE ss.sequence_id = se.sequence_id AND ss.tenant_id = se.tenant_id AND ss.step_order = se.current_step_order
       )`,
    [tenantId, projectId],
  );

  // 2. Enrollments whose current step is due to fire now.
  const due = await tenantDb.query<DueRow>(
    `SELECT se.id AS enrollment_id, se.sequence_id, se.lead_id, se.current_step_order,
            ss.step_order, ss.step_type, ss.message_draft_variant_channel, ss.task_instructions,
            l.email AS lead_email
     FROM sequence_enrollments se
     JOIN sequences s ON s.id = se.sequence_id AND s.tenant_id = se.tenant_id
     JOIN sequence_steps ss ON ss.sequence_id = se.sequence_id AND ss.tenant_id = se.tenant_id AND ss.step_order = se.current_step_order
     JOIN leads l ON l.id = se.lead_id AND l.tenant_id = se.tenant_id
     WHERE se.tenant_id = $1
       AND s.project_id = $2
       AND se.status = 'active'
       AND s.is_active = true
       AND now() >= se.enrolled_at + (ss.day_offset * interval '1 day')`,
    [tenantId, projectId],
  );

  for (const row of due.rows) {
    const channel = mapStepTypeToChannel(row.step_type);

    if (channel) {
      const eligibility = await checkSendEligibility(tenantDb, tenantId, {
        leadId: row.lead_id,
        email: row.lead_email,
        channel,
      });
      if (!eligibility.eligible) {
        result.skipped.push({
          enrollmentId: row.enrollment_id,
          reason: `ineligible:${eligibility.blockReasons.join(",")}`,
        });
        continue; // do NOT advance — retried once eligible
      }
    }

    if (TASK_STEP_TYPES.has(row.step_type)) {
      await tenantDb.query(
        `INSERT INTO crm_tasks (tenant_id, project_id, lead_id, task_type, title, instructions, status, due_at, sequence_enrollment_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', now(), $7)`,
        [
          tenantId,
          projectId,
          row.lead_id,
          row.step_type === "call_task" ? "call" : "linkedin_message",
          `Sequence step: ${row.step_type} (step ${row.step_order})`,
          row.task_instructions,
          row.enrollment_id,
        ],
      );
      result.tasksCreated += 1;
      await advanceEnrollmentStep(tenantDb, tenantId, row.enrollment_id, row.step_order);
      result.advanced += 1;
      continue;
    }

    if (EMAIL_STEP_TYPES.has(row.step_type)) {
      const draftChannel = row.message_draft_variant_channel ?? "email";
      const variant = await tenantDb.query(
        `SELECT mdv.id
         FROM message_draft_variants mdv
         JOIN message_drafts md ON md.id = mdv.message_draft_id AND md.tenant_id = mdv.tenant_id
         WHERE mdv.tenant_id = $1 AND md.lead_id = $2 AND mdv.channel = $3
         ORDER BY mdv.created_at DESC
         LIMIT 1`,
        [tenantId, row.lead_id, draftChannel],
      );
      if ((variant.rowCount ?? 0) === 0) {
        result.skipped.push({ enrollmentId: row.enrollment_id, reason: "no_matching_draft_variant" });
        continue; // do NOT advance — no content to act on, don't fabricate
      }
      // A real send integration would dispatch mdv here. None exists yet in
      // this codebase, so advancing the step is as far as this goes.
      await advanceEnrollmentStep(tenantDb, tenantId, row.enrollment_id, row.step_order);
      result.advanced += 1;
      continue;
    }

    // final_note (or any other non-task, non-email step type): no external
    // dependency, advance directly once due.
    await advanceEnrollmentStep(tenantDb, tenantId, row.enrollment_id, row.step_order);
    result.advanced += 1;
  }

  return result;
}

async function advanceEnrollmentStep(
  tenantDb: PoolClient,
  tenantId: string,
  enrollmentId: string,
  currentStepOrder: number,
): Promise<void> {
  await tenantDb.query(
    `UPDATE sequence_enrollments
     SET current_step_order = $3
     WHERE id = $1 AND tenant_id = $2 AND current_step_order = $4 AND status = 'active'`,
    [enrollmentId, tenantId, currentStepOrder + 1, currentStepOrder],
  );
}
