import type { PoolClient } from "pg";
import { INDUSTRY_TEMPLATES, type IndustryKey } from "../lib/industryTemplates.js";
import { isMissingRelationError } from "../lib/pgOptional.js";
import type { StageExecutor, StageInput, StageResult, WorkflowStage } from "./types.js";
import { runResearchStage } from "./stages/research.js";
import { runLeadGenerationStage } from "./stages/leadGeneration.js";
import { runContentCampaignStage } from "./stages/contentCampaign.js";
import { runApprovalComplianceGateStage, runCampaignExecutionStage } from "./stages/approvalAndExecution.js";
import { runAnalyticsLearningStage } from "./stages/analyticsLearning.js";

/** Thrown by any stage slot that doesn't have a real executor wired in yet. */
export class StageNotImplementedError extends Error {
  constructor(stage: string, hint: string) {
    super(`${stage} stage not yet wired — ${hint}`);
    this.name = "StageNotImplementedError";
  }
}

const INDUSTRY_KEYS = Object.keys(INDUSTRY_TEMPLATES) as IndustryKey[];

function isIndustryKey(value: unknown): value is IndustryKey {
  return typeof value === "string" && (INDUSTRY_KEYS as string[]).includes(value);
}

/**
 * Builds a reasonable "offer" blurb out of whatever loose fields the
 * workflow's input_config actually carries (industry/targetAudience/
 * budget/goals — see apps/api/src/routes/workflows.ts POST /), falling
 * back to the industry template's own default value proposition when the
 * caller didn't supply one.
 */
function buildOffer(inputConfig: Record<string, unknown>, template: (typeof INDUSTRY_TEMPLATES)[IndustryKey]): string {
  const parts: string[] = [];
  if (typeof inputConfig.targetAudience === "string" && inputConfig.targetAudience.trim()) {
    parts.push(`Targeting: ${inputConfig.targetAudience.trim()}`);
  }
  if (inputConfig.goals !== undefined) {
    const goalsText = Array.isArray(inputConfig.goals)
      ? inputConfig.goals.filter((g) => typeof g === "string").join(", ")
      : typeof inputConfig.goals === "string"
        ? inputConfig.goals
        : undefined;
    if (goalsText) parts.push(`Goals: ${goalsText}`);
  }
  if (typeof inputConfig.budget === "string" && inputConfig.budget.trim()) {
    parts.push(`Budget: ${inputConfig.budget.trim()}`);
  } else if (typeof inputConfig.budget === "number") {
    parts.push(`Budget: ${inputConfig.budget}`);
  }
  if (parts.length === 0) return template.defaultValueProposition;
  return `${template.defaultValueProposition} ${parts.join(". ")}.`;
}

/**
 * Stage 1: client onboarding. Reuses the same industry-template data and
 * applies the same profile/ICP/rubric (and best-effort sequence) writes
 * that apps/api/src/routes/onboarding.ts's POST /apply performs, adapted to
 * the workflow's looser input_config shape ({industry?, targetAudience?,
 * budget?, goals?} rather than onboarding's {website, offer,
 * industryTemplate}). onboarding.ts's handler is left untouched and
 * un-exported as a standalone function, so this does not call it directly
 * — it reuses the one real shared library piece that IS exported for this,
 * INDUSTRY_TEMPLATES, and performs the same inserts against the same
 * tables onboarding.ts writes to.
 */
export async function runClientOnboardingStage(input: StageInput): Promise<StageResult> {
  const db: PoolClient = input.tenantDb;
  const { tenantId, projectId, inputConfig } = input;
  const notes: string[] = [];

  const requestedIndustry = inputConfig.industry;
  let industryKey: IndustryKey;
  if (isIndustryKey(requestedIndustry)) {
    industryKey = requestedIndustry;
  } else {
    industryKey = "saas";
    if (requestedIndustry !== undefined) {
      notes.push(`industry "${String(requestedIndustry)}" is not a known template, defaulted to "saas"`);
    }
  }
  const template = INDUSTRY_TEMPLATES[industryKey];
  const offer = buildOffer(inputConfig, template);
  const website = typeof inputConfig.website === "string" && inputConfig.website.trim() ? inputConfig.website.trim() : null;

  // 1. project_profiles upsert (same table/columns as onboarding.ts POST /apply).
  const profileResult = await db.query(
    `INSERT INTO project_profiles (tenant_id, project_id, industry, website_url, value_proposition)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id) DO UPDATE SET
       industry = EXCLUDED.industry,
       website_url = COALESCE(EXCLUDED.website_url, project_profiles.website_url),
       value_proposition = EXCLUDED.value_proposition
     RETURNING *`,
    [tenantId, projectId, industryKey, website, offer],
  );

  // 2. icp_profiles — skip ones that collide by name with an existing row.
  const existingIcpResult = await db.query(
    `SELECT name, is_primary FROM icp_profiles WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  const existingIcpRows = existingIcpResult.rows as { name: string; is_primary?: boolean }[];
  const existingIcpNames = new Set(existingIcpRows.map((r) => r.name.trim().toLowerCase()));
  const hasExistingPrimaryIcp = existingIcpRows.some((r) => r.is_primary);

  const icpProfilesCreated: unknown[] = [];
  for (const icp of template.icpProfiles) {
    if (existingIcpNames.has(icp.name.trim().toLowerCase())) {
      notes.push(`ICP profile "${icp.name}" already existed, skipped`);
      continue;
    }
    const isPrimary = !hasExistingPrimaryIcp && icpProfilesCreated.length === 0;
    const inserted = await db.query(
      `INSERT INTO icp_profiles (tenant_id, project_id, name, segment, description, pain_points, channels, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tenantId, projectId, icp.name, icp.segment, icp.description, icp.painPoints, icp.channels, isPrimary],
    );
    icpProfilesCreated.push(inserted.rows[0]);
  }

  // 3. scoring_rubrics
  const rubricName = `${template.label} starter rubric`;
  const existingByNameResult = await db.query(
    `SELECT * FROM scoring_rubrics WHERE tenant_id = $1 AND project_id = $2 AND name = $3 LIMIT 1`,
    [tenantId, projectId, rubricName],
  );

  let rubricCreated: Record<string, unknown>;
  if (existingByNameResult.rowCount && existingByNameResult.rowCount > 0) {
    rubricCreated = existingByNameResult.rows[0];
    notes.push(`A rubric named "${rubricName}" already existed, left untouched`);
  } else {
    const activeRubricResult = await db.query(
      `SELECT 1 FROM scoring_rubrics WHERE tenant_id = $1 AND project_id = $2 AND is_active = true LIMIT 1`,
      [tenantId, projectId],
    );
    const hasExistingActiveRubric = (activeRubricResult.rowCount ?? 0) > 0;
    if (hasExistingActiveRubric) {
      notes.push("An active rubric already existed for this project; the new rubric was created as inactive rather than replacing it");
    }

    const rubricResult = await db.query(
      `INSERT INTO scoring_rubrics (tenant_id, project_id, name, criteria, is_active)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [tenantId, projectId, rubricName, JSON.stringify(template.scoringCriteria), !hasExistingActiveRubric],
    );
    rubricCreated = rubricResult.rows[0];
  }

  // 4. sequences + sequence_steps — best-effort, same SAVEPOINT pattern as
  // onboarding.ts POST /apply: the sequences tables may not exist yet in
  // every environment.
  let sequenceCreated: Record<string, unknown> | null = null;
  const sequenceName = template.sequenceTemplate.name;

  await db.query("SAVEPOINT workflow_onboarding_sequence");
  try {
    const existingSequenceResult = await db.query(
      `SELECT * FROM sequences WHERE tenant_id = $1 AND project_id = $2 AND name = $3 LIMIT 1`,
      [tenantId, projectId, sequenceName],
    );

    if (existingSequenceResult.rowCount && existingSequenceResult.rowCount > 0) {
      sequenceCreated = existingSequenceResult.rows[0];
      notes.push(`A sequence named "${sequenceName}" already existed, left untouched`);
    } else {
      const sequenceResult = await db.query(
        `INSERT INTO sequences (tenant_id, project_id, name, is_active)
         VALUES ($1, $2, $3, true)
         RETURNING *`,
        [tenantId, projectId, sequenceName],
      );
      const sequenceRow = sequenceResult.rows[0];

      const stepRows: unknown[] = [];
      for (let i = 0; i < template.sequenceTemplate.steps.length; i++) {
        const step = template.sequenceTemplate.steps[i];
        const stepResult = await db.query(
          `INSERT INTO sequence_steps (tenant_id, sequence_id, step_order, day_offset, step_type, task_instructions)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [tenantId, sequenceRow.id, i, step.dayOffset, step.stepType, step.taskInstructions ?? null],
        );
        stepRows.push(stepResult.rows[0]);
      }
      sequenceCreated = { ...sequenceRow, steps: stepRows };
    }
    await db.query("RELEASE SAVEPOINT workflow_onboarding_sequence");
  } catch (err) {
    await db.query("ROLLBACK TO SAVEPOINT workflow_onboarding_sequence").catch(() => undefined);
    if (isMissingRelationError(err)) {
      sequenceCreated = null;
      notes.push("sequences table not available yet, skipped");
    } else {
      throw err;
    }
  }

  const summary = `Applied the "${template.label}" template: profile set, ${icpProfilesCreated.length} new ICP profile(s), rubric "${rubricCreated.name as string}"${sequenceCreated ? `, sequence "${sequenceName}" with ${(sequenceCreated.steps as unknown[] | undefined)?.length ?? 0} steps` : " (sequence skipped)"}.`;

  return {
    stage: "client_onboarding",
    status: "completed",
    summary,
    data: {
      industryTemplate: industryKey,
      profile: profileResult.rows[0],
      icpProfilesCreated,
      rubricCreated,
      sequenceCreated,
      notes,
    },
  };
}

/**
 * Registry mapping a workflow stage to the function that actually runs it,
 * mirroring apps/worker/src/agents/registry.ts's executor-map pattern.
 *
 * Only client_onboarding is implemented here. The other 5 stages are owned
 * by separate, concurrently-landing files under apps/api/src/workflow/
 * stages/ (research.ts, leadGeneration.ts, contentCampaign.ts,
 * approvalAndExecution.ts [covers both approval_compliance_gate and
 * campaign_execution], analyticsLearning.ts) and are intentionally left
 * out of this object literal until each one lands — wire each one in with
 * exactly this one-line pattern, e.g.:
 *
 *   import { runResearchStage } from "./stages/research.js";
 *   ...
 *   research: runResearchStage,
 *
 * Any stage not present in this object throws StageNotImplementedError
 * when the engine looks it up (see engine.ts), so an unwired stage fails
 * loudly and recorded, never silently.
 */
export const stageRegistry: Partial<Record<WorkflowStage, StageExecutor>> = {
  client_onboarding: runClientOnboardingStage,
  research: runResearchStage,
  lead_generation: runLeadGenerationStage,
  content_campaign: runContentCampaignStage,
  approval_compliance_gate: runApprovalComplianceGateStage,
  campaign_execution: runCampaignExecutionStage,
  analytics_learning: runAnalyticsLearningStage,
};

const STAGE_FILE_HINTS: Record<WorkflowStage, string> = {
  client_onboarding: "implemented in apps/api/src/workflow/stageRegistry.ts",
  research: "see apps/api/src/workflow/stages/research.ts",
  lead_generation: "see apps/api/src/workflow/stages/leadGeneration.ts",
  content_campaign: "see apps/api/src/workflow/stages/contentCampaign.ts",
  approval_compliance_gate: "see apps/api/src/workflow/stages/approvalAndExecution.ts",
  campaign_execution: "see apps/api/src/workflow/stages/approvalAndExecution.ts",
  analytics_learning: "see apps/api/src/workflow/stages/analyticsLearning.ts",
};

export function getStageExecutor(stage: WorkflowStage): StageExecutor {
  const executor = stageRegistry[stage];
  if (!executor) {
    throw new StageNotImplementedError(stage, STAGE_FILE_HINTS[stage]);
  }
  return executor;
}
