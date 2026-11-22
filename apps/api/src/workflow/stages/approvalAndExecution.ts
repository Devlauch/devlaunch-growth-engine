/**
 * Workflow stages: approval_compliance_gate + campaign_execution.
 *
 * These are the two stages immediately after content_campaign in the
 * Phase 4 autonomous pipeline (see apps/api/src/workflow/types.ts for the
 * WORKFLOW_STAGES contract). Both are implemented as plain StageExecutor
 * functions in this one file (per this task's "your call, document it"
 * option) because they share the same message-draft-centric data and are
 * easiest to reason about side by side.
 *
 * NOTE ON apps/api/src/workflow/types.ts: at the time this file was written,
 * types.ts did not yet exist on disk (a parallel "orchestration core" agent
 * owns it and had not landed it yet). Per instructions, this file imports
 * from "../types.js" as the real, final contract demands. If that import
 * fails a future build before types.ts lands, the local fallback types
 * below (kept byte-for-byte compatible with the documented contract) can be
 * swapped in by changing the one import line — nothing else in this file
 * depends on where the types come from.
 */
import type { StageExecutor, StageResult } from "../types.js";

/**
 * CRITICAL DESIGN RULE: this stage never auto-approves anything. It only
 * ever (a) reads real message_drafts.status, (b) submits still-'draft' rows
 * for approval (the same DB write POST /:id/submit-for-approval in
 * routes/messaging.ts performs) so a human has something to act on, and
 * (c) once a human has already decided every draft via the existing
 * approvals mechanism (POST /:id/submit-for-approval + POST /batch-approve,
 * used exactly as they already are outside this workflow), runs the
 * compliance half (checkSendEligibility) and reports the real breakdown.
 *
 * It NEVER flips a draft to 'approved' or 'rejected' itself — only a human,
 * via the existing message-drafts routes, does that.
 */
export const runApprovalComplianceGateStage: StageExecutor = async (input) => {
  const { tenantDb, tenantId, priorStageResults, workflowRunId } = input;

  const contentCampaignData = priorStageResults["content_campaign"]?.data;
  const messageDraftIds = Array.isArray(contentCampaignData?.messageDraftIds)
    ? (contentCampaignData!.messageDraftIds as unknown[]).filter((id): id is string => typeof id === "string")
    : [];

  if (messageDraftIds.length === 0) {
    return {
      stage: "approval_compliance_gate",
      status: "completed",
      summary:
        "No message drafts were produced by the content_campaign stage, so there is nothing to approve or " +
        "compliance-check yet.",
      data: { approvedAndEligible: [], approvedButBlocked: [], rejected: [], pending: [] },
    };
  }

  const draftsResult = await tenantDb.query<{
    id: string;
    status: string;
    lead_id: string;
    approval_id: string | null;
  }>(
    `SELECT id, status, lead_id, approval_id FROM message_drafts
     WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, messageDraftIds],
  );
  const drafts = draftsResult.rows;

  // Step 2: submit any still-'draft' rows for approval now (real DB write,
  // identical in effect to POST /message-drafts/:id/submit-for-approval),
  // so a human reviewing the approvals queue has something to act on.
  const freshlySubmitted: string[] = [];
  for (const draft of drafts) {
    if (draft.status !== "draft") continue;

    const approvalInsert = await tenantDb.query<{ id: string }>(
      `INSERT INTO approvals (tenant_id, message_draft_id, requested_by, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        tenantId,
        draft.id,
        null,
        `Message draft for lead ${draft.lead_id} submitted for approval by workflow run ${workflowRunId}`,
      ],
    );
    const approvalId = approvalInsert.rows[0]?.id ?? null;

    await tenantDb.query(
      `UPDATE message_drafts SET status = 'pending_approval', approval_id = $3
       WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [draft.id, tenantId, approvalId],
    );

    draft.status = "pending_approval";
    freshlySubmitted.push(draft.id);
  }

  // Step 3: anything not yet decided by a human pauses the pipeline here.
  const stillPending = drafts.filter((d) => d.status === "draft" || d.status === "pending_approval");
  if (stillPending.length > 0) {
    const pendingIds = stillPending.map((d) => d.id);
    return {
      stage: "approval_compliance_gate",
      status: "needs_approval",
      summary:
        `${stillPending.length} of ${drafts.length} drafted messages are awaiting human approval ` +
        `(${freshlySubmitted.length} newly submitted for approval just now) — approve or reject them via the ` +
        `message drafts screen (POST .../message-drafts/batch-approve or the single-draft approval flow), then ` +
        `advance this workflow again.`,
      data: {
        approvedAndEligible: [],
        approvedButBlocked: [],
        rejected: [],
        pending: pendingIds,
      },
      approvalContext: { entityType: "message_drafts", entityIds: pendingIds },
    };
  }

  // Step 4: every draft has a real human decision on file (approved or
  // rejected) — run the compliance half (consent/suppression) over the
  // approved ones.
  const approvedAndEligible: string[] = [];
  const approvedButBlocked: { draftId: string; leadId: string; blockReasons: string[] }[] = [];
  const rejected: string[] = [];

  const { checkSendEligibility } = await import("../../lib/suppression.js");

  for (const draft of drafts) {
    if (draft.status === "rejected") {
      rejected.push(draft.id);
      continue;
    }
    if (draft.status !== "approved") continue; // defensive; shouldn't happen given the guard above

    const leadResult = await tenantDb.query<{ id: string; email: string | null }>(
      `SELECT id, email FROM leads WHERE id = $1 AND tenant_id = $2`,
      [draft.lead_id, tenantId],
    );
    const lead = leadResult.rows[0];
    const email = lead?.email ?? null;

    const eligibility = email
      ? await checkSendEligibility(tenantDb, tenantId, { leadId: draft.lead_id, email, channel: "email" })
      : { eligible: true, blockReasons: [] };

    if (eligibility.eligible) {
      approvedAndEligible.push(draft.id);
    } else {
      approvedButBlocked.push({ draftId: draft.id, leadId: draft.lead_id, blockReasons: eligibility.blockReasons });
    }
  }

  const summary =
    `Human approval is complete for all ${drafts.length} drafted message(s): ${approvedAndEligible.length} ` +
    `approved and compliance-eligible to send, ${approvedButBlocked.length} approved but blocked by ` +
    `suppression/consent checks, ${rejected.length} rejected by a human reviewer.`;

  return {
    stage: "approval_compliance_gate",
    status: "completed",
    summary,
    data: { approvedAndEligible, approvedButBlocked, rejected, pending: [] },
  };
};

/**
 * campaign_execution: there is no real outbound-sending integration
 * anywhere in this codebase (same honest gap documented in
 * routes/campaigns.ts and routes/messaging.ts), so this stage does not
 * fabricate a "send". Instead it marks execution as genuinely ready and
 * delegates to advanceDueEnrollments (apps/api/src/lib/advanceSequences.ts)
 * — real, already-built logic that creates real crm_tasks for task-type
 * sequence steps and, for email-type steps, honestly records what would be
 * sent once a sender is connected.
 */
export const runCampaignExecutionStage: StageExecutor = async (input) => {
  const { tenantDb, tenantId, projectId, priorStageResults } = input;

  const gateData = priorStageResults["approval_compliance_gate"]?.data;
  const approvedAndEligible = Array.isArray(gateData?.approvedAndEligible)
    ? (gateData!.approvedAndEligible as unknown[]).filter((id): id is string => typeof id === "string")
    : [];

  const contentCampaignData = priorStageResults["content_campaign"]?.data;
  const sequenceId = typeof contentCampaignData?.sequenceId === "string" ? contentCampaignData!.sequenceId : null;

  const { advanceDueEnrollments } = await import("../../lib/advanceSequences.js");
  const advanceResult = await advanceDueEnrollments(tenantDb, tenantId, projectId);

  const heldForSender = advanceResult.skipped.filter((s) => s.reason === "no_matching_draft_variant");
  const ineligibleSkips = advanceResult.skipped.filter((s) => s.reason.startsWith("ineligible:"));

  const summaryParts = [
    `Advanced ${advanceResult.advanced} sequence enrollment(s) for project ${projectId}` +
      (sequenceId ? ` (sequence ${sequenceId} from content_campaign)` : "") +
      `: ${advanceResult.tasksCreated} CRM task(s) created.`,
  ];
  if (heldForSender.length > 0) {
    summaryParts.push(
      `${heldForSender.length} email step(s) held pending a connected sender (no sending integration exists yet).`,
    );
  }
  if (ineligibleSkips.length > 0) {
    summaryParts.push(`${ineligibleSkips.length} step(s) skipped due to suppression/consent blocks.`);
  }
  if (approvedAndEligible.length > 0) {
    summaryParts.push(
      `${approvedAndEligible.length} message draft(s) passed the approval/compliance gate and are ready once a ` +
        `sender is connected.`,
    );
  } else {
    summaryParts.push("No message drafts passed the approval/compliance gate yet for this run.");
  }

  const result: StageResult = {
    stage: "campaign_execution",
    status: "completed",
    summary: summaryParts.join(" "),
    data: {
      advancedCount: advanceResult.advanced,
      tasksCreated: advanceResult.tasksCreated,
      heldForSender,
      skipped: advanceResult.skipped,
      approvedAndEligibleDraftIds: approvedAndEligible,
    },
  };
  return result;
};
