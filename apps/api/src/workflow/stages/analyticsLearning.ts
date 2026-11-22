/**
 * Workflow stage: analytics_learning — the LAST of the 7 Phase 4 pipeline
 * stages (see apps/api/src/workflow/types.ts's WORKFLOW_STAGES contract).
 * Spec: "Analytics and learning agents — Measure outcomes, improve scoring
 * and recommendations."
 *
 * This stage does not reimplement any analysis. It composes three already
 * real, already-tested pieces of Phase 2 reporting into one final report:
 *
 *   - computeFunnelDropoff (apps/api/src/lib/funnelDropoff.ts) — Conversion
 *     Optimization Agent's funnel drop-off detection.
 *   - the learning-loop's variant-performance + rubric-review-readiness
 *     logic. There is no importable lib for this: both are implemented
 *     inline as route handlers in apps/api/src/routes/learningLoop.ts (GET
 *     /variant-performance and GET /rubric-review-readiness), not exported
 *     from any lib file — grepped the whole src tree to confirm. Route
 *     handlers aren't importable, so (same documented precedent as
 *     funnelDropoff.ts itself, which duplicates analytics.ts's /funnel SQL
 *     for the identical reason, and scoreLead.ts duplicating
 *     leadScoring.ts's pure logic) this file duplicates the same two real
 *     SQL queries learningLoop.ts runs, reusing the shared
 *     apps/api/src/lib/pgOptional.ts SAVEPOINT-based runOptional helper
 *     those routes already depend on, rather than reaching into
 *     routes/learningLoop.ts or editing it.
 *   - recommendNextActions (apps/api/src/lib/nextBestAction.ts) — Marketing
 *     Intelligence Agent's next-best-action recommendations.
 *
 * Every sub-call already degrades gracefully on its own (missing tables
 * report an honest empty/zero result, never a thrown error) — see each
 * file's own docs. The try/catch around each call below is pure defense in
 * depth: if one throws anyway for an unrelated reason, it must not fail
 * the whole final stage of the pipeline. The failure is recorded honestly
 * in `data` as a `{ section, error }` entry instead.
 *
 * status is always 'completed': this is a read-only reporting stage. There
 * is nothing to approve, and "no data yet" is not a failure — it is an
 * honest finding, not an error.
 */
import type { StageExecutor, StageResult } from "../types.js";
import { computeFunnelDropoff, type FunnelDropoffResult } from "../../lib/funnelDropoff.js";
import { recommendNextActions } from "../../lib/nextBestAction.js";
import { runOptional, firstCount } from "../../lib/pgOptional.js";

const MIN_VARIANT_SAMPLE_SIZE = 5;
const RUBRIC_REVIEW_THRESHOLD = 30;

interface VariantPerformanceRow {
  channel: string;
  total_variants: string;
  leads_contacted: string;
  leads_replied_interested: string;
}

interface VariantPerformanceChannel {
  channel: string;
  totalVariants: number;
  leadsContacted: number;
  leadsRepliedInterested: number;
  replyRate: number;
}

interface VariantPerformanceResult {
  channels: VariantPerformanceChannel[];
  note: string | null;
}

/** Duplicates learningLoop.ts GET /variant-performance's real SQL/shape. */
async function computeVariantPerformance(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<VariantPerformanceResult> {
  const result = await runOptional<VariantPerformanceRow>(
    tenantDb,
    `WITH variant_totals AS (
       SELECT mdv.channel,
              COUNT(*) AS total_variants,
              COUNT(DISTINCT md.lead_id) AS leads_contacted
       FROM message_draft_variants mdv
       JOIN message_drafts md
         ON md.id = mdv.message_draft_id AND md.tenant_id = mdv.tenant_id
       WHERE md.tenant_id = $1 AND md.project_id = $2 AND md.status = 'approved'
       GROUP BY mdv.channel
     ),
     reply_totals AS (
       SELECT mdv.channel,
              COUNT(DISTINCT lr.lead_id) AS leads_replied_interested
       FROM message_draft_variants mdv
       JOIN message_drafts md
         ON md.id = mdv.message_draft_id AND md.tenant_id = mdv.tenant_id
       JOIN lead_replies lr
         ON lr.lead_id = md.lead_id AND lr.tenant_id = md.tenant_id AND lr.classification = 'interested'
       WHERE md.tenant_id = $1 AND md.project_id = $2 AND md.status = 'approved'
       GROUP BY mdv.channel
     )
     SELECT vt.channel, vt.total_variants, vt.leads_contacted,
            COALESCE(rt.leads_replied_interested, 0) AS leads_replied_interested
     FROM variant_totals vt
     LEFT JOIN reply_totals rt ON rt.channel = vt.channel
     ORDER BY vt.channel`,
    [tenantId, projectId],
    "message_draft_variants/message_drafts/lead_replies",
  );

  if (result.degraded) {
    return { channels: [], note: "not enough data yet" };
  }

  const totalLeadsContacted = result.rows.reduce((sum, row) => sum + Number(row.leads_contacted), 0);
  if (totalLeadsContacted < MIN_VARIANT_SAMPLE_SIZE) {
    return { channels: [], note: "not enough data yet" };
  }

  const channels = result.rows.map((row) => {
    const leadsContacted = Number(row.leads_contacted);
    const leadsRepliedInterested = Number(row.leads_replied_interested);
    return {
      channel: row.channel,
      totalVariants: Number(row.total_variants),
      leadsContacted,
      leadsRepliedInterested,
      replyRate: leadsContacted > 0 ? leadsRepliedInterested / leadsContacted : 0,
    };
  });

  return { channels, note: null };
}

interface RubricReviewReadinessResult {
  feedbackCount: number;
  readyForReview: boolean;
  goodCount: number;
  badCount: number;
}

/** Duplicates learningLoop.ts GET /rubric-review-readiness's real SQL/shape. */
async function computeRubricReviewReadiness(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<RubricReviewReadinessResult> {
  const result = await runOptional<{ feedback: string; count: string }>(
    tenantDb,
    `SELECT lsf.feedback, COUNT(*) AS count
     FROM lead_score_feedback lsf
     JOIN leads l ON l.id = lsf.lead_id
     WHERE lsf.tenant_id = $1 AND l.project_id = $2
     GROUP BY lsf.feedback`,
    [tenantId, projectId],
    "lead_score_feedback",
  );

  if (result.degraded) {
    return { feedbackCount: 0, readyForReview: false, goodCount: 0, badCount: 0 };
  }

  let goodCount = 0;
  let badCount = 0;
  for (const row of result.rows) {
    if (row.feedback === "good") goodCount = Number(row.count);
    if (row.feedback === "bad") badCount = Number(row.count);
  }
  const feedbackCount = goodCount + badCount;

  return {
    feedbackCount,
    readyForReview: feedbackCount >= RUBRIC_REVIEW_THRESHOLD,
    goodCount,
    badCount,
  };
}

/** A failed sub-call's honest placeholder, kept in `data` instead of thrown. */
function errorSection(section: string, err: unknown): { section: string; error: string } {
  return { section, error: err instanceof Error ? err.message : String(err) };
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Pulls the key real numbers out of every earlier stage's recorded data,
 * defensively (each prior stage's exact data shape may evolve, and some of
 * these stages are owned/landed by other concurrently-working sessions) —
 * missing/differently-shaped fields are left out rather than guessed at.
 */
function buildPipelineSummary(priorStageResults: Record<string, { data: Record<string, unknown>; summary: string }>) {
  const onboarding = priorStageResults["client_onboarding"]?.data;
  const research = priorStageResults["research"]?.data;
  const leadGeneration = priorStageResults["lead_generation"]?.data;
  const contentCampaign = priorStageResults["content_campaign"]?.data;
  const approvalGate = priorStageResults["approval_compliance_gate"]?.data;
  const campaignExecution = priorStageResults["campaign_execution"]?.data;

  return {
    clientOnboarding: onboarding
      ? {
          industryTemplate: onboarding.industryTemplate ?? null,
          icpProfilesCreated: arrayLength(onboarding.icpProfilesCreated),
        }
      : null,
    research: research
      ? {
          // Defensive: research.ts hasn't landed yet at the time of writing;
          // common/likely field names are read without assuming any exist.
          findingsCount: arrayLength(research.findings) ?? arrayLength(research.insights),
        }
      : null,
    leadGeneration: leadGeneration
      ? {
          leadsCreated: arrayLength(leadGeneration.leadsCreated),
        }
      : null,
    contentCampaign: contentCampaign
      ? {
          itemCount: numberOrNull(contentCampaign.itemCount) ?? arrayLength(contentCampaign.messageDraftIds),
          enrollmentCount: numberOrNull(contentCampaign.enrollmentCount),
        }
      : null,
    approvalComplianceGate: approvalGate
      ? {
          approvedAndEligible: arrayLength(approvalGate.approvedAndEligible),
          approvedButBlocked: arrayLength(approvalGate.approvedButBlocked),
          rejected: arrayLength(approvalGate.rejected),
        }
      : null,
    campaignExecution: campaignExecution
      ? {
          tasksCreated: numberOrNull(campaignExecution.tasksCreated),
          advancedCount: numberOrNull(campaignExecution.advancedCount),
        }
      : null,
  };
}

export const runAnalyticsLearningStage: StageExecutor = async (input) => {
  const { tenantDb, tenantId, projectId, priorStageResults } = input;

  const data: Record<string, unknown> = {};

  let funnel: FunnelDropoffResult | null = null;
  try {
    funnel = await computeFunnelDropoff(tenantDb, tenantId, projectId);
    data.funnel = funnel;
  } catch (err) {
    data.funnel = errorSection("funnel", err);
  }

  let variantPerformance: VariantPerformanceResult | null = null;
  try {
    variantPerformance = await computeVariantPerformance(tenantDb, tenantId, projectId);
    data.variantPerformance = variantPerformance;
  } catch (err) {
    data.variantPerformance = errorSection("variantPerformance", err);
  }

  let rubricReviewReadiness: RubricReviewReadinessResult | null = null;
  try {
    rubricReviewReadiness = await computeRubricReviewReadiness(tenantDb, tenantId, projectId);
    data.rubricReviewReadiness = rubricReviewReadiness;
  } catch (err) {
    data.rubricReviewReadiness = errorSection("rubricReviewReadiness", err);
  }

  let nextBestActions: string[] | null = null;
  try {
    nextBestActions = await recommendNextActions(tenantDb, tenantId, projectId);
    data.nextBestActions = nextBestActions;
  } catch (err) {
    data.nextBestActions = errorSection("nextBestActions", err);
  }

  const pipelineSummary = buildPipelineSummary(priorStageResults);
  data.pipelineSummary = pipelineSummary;

  // --- compose one real, honest summary sentence out of whatever numbers
  // actually came back (prior-stage numbers + this stage's own findings).
  const summaryParts: string[] = [];

  const leadsCreated = pipelineSummary.leadGeneration?.leadsCreated;
  const itemCount = pipelineSummary.contentCampaign?.itemCount;
  const enrollmentCount = pipelineSummary.contentCampaign?.enrollmentCount;
  const tasksCreated = pipelineSummary.campaignExecution?.tasksCreated;

  const pipelineBits: string[] = [];
  if (typeof leadsCreated === "number") pipelineBits.push(`${leadsCreated} lead(s) generated`);
  if (typeof itemCount === "number") pipelineBits.push(`${itemCount} message(s) drafted`);
  if (typeof enrollmentCount === "number") pipelineBits.push(`${enrollmentCount} sequence enrollment(s)`);
  if (typeof tasksCreated === "number") pipelineBits.push(`${tasksCreated} sequence task(s) created`);

  summaryParts.push(
    pipelineBits.length > 0
      ? `Pipeline run complete: ${pipelineBits.join(", ")}.`
      : "Pipeline run complete: no prior-stage counts were available to report.",
  );

  if (funnel) {
    const qualifiedToContacted = funnel.dropoffs.find(
      (d) => d.fromStage === "qualified" && d.toStage === "contacted",
    );
    if (qualifiedToContacted) {
      summaryParts.push(
        `Funnel drop-off: ${qualifiedToContacted.dropoffPercent.toFixed(0)}% between qualified and contacted.`,
      );
    }
  }

  if (nextBestActions) {
    summaryParts.push(`${nextBestActions.length} next-best-action(s) recommended.`);
  }

  if (variantPerformance && variantPerformance.channels.length === 0 && variantPerformance.note) {
    summaryParts.push(`Variant performance: ${variantPerformance.note}.`);
  }

  if (rubricReviewReadiness?.readyForReview) {
    summaryParts.push(
      `Scoring rubric has ${rubricReviewReadiness.feedbackCount} outcome(s) logged — ready for a review.`,
    );
  }

  const result: StageResult = {
    stage: "analytics_learning",
    status: "completed",
    summary: summaryParts.join(" "),
    data,
  };
  return result;
};
