import type { PoolClient } from "pg";
import { checkSendEligibility } from "./suppression.js";
import { getEmailProvider, NotConfiguredError, type EmailProvider } from "./emailProvider.js";
import {
  getWhatsAppProviderForTenant,
  NotConfiguredError as ChannelNotConfiguredError,
  type WhatsAppProvider,
} from "./channelProviders.js";

/**
 * advanceDueEnrollments: the real, working engine behind roadmap item 10
 * ("Build editable sequences... Day 0 email, Day 3 call task, Day 7
 * follow-up email, Day 14 final note").
 *
 * For every 'active' sequence_enrollments row in the given tenant/project
 * whose sequence is_active, this finds the step at current_step_order and,
 * if `now() >= enrolled_at + (step.day_offset * enrollment.cadence_multiplier)
 * days`, processes it. `cadence_multiplier` (554_add_cadence_multiplier_to_
 * sequence_enrollments.sql) is how qualification scoring now affects
 * follow-up pacing (Phase 6a): it is set once at enrollment time from the
 * lead's qualification/score via routes/sequences.ts's POST
 * .../enrollments (see lib/leadPromotion.ts's computeCadenceMultiplier) —
 * a well-qualified or high-scoring lead gets a multiplier < 1, so every
 * step in the sequence fires sooner than the sequence's authored
 * day_offset; an unscored/not-yet-qualified lead gets the default 1 (no
 * change from this feature's pre-existing behavior):
 *
 *   - call_task / linkedin_task  -> inserts an open crm_tasks row (roadmap
 *     item 11: "Calls and manual LinkedIn messages as tasks in the CRM, not
 *     automation") with sequence_enrollment_id set, then advances the step.
 *   - email / follow_up_email    -> looks up a matching message_draft_variants
 *     row for this lead + channel that has ALSO passed the real
 *     message_drafts/approvals human approval gate (status = 'approved' —
 *     see apps/api/src/workflow/stages/approvalAndExecution.ts for the
 *     "never flip a draft to approved automatically" rule this respects).
 *     If one exists, a real send is now attempted via emailProvider.send()
 *     (apps/api/src/lib/emailProvider.ts):
 *       - if no EmailProvider is configured in this environment
 *         (NotConfiguredEmailProvider, the default), the send throws
 *         NotConfiguredError, which is caught here and treated exactly as
 *         before this feature existed: the step still advances (that is as
 *         far as "sending" goes without a configured provider), and
 *         nothing is fabricated.
 *       - if a real SmtpEmailProvider IS configured and the send succeeds,
 *         the step advances and `emailsSent` is incremented.
 *       - if a real provider is configured but the send genuinely fails
 *         (network/auth/etc.), the step is NOT advanced (retried next
 *         call) and recorded in `skipped`, exactly like any other
 *         not-ready-yet step.
 *     If no approved, matching draft variant exists at all, the step is
 *     left un-advanced (retried on the next call) and recorded in
 *     `skipped`, since fabricating message content is never acceptable.
 *   - whatsapp                    -> the real WhatsApp Business Cloud API
 *     send path (apps/api/src/lib/whatsAppProvider.ts /
 *     channelProviders.ts's getWhatsAppProviderForTenant()), wired in
 *     exactly like the email step type above — this was previously a
 *     genuine, working HTTP client with ZERO caller anywhere in the send
 *     pipeline. task_instructions on a 'whatsapp' step holds the WhatsApp
 *     message TEMPLATE NAME to send (Meta's Cloud API can only send
 *     pre-approved templates outside an open 24-hour customer-service
 *     window — see whatsAppProvider.ts's header comment); the matching
 *     approved message_draft_variants row (channel = 'whatsapp') supplies
 *     the one personalized template parameter from its `body` column —
 *     never fabricated. The lead's phone number is read from the most
 *     recently created `contacts` row linked to this lead (leads itself
 *     carries no phone column — see 015_create_leads.sql / 307_create_
 *     contacts.sql); no linked contact phone means nowhere real to send,
 *     so the step is skipped, not advanced.
 *       - no WhatsAppProvider configured (NotConfiguredWhatsAppCloudApiProvider,
 *         the default in this environment) -> the send throws
 *         NotConfiguredError and the step still advances, exactly the
 *         email step's "advancing is as far as sending goes" convention.
 *       - a real provider configured and the send succeeds -> step
 *         advances, `whatsappSent` increments.
 *       - a real provider configured but the send genuinely fails -> step
 *         is NOT advanced, recorded in `skipped`.
 *   - final_note                 -> a plain internal note step with no
 *     external dependency; always advances once due.
 *
 * Before processing an email/whatsapp/call_task step, checkSendEligibility()
 * (see apps/api/src/lib/suppression.ts, roadmap item 18) is consulted so a
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
 * STOP ON REPLY: before any due step is processed, every 'active'
 * enrollment whose lead has an inbound reply (lead_replies, see
 * apps/api/src/lib/classifyReply.ts) recorded since it enrolled is halted —
 * status set to 'stopped_replied' — regardless of the reply's
 * classification. This is a deliberate "any reply means a human is now in
 * the loop, stop the automated cadence" rule: continuing to fire a Day-7
 * follow-up at someone who already replied (even "not now") is exactly the
 * kind of tone-deaf automation this sequence engine must not produce.
 * (unsubscribe replies already additionally insert a suppression_list row
 * and get caught by checkSendEligibility too — see routes/replies.ts — this
 * is what makes replies of EVERY classification halt the sequence, not just
 * unsubscribes.) A halted enrollment is excluded from the "due" query below
 * because it only selects status = 'active'.
 *
 * Once current_step_order moves past the last step in the sequence, the
 * enrollment is marked 'completed'.
 *
 * A real recurring caller now exists: apps/worker/src/jobs/
 * sequenceSchedulerCron.ts calls this function on an interval (default
 * every 15 minutes) across every tenant/project with an active sequence —
 * see that file's header comment for exactly how it is wired in. The
 * manual POST .../sequences/advance endpoint in routes/sequences.ts still
 * works too (useful for an on-demand "run it now").
 */

export interface AdvanceSkipReason {
  enrollmentId: string;
  reason: string;
}

export interface AdvanceResult {
  advanced: number;
  tasksCreated: number;
  skipped: AdvanceSkipReason[];
  /** Enrollments halted (status -> 'stopped_replied') because the lead replied since enrolling. */
  stoppedForReply: number;
  /** Real emails actually sent via a configured EmailProvider (SmtpEmailProvider) this call. */
  emailsSent: number;
  /** Real WhatsApp template messages actually sent via a configured WhatsAppProvider this call. */
  whatsappSent: number;
}

export interface AdvanceOptions {
  /** Injectable for tests / alternate providers. Defaults to emailProvider.ts's getEmailProvider(). */
  emailProvider?: EmailProvider;
  /** Injectable for tests / alternate providers. Defaults to channelProviders.ts's getWhatsAppProviderForTenant(). */
  whatsAppProvider?: WhatsAppProvider;
}

const TASK_STEP_TYPES = new Set(["call_task", "linkedin_task"]);
const EMAIL_STEP_TYPES = new Set(["email", "follow_up_email"]);
const WHATSAPP_STEP_TYPES = new Set(["whatsapp"]);

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
  lead_phone: string | null;
}

interface EmailVariantRow {
  id: string;
  subject: string | null;
  body: string;
  sender_identity: string;
}

interface WhatsAppVariantRow {
  id: string;
  body: string;
}

function mapStepTypeToChannel(stepType: string): "email" | "phone" | "whatsapp" | null {
  if (EMAIL_STEP_TYPES.has(stepType)) return "email";
  if (stepType === "call_task") return "phone";
  if (WHATSAPP_STEP_TYPES.has(stepType)) return "whatsapp";
  return null; // linkedin_task / final_note: no eligibility-checked channel
}

export async function advanceDueEnrollments(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  options: AdvanceOptions = {},
): Promise<AdvanceResult> {
  const result: AdvanceResult = {
    advanced: 0,
    tasksCreated: 0,
    skipped: [],
    stoppedForReply: 0,
    emailsSent: 0,
    whatsappSent: 0,
  };
  const emailProvider = options.emailProvider ?? getEmailProvider();
  // Resolved lazily (only the first time a 'whatsapp' step is actually due)
  // rather than eagerly here: resolving it unconditionally would issue an
  // extra credential-lookup query on every call, even for tenants/projects
  // with no whatsapp step in any sequence.
  let whatsAppProvider: WhatsAppProvider | null = options.whatsAppProvider ?? null;
  async function resolveWhatsAppProvider(): Promise<WhatsAppProvider> {
    if (!whatsAppProvider) {
      whatsAppProvider = await getWhatsAppProviderForTenant(tenantDb, tenantId, projectId);
    }
    return whatsAppProvider;
  }

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

  // 1b. STOP ON REPLY (see module doc): halt every still-active enrollment
  // whose lead has replied (any classification) since enrolling, BEFORE
  // selecting due steps, so a just-replied lead never gets a step fired in
  // this same tick.
  const stopForReply = await tenantDb.query(
    `UPDATE sequence_enrollments se
     SET status = 'stopped_replied', stopped_at = now()
     FROM sequences s
     WHERE se.sequence_id = s.id
       AND se.tenant_id = $1
       AND s.project_id = $2
       AND se.status = 'active'
       AND EXISTS (
         SELECT 1 FROM lead_replies lr
         WHERE lr.tenant_id = se.tenant_id AND lr.lead_id = se.lead_id AND lr.received_at >= se.enrolled_at
       )`,
    [tenantId, projectId],
  );
  result.stoppedForReply = stopForReply.rowCount ?? 0;

  // 2. Enrollments whose current step is due to fire now.
  // lead_phone: leads itself carries no phone column (015_create_leads.sql)
  // — the most recently created contacts row linked to this lead
  // (307_create_contacts.sql's lead_id) supplies it, when one exists.
  const due = await tenantDb.query<DueRow>(
    `SELECT se.id AS enrollment_id, se.sequence_id, se.lead_id, se.current_step_order,
            ss.step_order, ss.step_type, ss.message_draft_variant_channel, ss.task_instructions,
            l.email AS lead_email,
            (SELECT c.phone FROM contacts c
             WHERE c.tenant_id = se.tenant_id AND c.lead_id = se.lead_id AND c.phone IS NOT NULL
             ORDER BY c.created_at DESC LIMIT 1) AS lead_phone
     FROM sequence_enrollments se
     JOIN sequences s ON s.id = se.sequence_id AND s.tenant_id = se.tenant_id
     JOIN sequence_steps ss ON ss.sequence_id = se.sequence_id AND ss.tenant_id = se.tenant_id AND ss.step_order = se.current_step_order
     JOIN leads l ON l.id = se.lead_id AND l.tenant_id = se.tenant_id
     WHERE se.tenant_id = $1
       AND s.project_id = $2
       AND se.status = 'active'
       AND s.is_active = true
       AND now() >= se.enrolled_at + (ss.day_offset * se.cadence_multiplier * interval '1 day')`,
    [tenantId, projectId],
  );

  for (const row of due.rows) {
    const channel = mapStepTypeToChannel(row.step_type);

    if (channel) {
      const eligibility = await checkSendEligibility(tenantDb, tenantId, {
        leadId: row.lead_id,
        email: row.lead_email,
        phone: row.lead_phone,
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
      // AND md.status = 'approved' is the approval-gate enforcement (item
      // 7, "approval gate preserved"): a draft that is still 'draft' or
      // 'pending_approval' (or was 'rejected') is NEVER a valid send
      // target, no matter how due the step is — see
      // apps/api/src/workflow/stages/approvalAndExecution.ts's identical
      // rule for the Phase 4 workflow path.
      const variant = await tenantDb.query<EmailVariantRow>(
        `SELECT mdv.id, mdv.subject, mdv.body, mdv.sender_identity
         FROM message_draft_variants mdv
         JOIN message_drafts md ON md.id = mdv.message_draft_id AND md.tenant_id = mdv.tenant_id
         WHERE mdv.tenant_id = $1 AND md.lead_id = $2 AND mdv.channel = $3 AND md.status = 'approved'
         ORDER BY mdv.created_at DESC
         LIMIT 1`,
        [tenantId, row.lead_id, draftChannel],
      );
      if ((variant.rowCount ?? 0) === 0) {
        result.skipped.push({ enrollmentId: row.enrollment_id, reason: "no_matching_draft_variant" });
        continue; // do NOT advance — no approved content to act on, don't fabricate
      }

      if (!row.lead_email) {
        result.skipped.push({ enrollmentId: row.enrollment_id, reason: "lead_has_no_email" });
        continue; // do NOT advance — nowhere to send this real message
      }

      const draftVariant = variant.rows[0];
      let sent = false;
      try {
        await emailProvider.send({
          to: row.lead_email,
          subject: draftVariant.subject ?? "",
          body: draftVariant.body,
          from: draftVariant.sender_identity,
        });
        sent = true;
      } catch (err) {
        if (err instanceof NotConfiguredError) {
          // No real EmailProvider configured in this environment — this is
          // the honest "advancing the step is as far as sending goes"
          // behavior this engine has always had; not a failure.
          sent = false;
        } else {
          // A real provider IS configured but the send genuinely failed
          // (network/auth/rejected recipient/etc.) — do NOT advance, retry
          // next call.
          const message = err instanceof Error ? err.message : String(err);
          result.skipped.push({ enrollmentId: row.enrollment_id, reason: `email_send_failed:${message}` });
          continue;
        }
      }

      if (sent) {
        result.emailsSent += 1;
      }
      await advanceEnrollmentStep(tenantDb, tenantId, row.enrollment_id, row.step_order);
      result.advanced += 1;
      continue;
    }

    if (WHATSAPP_STEP_TYPES.has(row.step_type)) {
      const templateName = row.task_instructions;
      if (!templateName) {
        result.skipped.push({ enrollmentId: row.enrollment_id, reason: "whatsapp_step_missing_template_name" });
        continue; // do NOT advance — no template configured to send, don't guess one
      }

      if (!row.lead_phone) {
        result.skipped.push({ enrollmentId: row.enrollment_id, reason: "lead_has_no_phone" });
        continue; // do NOT advance — nowhere to send this real message
      }

      // Same approval-gate rule as the email step type: only an approved
      // draft variant's (human-reviewed) body may be used as the template's
      // personalized parameter — never fabricated copy.
      const draftChannel = row.message_draft_variant_channel ?? "whatsapp";
      const variant = await tenantDb.query<WhatsAppVariantRow>(
        `SELECT mdv.id, mdv.body
         FROM message_draft_variants mdv
         JOIN message_drafts md ON md.id = mdv.message_draft_id AND md.tenant_id = mdv.tenant_id
         WHERE mdv.tenant_id = $1 AND md.lead_id = $2 AND mdv.channel = $3 AND md.status = 'approved'
         ORDER BY mdv.created_at DESC
         LIMIT 1`,
        [tenantId, row.lead_id, draftChannel],
      );
      if ((variant.rowCount ?? 0) === 0) {
        result.skipped.push({ enrollmentId: row.enrollment_id, reason: "no_matching_draft_variant" });
        continue; // do NOT advance — no approved content to act on, don't fabricate
      }

      const draftVariant = variant.rows[0];
      const provider = await resolveWhatsAppProvider();
      let sent = false;
      try {
        await provider.sendTemplateMessage({
          to: row.lead_phone,
          templateName,
          parameters: [draftVariant.body],
        });
        sent = true;
      } catch (err) {
        if (err instanceof ChannelNotConfiguredError) {
          // No real WhatsAppProvider configured in this environment — the
          // honest "advancing the step is as far as sending goes" behavior,
          // same convention as the email step type above.
          sent = false;
        } else {
          // A real provider IS configured but the send genuinely failed
          // (network/auth/invalid template/etc.) — do NOT advance, retry
          // next call.
          const message = err instanceof Error ? err.message : String(err);
          result.skipped.push({ enrollmentId: row.enrollment_id, reason: `whatsapp_send_failed:${message}` });
          continue;
        }
      }

      if (sent) {
        result.whatsappSent += 1;
      }
      await advanceEnrollmentStep(tenantDb, tenantId, row.enrollment_id, row.step_order);
      result.advanced += 1;
      continue;
    }

    // final_note (or any other non-task, non-email, non-whatsapp step type):
    // no external dependency, advance directly once due.
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
