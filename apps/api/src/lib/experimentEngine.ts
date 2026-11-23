/**
 * Workstream C2: a real, general-purpose A/B testing / growth
 * experimentation engine.
 *
 * Deliberately NOT a rewrite of the existing Phase 2 "Conversion
 * Optimization Agent" experiment infra (088_create_experiments.sql /
 * 089_create_experiment_results.sql, reused unchanged by
 * apps/api/src/routes/landingPages.ts's POST /:id/ab-test and
 * apps/api/src/routes/conversionOptimization.ts) -- that system only ever
 * compares exactly two variants (a/b) of one landing page, assigns a
 * variant per request (landingPageBuilder.ts's pickVariant(), not a stable
 * per-visitor assignment), and has no statistical-significance test. This
 * module instead supports N weighted variants, four target-entity kinds
 * (landing_page/form/email_subject/cta), deterministic stable per-visitor
 * hash assignment, a real two-proportion z-test before declaring a winner,
 * and approval-gated application of the winner, reusing the EXISTING
 * approvals table/engine (apps/api/src/routes/approvals.ts) rather than
 * building a second one. The two systems intentionally coexist.
 *
 * Inspired by (not copied from) ~/project/Growth/posthog's experimentation
 * product: PostHog's feature-flag matching hashes (distinct_id + flag key)
 * into [0, 1) and walks cumulative rollout percentages -- the same
 * deterministic-hash-to-stable-bucket idea hashToUnitInterval() /
 * pickVariantForWeights() apply below, implemented from scratch against
 * this schema's own {key,label,weight} variant shape. PostHog's newer
 * products/experiments module (outside ee/, under the repo's main MIT
 * license) supports both frequentist and Bayesian stats methods; this
 * module implements a plain two-proportion z-test (frequentist), enough to
 * uphold the "never significant below min_sample_size" guarantee without a
 * new dependency.
 */
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { Errors } from "./httpError.js";

export interface ExperimentVariant {
  key: string;
  label: string;
  weight: number;
  [field: string]: unknown;
}

export type TargetEntityType = "landing_page" | "form" | "email_subject" | "cta";
export type ExperimentStatus = "draft" | "running" | "concluded" | "abandoned";

export interface GrowthExperimentRow {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  hypothesis: string | null;
  target_entity_type: TargetEntityType;
  target_entity_id: string;
  status: ExperimentStatus;
  variants: ExperimentVariant[];
  primary_metric_event: string;
  min_sample_size: number;
  started_at: string | null;
  concluded_at: string | null;
  winning_variant_key: string | null;
  created_at: string;
  updated_at: string;
}

export const GROWTH_EXPERIMENT_COLUMNS =
  "id, tenant_id, project_id, name, hypothesis, target_entity_type, target_entity_id, status, variants, primary_metric_event, min_sample_size, started_at, concluded_at, winning_variant_key, created_at, updated_at";

export async function loadExperimentOr404(
  tenantDb: PoolClient,
  tenantId: string,
  experimentId: string,
): Promise<GrowthExperimentRow> {
  const result = await tenantDb.query<GrowthExperimentRow>(
    `SELECT ${GROWTH_EXPERIMENT_COLUMNS} FROM growth_experiments WHERE id = $1 AND tenant_id = $2`,
    [experimentId, tenantId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Growth experiment not found");
  return result.rows[0];
}

export function hashToUnitInterval(input: string): number {
  const digest = createHash("sha256").update(input).digest();
  const n = digest.readUIntBE(0, 6);
  const max = 2 ** 48;
  return n / max;
}

export function pickVariantForWeights(variants: ExperimentVariant[], unit: number): string {
  const totalWeight = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (totalWeight <= 0) {
    throw Errors.internal("Experiment has no positive-weight variants to assign");
  }
  const target = unit * totalWeight;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += Math.max(0, variant.weight);
    if (target < cumulative) return variant.key;
  }
  return variants[variants.length - 1].key;
}

export async function assignVariant(
  tenantDb: PoolClient,
  tenantId: string,
  experimentId: string,
  visitorId: string,
): Promise<string> {
  const existing = await tenantDb.query<{ variant_key: string }>(
    `SELECT variant_key FROM experiment_exposures WHERE tenant_id = $1 AND experiment_id = $2 AND visitor_id = $3`,
    [tenantId, experimentId, visitorId],
  );
  if ((existing.rowCount ?? 0) > 0) return existing.rows[0].variant_key;

  const experiment = await loadExperimentOr404(tenantDb, tenantId, experimentId);
  const unit = hashToUnitInterval(`${experimentId}:${visitorId}`);
  const computedVariantKey = pickVariantForWeights(experiment.variants, unit);

  const inserted = await tenantDb.query<{ variant_key: string }>(
    `INSERT INTO experiment_exposures (tenant_id, experiment_id, visitor_id, variant_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (experiment_id, visitor_id) DO NOTHING
     RETURNING variant_key`,
    [tenantId, experimentId, visitorId, computedVariantKey],
  );
  if ((inserted.rowCount ?? 0) > 0) return inserted.rows[0].variant_key;

  const reread = await tenantDb.query<{ variant_key: string }>(
    `SELECT variant_key FROM experiment_exposures WHERE tenant_id = $1 AND experiment_id = $2 AND visitor_id = $3`,
    [tenantId, experimentId, visitorId],
  );
  return reread.rows[0].variant_key;
}

export async function recordConversion(
  tenantDb: PoolClient,
  tenantId: string,
  experimentId: string,
  visitorId: string,
  metricValue?: number | null,
): Promise<void> {
  await loadExperimentOr404(tenantDb, tenantId, experimentId);
  await tenantDb.query(
    `INSERT INTO experiment_conversions (tenant_id, experiment_id, visitor_id, metric_value)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, experimentId, visitorId, metricValue ?? null],
  );
}

export interface VariantStats {
  variantKey: string;
  label: string;
  exposures: number;
  conversions: number;
  conversionRate: number;
}

export type EvaluationReason =
  | "insufficient_sample_size"
  | "fewer_than_two_variants_with_exposures"
  | "no_exposures_yet";

export interface EvaluationResult {
  experimentId: string;
  sampleSize: number;
  minSampleSize: number;
  variantStats: VariantStats[];
  controlVariantKey: string | null;
  bestVariantKey: string | null;
  zScore: number | null;
  pValue: number | null;
  isSignificant: boolean;
  reason?: EvaluationReason;
}

export function standardNormalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * y);
}

export function twoProportionZTest(
  conversionsA: number,
  exposuresA: number,
  conversionsB: number,
  exposuresB: number,
): { z: number; p: number } {
  if (exposuresA <= 0 || exposuresB <= 0) return { z: 0, p: 1 };
  const rateA = conversionsA / exposuresA;
  const rateB = conversionsB / exposuresB;
  const pooledRate = (conversionsA + conversionsB) / (exposuresA + exposuresB);
  const standardError = Math.sqrt(pooledRate * (1 - pooledRate) * (1 / exposuresA + 1 / exposuresB));
  if (standardError === 0) return { z: 0, p: 1 };
  const z = (rateB - rateA) / standardError;
  const p = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { z, p };
}

const SIGNIFICANCE_ALPHA = 0.05;

export async function evaluateExperiment(
  tenantDb: PoolClient,
  tenantId: string,
  experimentId: string,
): Promise<EvaluationResult> {
  const experiment = await loadExperimentOr404(tenantDb, tenantId, experimentId);

  const exposureRows = await tenantDb.query<{ variant_key: string; exposures: number }>(
    `SELECT variant_key, COUNT(DISTINCT visitor_id)::int AS exposures
     FROM experiment_exposures
     WHERE tenant_id = $1 AND experiment_id = $2
     GROUP BY variant_key`,
    [tenantId, experimentId],
  );
  const conversionRows = await tenantDb.query<{ variant_key: string; conversions: number }>(
    `SELECT ee.variant_key, COUNT(DISTINCT ec.visitor_id)::int AS conversions
     FROM experiment_conversions ec
     JOIN experiment_exposures ee
       ON ee.tenant_id = ec.tenant_id AND ee.experiment_id = ec.experiment_id AND ee.visitor_id = ec.visitor_id
     WHERE ec.tenant_id = $1 AND ec.experiment_id = $2
     GROUP BY ee.variant_key`,
    [tenantId, experimentId],
  );

  const exposuresByVariant = new Map<string, number>(exposureRows.rows.map((r) => [r.variant_key, r.exposures]));
  const conversionsByVariant = new Map<string, number>(conversionRows.rows.map((r) => [r.variant_key, r.conversions]));

  const variantStats: VariantStats[] = experiment.variants.map((variant) => {
    const exposures = exposuresByVariant.get(variant.key) ?? 0;
    const conversions = conversionsByVariant.get(variant.key) ?? 0;
    return {
      variantKey: variant.key,
      label: variant.label,
      exposures,
      conversions,
      conversionRate: exposures > 0 ? conversions / exposures : 0,
    };
  });

  const sampleSize = variantStats.reduce((sum, v) => sum + v.exposures, 0);
  const controlVariantKey = variantStats[0]?.variantKey ?? null;

  const baseResult = {
    experimentId,
    sampleSize,
    minSampleSize: experiment.min_sample_size,
    variantStats,
    controlVariantKey,
    bestVariantKey: null,
    zScore: null,
    pValue: null,
    isSignificant: false as const,
  };

  if (sampleSize < experiment.min_sample_size) {
    return { ...baseResult, reason: "insufficient_sample_size" };
  }
  if (sampleSize === 0) {
    return { ...baseResult, reason: "no_exposures_yet" };
  }

  const control = variantStats[0];
  const challengers = variantStats.slice(1).filter((v) => v.exposures > 0);
  if (!control || control.exposures === 0 || challengers.length === 0) {
    return { ...baseResult, reason: "fewer_than_two_variants_with_exposures" };
  }

  const best = challengers.reduce((a, b) => (b.conversionRate > a.conversionRate ? b : a));
  const zp = twoProportionZTest(control.conversions, control.exposures, best.conversions, best.exposures);
  const isSignificant = zp.p < SIGNIFICANCE_ALPHA;

  return {
    experimentId,
    sampleSize,
    minSampleSize: experiment.min_sample_size,
    variantStats,
    controlVariantKey: control.variantKey,
    bestVariantKey: isSignificant ? (best.conversionRate > control.conversionRate ? best.variantKey : control.variantKey) : null,
    zScore: zp.z,
    pValue: zp.p,
    isSignificant,
  };
}

export interface ApplyWinningVariantResult {
  action: { id: string; status: string };
  approval: { id: string; status: string };
  evaluation: EvaluationResult;
}

export async function applyWinningVariant(
  tenantDb: PoolClient,
  tenantId: string,
  experimentId: string,
  actorUserId: string,
): Promise<ApplyWinningVariantResult> {
  const experiment = await loadExperimentOr404(tenantDb, tenantId, experimentId);
  if (experiment.status !== "running") {
    throw Errors.conflict(`Only a running experiment can have a winner applied (current status: ${experiment.status})`);
  }

  const evaluation = await evaluateExperiment(tenantDb, tenantId, experimentId);
  if (!evaluation.isSignificant || !evaluation.bestVariantKey) {
    const why =
      evaluation.reason === "insufficient_sample_size"
        ? `sample size ${evaluation.sampleSize} is below the configured minimum ${evaluation.minSampleSize}`
        : evaluation.reason
          ? evaluation.reason.replace(/_/g, " ")
          : "no statistically significant difference between variants yet";
    throw Errors.conflict(`Cannot apply a winner: ${why}.`);
  }

  const winningVariant = experiment.variants.find((v) => v.key === evaluation.bestVariantKey);
  if (!winningVariant) throw Errors.internal("Winning variant key not found among this experiment's variants");

  const actionPayload = {
    winningVariantKey: evaluation.bestVariantKey,
    winningVariant,
    targetEntityType: experiment.target_entity_type,
    targetEntityId: experiment.target_entity_id,
    evaluation: {
      sampleSize: evaluation.sampleSize,
      minSampleSize: evaluation.minSampleSize,
      zScore: evaluation.zScore,
      pValue: evaluation.pValue,
      controlVariantKey: evaluation.controlVariantKey,
    },
  };

  const actionResult = await tenantDb.query<{ id: string; status: string }>(
    `INSERT INTO growth_experiment_actions (tenant_id, project_id, experiment_id, action_type, payload, created_by)
     VALUES ($1, $2, $3, 'apply_winning_variant', $4::jsonb, $5)
     RETURNING id, status`,
    [tenantId, experiment.project_id, experimentId, JSON.stringify(actionPayload), actorUserId],
  );
  const action = actionResult.rows[0];

  const reasonText =
    "Apply winning variant '" + evaluation.bestVariantKey + "' for growth experiment '" + experiment.name + "' " +
    "(p=" + (evaluation.pValue !== null ? evaluation.pValue.toFixed(4) : "n/a") + ", n=" + evaluation.sampleSize + ")";

  const approvalResult = await tenantDb.query<{ id: string; status: string }>(
    `INSERT INTO approvals (tenant_id, growth_experiment_action_id, requested_by, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING id, status`,
    [tenantId, action.id, actorUserId, reasonText],
  );
  const approval = approvalResult.rows[0];

  await tenantDb.query(
    `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'user', $2, 'growth_experiment.apply_winner.prepared', 'growth_experiment', $3, $4::jsonb)`,
    [
      tenantId,
      actorUserId,
      experimentId,
      JSON.stringify({ actionId: action.id, approvalId: approval.id, winningVariantKey: evaluation.bestVariantKey }),
    ],
  );

  return { action, approval, evaluation };
}

export interface ExecuteActionResult {
  applied: boolean;
  reason?: string;
}

export async function executeApprovedExperimentAction(
  tenantDb: PoolClient,
  tenantId: string,
  actionId: string,
): Promise<ExecuteActionResult> {
  const actionResult = await tenantDb.query<{
    id: string;
    tenant_id: string;
    experiment_id: string;
    payload: {
      winningVariantKey: string;
      winningVariant: ExperimentVariant;
      targetEntityType: TargetEntityType;
      targetEntityId: string;
    };
    approval_status: string;
  }>(
    `SELECT ga.id, ga.tenant_id, ga.experiment_id, ga.payload, a.status AS approval_status
     FROM growth_experiment_actions ga
     JOIN approvals a ON a.growth_experiment_action_id = ga.id AND a.tenant_id = ga.tenant_id
     WHERE ga.id = $1 AND ga.tenant_id = $2 AND ga.status = 'pending_approval'`,
    [actionId, tenantId],
  );
  const action = actionResult.rows[0];
  if (!action) return { applied: false, reason: "action_not_found_or_already_resolved" };

  if (action.approval_status === "rejected") {
    await tenantDb.query(`UPDATE growth_experiment_actions SET status = 'rejected' WHERE id = $1`, [actionId]);
    return { applied: false, reason: "approval_rejected" };
  }
  if (action.approval_status !== "approved") {
    return { applied: false, reason: "approval_still_pending" };
  }

  const payload = action.payload;
  let result: ExecuteActionResult;

  if (payload.targetEntityType === "landing_page" || payload.targetEntityType === "cta") {
    const variant = payload.winningVariant;
    const headline = typeof variant.headline === "string" ? variant.headline : null;
    const subheadline = typeof variant.subheadline === "string" ? variant.subheadline : null;
    const ctaText = typeof variant.ctaText === "string" ? variant.ctaText : null;
    const ctaUrl = typeof variant.ctaUrl === "string" ? variant.ctaUrl : null;

    const updateResult = await tenantDb.query(
      `UPDATE landing_pages SET
         headline = COALESCE($3, headline),
         subheadline = COALESCE($4, subheadline),
         cta_text = COALESCE($5, cta_text),
         cta_url = COALESCE($6, cta_url)
       WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      [payload.targetEntityId, tenantId, headline, subheadline, ctaText, ctaUrl],
    );
    result =
      (updateResult.rowCount ?? 0) > 0
        ? { applied: true }
        : { applied: false, reason: "target_landing_page_not_found" };
  } else {
    result = { applied: false, reason: "no_live_entity_update_path_for_target_entity_type_" + payload.targetEntityType };
  }

  await tenantDb.query(`UPDATE growth_experiment_actions SET status = 'approved', result = $2::jsonb WHERE id = $1`, [
    actionId,
    JSON.stringify(result),
  ]);

  await tenantDb.query(
    `UPDATE growth_experiments SET status = 'concluded', concluded_at = now(), winning_variant_key = $2
     WHERE id = $1 AND tenant_id = $3`,
    [action.experiment_id, payload.winningVariantKey, tenantId],
  );

  await tenantDb.query(
    `INSERT INTO audit_events (tenant_id, actor_type, action, entity_type, entity_id, metadata)
     VALUES ($1, 'system', 'growth_experiment.winner.applied', 'growth_experiment', $2, $3::jsonb)`,
    [tenantId, action.experiment_id, JSON.stringify({ actionId, result })],
  );

  return result;
}
