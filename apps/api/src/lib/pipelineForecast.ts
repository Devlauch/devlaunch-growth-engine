import type { PoolClient } from "pg";
import type { DealStage } from "./salesPipeline.js";

/**
 * pipelineForecast.ts: deterministic, stage-weighted sales pipeline
 * forecast (sibling of the Sales Conversion Agent's deal pipeline,
 * apps/api/src/routes/deals.ts / apps/api/src/lib/salesPipeline.ts).
 *
 * STAGE_FORECAST_WEIGHTS below are reasonable, clearly-labeled ESTIMATES
 * of probability-to-close per stage — NOT calibrated against this
 * tenant's actual historical win rates (no stage-level win-rate analytics
 * exist in this codebase to calibrate against, and computing one
 * correctly needs real historical stage-transition data this schema does
 * not keep — see activityTimeline.ts's documented limitation: deals has
 * no stage-history table, only the current stage's stage_changed_at). A
 * tenant could eventually configure these per project, the same way
 * scoring_rubrics (apps/api/src/routes/scoring.ts) lets a tenant configure
 * lead-scoring weights — that is out of scope here; a single fixed
 * default table is sufficient for an MVP forecast.
 *
 * Only 'new' | 'contacted' | 'qualified' | 'proposal' are forecast-able —
 * 'won'/'lost' are terminal (salesPipeline.ts's TERMINAL_DEAL_STAGES) and
 * are excluded from "open pipeline" entirely, not assigned a weight.
 *
 * value_amount is nullable on deals (apps/api/src/routes/deals.ts's
 * createDealSchema). A deal with no recorded value is still counted in
 * dealCount (so deal-count totals are never silently wrong), but it NEVER
 * contributes a fabricated dollar amount to totalValue/weightedValue —
 * only deals with a real value_amount contribute to those, same
 * never-fabricate-a-number convention as growthRevenueAnalytics.ts's
 * "not_available" CAC/ROI handling.
 */

export const STAGE_FORECAST_WEIGHTS: Record<Exclude<DealStage, "won" | "lost">, number> = {
  new: 0.1,
  contacted: 0.25,
  qualified: 0.5,
  proposal: 0.75,
};

const FORECASTABLE_STAGES = Object.keys(STAGE_FORECAST_WEIGHTS) as (keyof typeof STAGE_FORECAST_WEIGHTS)[];

export interface PipelineForecastStageBreakdown {
  stage: string;
  weight: number;
  dealCount: number;
  dealsWithValueCount: number;
  totalValue: number;
  weightedValue: number;
}

export interface PipelineForecastTotals {
  dealCount: number;
  dealsWithValueCount: number;
  totalValue: number;
  weightedValue: number;
}

export interface PipelineForecastResult {
  stageWeights: Record<string, number>;
  byStage: PipelineForecastStageBreakdown[];
  totals: PipelineForecastTotals;
  /** True when zero open deals have a value_amount set — mirrors
   * growthRevenueAnalytics.ts's "not_available" honesty convention: deal
   * *counts* are still real and reported, but the dollar forecast cannot
   * be computed from nothing and is never guessed. */
  insufficientData: boolean;
  note?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function computePipelineForecast(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<PipelineForecastResult> {
  const result = await tenantDb.query<{
    stage: string;
    deal_count: string;
    deals_with_value_count: string;
    total_value: string | null;
  }>(
    `SELECT stage,
            COUNT(*) AS deal_count,
            COUNT(*) FILTER (WHERE value_amount IS NOT NULL) AS deals_with_value_count,
            COALESCE(SUM(value_amount) FILTER (WHERE value_amount IS NOT NULL), 0) AS total_value
     FROM deals
     WHERE tenant_id = $1 AND project_id = $2 AND stage NOT IN ('won', 'lost')
     GROUP BY stage`,
    [tenantId, projectId],
  );

  const rowsByStage = new Map(result.rows.map((r) => [r.stage, r]));

  const byStage: PipelineForecastStageBreakdown[] = [];
  let totalDealCount = 0;
  let totalDealsWithValue = 0;
  let totalValue = 0;
  let totalWeightedValue = 0;

  for (const stage of FORECASTABLE_STAGES) {
    const row = rowsByStage.get(stage);
    const dealCount = row ? Number(row.deal_count) : 0;
    const dealsWithValueCount = row ? Number(row.deals_with_value_count) : 0;
    const stageTotalValue = row ? Number(row.total_value ?? 0) : 0;
    const weight = STAGE_FORECAST_WEIGHTS[stage];
    const weightedValue = round2(stageTotalValue * weight);

    byStage.push({
      stage,
      weight,
      dealCount,
      dealsWithValueCount,
      totalValue: round2(stageTotalValue),
      weightedValue,
    });

    totalDealCount += dealCount;
    totalDealsWithValue += dealsWithValueCount;
    totalValue += stageTotalValue;
    totalWeightedValue += weightedValue;
  }

  const insufficientData = totalDealsWithValue === 0;

  return {
    stageWeights: { ...STAGE_FORECAST_WEIGHTS },
    byStage,
    totals: {
      dealCount: totalDealCount,
      dealsWithValueCount: totalDealsWithValue,
      totalValue: round2(totalValue),
      weightedValue: round2(totalWeightedValue),
    },
    insufficientData,
    ...(insufficientData
      ? {
          note:
            "No open (non-terminal-stage) deals have a value_amount set — the dollar forecast is not available. " +
            "Deal counts above are real and unaffected; the $0 totals are reported honestly, never a guessed forecast.",
        }
      : {}),
  };
}
