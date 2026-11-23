import type { PoolClient } from "pg";
import { Errors } from "./httpError.js";

/**
 * Workstream D: real form-abandonment measurement for multi-step
 * forms/surveys (packages/db/migrations/632_create_survey_responses.sql).
 *
 * There is no separate per-question-step tracking table — rather than
 * inventing one, this uses the number of keys already present in a
 * response's `answers` jsonb blob as an honest proxy for "how far this
 * respondent got" (same shape evaluateConditionalQuestions()/
 * recordSurveyResponse() in surveyEngine.ts write and merge). Postgres has
 * no `jsonb_object_length`; `(SELECT count(*) FROM jsonb_object_keys(...))`
 * is the standard way to count an object's own top-level keys.
 */

interface QueryableDb {
  query: PoolClient["query"];
}

export interface DateRange {
  from?: string | Date;
  to?: string | Date;
}

export interface AbandonmentFunnelStep {
  /** Number of questions answered so far (0 = started, never answered anything). */
  stepsAnswered: number;
  /** Respondents who answered AT LEAST this many questions (cumulative, i.e. the funnel count at this step). */
  respondentsReachingStep: number;
  /** Share of all respondents who started the survey and reached at least this step. */
  reachRate: number;
  /** Share of respondents who reached the PREVIOUS step but dropped off before reaching this one. */
  dropOffRate: number;
}

export interface FormAbandonmentStats {
  surveyId: string;
  totalQuestions: number;
  totalStarted: number;
  totalCompleted: number;
  completionRate: number;
  funnel: AbandonmentFunnelStep[];
  rangeFrom: string;
  rangeTo: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveRange(dateRange: DateRange | undefined): { from: Date; to: Date } {
  const to = dateRange?.to ? new Date(dateRange.to) : new Date();
  const from = dateRange?.from ? new Date(dateRange.from) : new Date(to.getTime() - 30 * DAY_MS);
  return { from, to };
}

/**
 * Real SQL + aggregation: counts, per "number of questions answered so
 * far" bucket, how many survey_responses rows for this survey/project
 * reached at least that many answers, then derives a cumulative funnel and
 * per-step drop-off rate — the actual measure of form abandonment.
 */
export async function getFormAbandonmentStats(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  surveyId: string,
  dateRange?: DateRange,
): Promise<FormAbandonmentStats> {
  const { from, to } = resolveRange(dateRange);

  const surveyResult = await tenantDb.query<{ questions: unknown }>(
    `SELECT questions FROM surveys WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [surveyId, tenantId, projectId],
  );
  if (surveyResult.rowCount === 0) {
    throw Errors.notFound("Survey not found");
  }
  const questions = Array.isArray(surveyResult.rows[0].questions) ? surveyResult.rows[0].questions : [];
  const totalQuestions = questions.length;

  const bucketsResult = await tenantDb.query<{
    completed: boolean;
    answered_count: string;
    respondents: string;
  }>(
    `SELECT
       sr.completed,
       (SELECT count(*) FROM jsonb_object_keys(sr.answers)) AS answered_count,
       count(*) AS respondents
     FROM survey_responses sr
     WHERE sr.tenant_id = $1
       AND sr.survey_id = $2
       AND sr.started_at >= $3
       AND sr.started_at <= $4
     GROUP BY sr.completed, answered_count
     ORDER BY answered_count ASC`,
    [tenantId, surveyId, from.toISOString(), to.toISOString()],
  );

  let totalStarted = 0;
  let totalCompleted = 0;
  // answeredCount -> number of respondents whose answers blob has EXACTLY
  // that many keys (not yet cumulative).
  const exactCounts = new Map<number, number>();

  for (const row of bucketsResult.rows) {
    const answeredCount = Number(row.answered_count);
    const respondents = Number(row.respondents);
    totalStarted += respondents;
    if (row.completed) totalCompleted += respondents;
    exactCounts.set(answeredCount, (exactCounts.get(answeredCount) ?? 0) + respondents);
  }

  // Cumulative funnel: step N = respondents who answered >= N questions.
  // Walking from the highest answered_count down lets each step sum
  // "everyone at this count or further" in one pass.
  const maxStep = Math.max(totalQuestions, ...Array.from(exactCounts.keys()), 0);
  const reachingAtLeast = new Array<number>(maxStep + 1).fill(0);
  let runningTotal = 0;
  for (let step = maxStep; step >= 0; step -= 1) {
    runningTotal += exactCounts.get(step) ?? 0;
    reachingAtLeast[step] = runningTotal;
  }

  const funnel: AbandonmentFunnelStep[] = [];
  for (let step = 0; step <= totalQuestions; step += 1) {
    const respondentsReachingStep = reachingAtLeast[step] ?? 0;
    const previousStepReach = step === 0 ? totalStarted : (reachingAtLeast[step - 1] ?? 0);
    funnel.push({
      stepsAnswered: step,
      respondentsReachingStep,
      reachRate: totalStarted > 0 ? respondentsReachingStep / totalStarted : 0,
      dropOffRate: previousStepReach > 0 ? 1 - respondentsReachingStep / previousStepReach : 0,
    });
  }

  return {
    surveyId,
    totalQuestions,
    totalStarted,
    totalCompleted,
    completionRate: totalStarted > 0 ? totalCompleted / totalStarted : 0,
    funnel,
    rangeFrom: from.toISOString(),
    rangeTo: to.toISOString(),
  };
}
