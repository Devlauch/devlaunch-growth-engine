/**
 * Workflow stage: content_campaign ("Content and campaign agents — SEO,
 * blogs, social posts, email sequences" — see apps/api/src/workflow/types.ts
 * for the WORKFLOW_STAGES contract this slots into, between lead_generation
 * and approval_compliance_gate).
 *
 * This stage composes three already-built, real features rather than
 * inventing new generation logic:
 *   1. apps/api/src/lib/contentGeneration.ts (generateContentCalendar /
 *      buildBrandVoiceProfile) — Phase 2's Content Strategy Agent. Persisted
 *      the same way apps/api/src/routes/contentStrategy.ts's
 *      POST /content-calendars does (content_calendars + content_calendar_items).
 *   2. apps/api/src/lib/draftMessage.ts — Phase 1's pure message-drafting
 *      function, persisted the same way apps/api/src/routes/messaging.ts's
 *      POST /message-drafts does (message_drafts + message_draft_variants).
 *   3. apps/api/src/routes/sequences.ts's sequence/step/enrollment shape — a
 *      real sequences + sequence_steps row (created once per project, reused
 *      on re-runs) and a sequence_enrollments row per newly-drafted lead.
 *
 * Like every other stage/library in this codebase, there is no LLM call
 * here — content and message bodies are real, deterministic templating
 * grounded in the project's own project_profiles/icp_profiles/
 * company_enrichment/icp_match_scores data (see contentGeneration.ts's and
 * draftMessage.ts's own doc comments for the full rationale). Nothing here
 * fabricates a fact about a lead that has no real data behind it.
 *
 * This stage never itself returns status "needs_approval" — gating drafted
 * messages on human approval is the approval_compliance_gate stage's job
 * (see apps/api/src/workflow/stages/approvalAndExecution.ts, which reads
 * this stage's `data.messageDraftIds` and `data.sequenceId`).
 */
import type { StageExecutor, StageResult } from "../types.js";
import {
  buildBrandVoiceProfile,
  generateContentCalendar,
  type IcpProfileInput,
  type ProjectProfileInput,
} from "../../lib/contentGeneration.js";
import { draftMessage } from "../../lib/draftMessage.js";

const MAX_LEADS_TO_DRAFT = 10;
const SEQUENCE_NAME = "Content Campaign Sequence";

interface ProjectProfileRow extends ProjectProfileInput {
  company_name: string | null;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Pulls a real, small default approved-claims list out of the project's own value_proposition (never invented marketing copy). */
function defaultApprovedClaims(profile: ProjectProfileRow): string[] {
  const valueProp = profile.value_proposition?.trim();
  return valueProp ? [valueProp] : [];
}

/** Real evidence facts about a lead, sourced only from company_enrichment/icp_match_scores rows that actually exist — never fabricated. */
async function loadLeadEvidence(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  leadId: string,
): Promise<{ summary: string; facts: string[] }> {
  const facts: string[] = [];

  const enrichmentResult = await tenantDb.query<{
    domain: string | null;
    firmographics: Record<string, unknown>;
  }>(`SELECT domain, firmographics FROM company_enrichment WHERE tenant_id = $1 AND lead_id = $2`, [
    tenantId,
    leadId,
  ]);
  const enrichment = enrichmentResult.rows[0];
  if (enrichment) {
    if (enrichment.domain) facts.push(`Company domain: ${enrichment.domain}`);
    const firmographics = enrichment.firmographics ?? {};
    for (const [key, value] of Object.entries(firmographics)) {
      if (value === null || value === undefined || value === "") continue;
      facts.push(`${key}: ${String(value)}`);
    }
  }

  const matchResult = await tenantDb.query<{
    match_score: string;
    match_reasons: string[];
    icp_name: string;
  }>(
    `SELECT ims.match_score, ims.match_reasons, ip.name AS icp_name
     FROM icp_match_scores ims
     JOIN icp_profiles ip ON ip.id = ims.icp_profile_id
     WHERE ims.tenant_id = $1 AND ims.lead_id = $2
     ORDER BY ims.match_score DESC
     LIMIT 1`,
    [tenantId, leadId],
  );
  const match = matchResult.rows[0];
  if (match) {
    facts.push(`ICP match: ${match.match_score}/100 fit with "${match.icp_name}"`);
    for (const reason of match.match_reasons ?? []) {
      if (typeof reason === "string" && reason.trim()) facts.push(reason.trim());
    }
  }

  const summary =
    facts.length > 0
      ? `Real enrichment/ICP-match data is available for this lead (${facts.length} fact(s)).`
      : "No enrichment or ICP-match data is available for this lead yet.";

  return { summary, facts };
}

/** Finds an existing "Content Campaign Sequence" for this project, or creates one with the day 0 email / day 3 call / day 7 follow-up shape used elsewhere in this codebase (see industryTemplates.ts's sequenceTemplate entries). */
async function loadOrCreateSequence(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await tenantDb.query<{ id: string }>(
    `SELECT id FROM sequences WHERE tenant_id = $1 AND project_id = $2 AND name = $3 LIMIT 1`,
    [tenantId, projectId, SEQUENCE_NAME],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return { id: existing.rows[0].id, created: false };
  }

  const sequenceResult = await tenantDb.query<{ id: string }>(
    `INSERT INTO sequences (tenant_id, project_id, name, is_active)
     VALUES ($1, $2, $3, true)
     RETURNING id`,
    [tenantId, projectId, SEQUENCE_NAME],
  );
  const sequenceId = sequenceResult.rows[0].id;

  const steps: Array<{
    stepOrder: number;
    dayOffset: number;
    stepType: string;
    channel: string | null;
    taskInstructions: string | null;
  }> = [
    { stepOrder: 0, dayOffset: 0, stepType: "email", channel: "email", taskInstructions: null },
    {
      stepOrder: 1,
      dayOffset: 3,
      stepType: "call_task",
      channel: null,
      taskInstructions: "Call to follow up on the initial email and gauge interest.",
    },
    { stepOrder: 2, dayOffset: 7, stepType: "follow_up_email", channel: "email", taskInstructions: null },
  ];

  for (const step of steps) {
    await tenantDb.query(
      `INSERT INTO sequence_steps (tenant_id, sequence_id, step_order, day_offset, step_type, message_draft_variant_channel, task_instructions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, sequenceId, step.stepOrder, step.dayOffset, step.stepType, step.channel, step.taskInstructions],
    );
  }

  return { id: sequenceId, created: true };
}

async function enrollLeadIfNeeded(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  sequenceId: string,
  leadId: string,
): Promise<boolean> {
  const existing = await tenantDb.query(
    `SELECT 1 FROM sequence_enrollments WHERE tenant_id = $1 AND sequence_id = $2 AND lead_id = $3`,
    [tenantId, sequenceId, leadId],
  );
  if ((existing.rowCount ?? 0) > 0) return false;

  await tenantDb.query(
    `INSERT INTO sequence_enrollments (tenant_id, sequence_id, lead_id, status, current_step_order)
     VALUES ($1, $2, $3, 'active', 0)`,
    [tenantId, sequenceId, leadId],
  );
  return true;
}

export const runContentCampaignStage: StageExecutor = async (input) => {
  const { tenantDb, tenantId, projectId, priorStageResults, inputConfig } = input;

  const profileResult = await tenantDb.query<ProjectProfileRow>(
    `SELECT company_name, industry, website_url, value_proposition, target_markets
     FROM project_profiles WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  const profile = profileResult.rows[0] ?? null;

  if (!profile) {
    const result: StageResult = {
      stage: "content_campaign",
      status: "completed",
      summary:
        "No project profile has been set up for this project yet, so content generation was skipped. " +
        "Set up a project profile (e.g. via the client_onboarding stage or POST .../profile) before this stage " +
        "can generate a content calendar or draft messages.",
      data: { skipped: true, calendarId: null, itemCount: 0, messageDraftIds: [], sequenceId: null, enrollmentCount: 0 },
    };
    return result;
  }

  // 1. Content calendar — real generation + persistence, same shape as
  // routes/contentStrategy.ts's POST /content-calendars.
  const icpResult = await tenantDb.query<IcpProfileInput & { id: string }>(
    `SELECT id, name, segment, description, pain_points FROM icp_profiles
     WHERE tenant_id = $1 AND project_id = $2 AND is_primary = true LIMIT 1`,
    [tenantId, projectId],
  );
  const icpProfile = icpResult.rows[0] ?? null;

  const startDate =
    typeof inputConfig.startDate === "string" && inputConfig.startDate.trim() ? inputConfig.startDate.trim() : todayIsoDate();
  const calendarName = `${profile.company_name?.trim() || "Project"} content calendar`;

  const generatedItems = generateContentCalendar(profile, icpProfile, startDate);

  const calendarResult = await tenantDb.query<{ id: string }>(
    `INSERT INTO content_calendars (tenant_id, project_id, name, start_date, icp_profile_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [tenantId, projectId, calendarName, startDate, icpProfile?.id ?? null],
  );
  const calendarId = calendarResult.rows[0].id;

  for (const item of generatedItems) {
    await tenantDb.query(
      `INSERT INTO content_calendar_items (tenant_id, calendar_id, day_offset, content_type, title, body)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, calendarId, item.dayOffset, item.contentType, item.title, item.body],
    );
  }

  // 2. Per-lead message drafting — real evidence-grounded templating, same
  // shape as routes/messaging.ts's POST /message-drafts.
  const leadGenerationData = priorStageResults["lead_generation"]?.data;
  const leadsCreated = Array.isArray(leadGenerationData?.leadsCreated)
    ? (leadGenerationData!.leadsCreated as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  const leadIdsToProcess = leadsCreated.slice(0, MAX_LEADS_TO_DRAFT);

  const configuredApprovedClaims = Array.isArray(inputConfig.approvedClaims)
    ? (inputConfig.approvedClaims as unknown[]).filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : null;
  const approvedClaims = configuredApprovedClaims ?? defaultApprovedClaims(profile);

  const messageDraftIds: string[] = [];
  const draftedLeadIds: string[] = [];

  for (const leadId of leadIdsToProcess) {
    const leadResult = await tenantDb.query<{ id: string; name: string | null; email: string | null }>(
      `SELECT id, name, email FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [leadId, tenantId, projectId],
    );
    const lead = leadResult.rows[0];
    if (!lead) continue; // lead no longer exists / belongs to a different project — skip honestly rather than fail the whole stage

    const evidence = await loadLeadEvidence(tenantDb, tenantId, leadId);
    const { variants, unsourcedClaims } = draftMessage(approvedClaims, evidence);

    const senderIdentity = "Unconfigured sender identity (no sending integration connected)";
    const recipientDisplay =
      lead.name && lead.email ? `${lead.name} <${lead.email}>` : lead.email ?? lead.name ?? null;

    const draftResult = await tenantDb.query<{ id: string }>(
      `INSERT INTO message_drafts (tenant_id, project_id, lead_id, evidence_summary, unsourced_claims, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id`,
      [tenantId, projectId, leadId, evidence.summary, JSON.stringify(unsourcedClaims), null],
    );
    const draftId = draftResult.rows[0].id;

    for (const variant of variants) {
      await tenantDb.query(
        `INSERT INTO message_draft_variants (tenant_id, message_draft_id, channel, subject, body, recipient_display, sender_identity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, draftId, variant.channel, variant.subject ?? null, variant.body, recipientDisplay, senderIdentity],
      );
    }

    messageDraftIds.push(draftId);
    draftedLeadIds.push(leadId);
  }

  // 3. Sequence (create-once) + enrollment (dedup on rerun), same shape as
  // routes/sequences.ts.
  let sequenceId: string | null = null;
  let enrollmentCount = 0;
  if (draftedLeadIds.length > 0) {
    const sequence = await loadOrCreateSequence(tenantDb, tenantId, projectId);
    sequenceId = sequence.id;
    for (const leadId of draftedLeadIds) {
      const enrolled = await enrollLeadIfNeeded(tenantDb, tenantId, sequenceId, leadId);
      if (enrolled) enrollmentCount++;
    }
  }

  const summary =
    `Generated a ${startDate}-starting content calendar (${generatedItems.length} items) for ` +
    `${profile.company_name?.trim() || "this project"}` +
    (leadIdsToProcess.length > 0
      ? `, drafted messages for ${draftedLeadIds.length} of ${leadIdsToProcess.length} lead(s) across ` +
        `${draftedLeadIds.length > 0 ? 4 : 0} channels each` +
        (sequenceId ? `, and enrolled ${enrollmentCount} lead(s) in the "${SEQUENCE_NAME}" sequence.` : ".")
      : "; no leads were available from the lead_generation stage yet, so no messages were drafted.");

  const result: StageResult = {
    stage: "content_campaign",
    status: "completed",
    summary,
    data: {
      skipped: false,
      calendarId,
      itemCount: generatedItems.length,
      messageDraftIds,
      sequenceId,
      enrollmentCount,
    },
  };
  return result;
};
