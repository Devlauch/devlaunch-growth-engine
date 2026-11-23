import type { PoolClient } from "pg";

/**
 * Workstream D ("Forms, surveys and feedback intelligence").
 *
 * A survey (packages/db/migrations/630_create_surveys.sql) is a distinct
 * entity from the existing lead-capture system (leads / landing_pages /
 * lead_magnets) — this file never duplicates that: when a survey response
 * legitimately identifies a lead, callers are expected to pass the result
 * through the EXISTING apps/api/src/lib/leadIngestion.ts's ingestLead()
 * (see src/routes/publicSurveys.ts) and only then pass the resulting
 * leadId in here as `options.leadId`.
 *
 * Conditional-logic shape below is a deliberately small, bespoke subset
 * inspired by (not copied from) the sibling Formbricks repo's branching
 * concept (packages/types/surveys/logic.ts,
 * packages/surveys/src/lib/logic.ts) — no jump-to-page graph, no variable
 * substitution, just "does question X's answer make question Y visible".
 * Formbricks' own LICENSE scopes AGPLv3 to everything outside
 * apps/web/modules/ee and packages/js|android|ios|api|surveys|survey-ui
 * (those are MIT); either way nothing from that repo's source was
 * reproduced here.
 */

export type QuestionType = "text" | "single_choice" | "multi_choice" | "rating" | "nps" | "csat";

export interface ConditionalRule {
  /** The `key` of the question whose answer this rule reads. */
  questionKey: string;
  /** Show this question only when that answer === this value. */
  equals?: unknown;
  /** Show this question only when that answer !== this value. */
  notEquals?: unknown;
  /** Show this question only when that answer is one of these values. */
  in?: unknown[];
}

export interface Question {
  key: string;
  type: QuestionType;
  label: string;
  options?: string[];
  /** Absent/undefined = always shown once reached. */
  conditionalOn?: ConditionalRule;
}

export interface Survey {
  id: string;
  type: "multi_step_form" | "nps" | "csat" | "post_demo_feedback" | "qualification";
  questions: Question[];
}

export type SurveyAnswers = Record<string, unknown>;

/** True when `rule` is satisfied by the answers collected so far. */
function conditionSatisfied(rule: ConditionalRule, answersSoFar: SurveyAnswers): boolean {
  if (!(rule.questionKey in answersSoFar)) {
    // The question this rule depends on hasn't been answered yet, so the
    // dependent question can't be shown yet either — never show a
    // follow-up before its trigger has an answer.
    return false;
  }
  const actual = answersSoFar[rule.questionKey];

  if (rule.equals !== undefined) return actual === rule.equals;
  if (rule.notEquals !== undefined) return actual !== rule.notEquals;
  if (rule.in !== undefined) return rule.in.includes(actual);

  // A conditionalOn block with none of equals/notEquals/in set means "show
  // once the trigger question has any answer at all".
  return true;
}

function isQuestionVisible(question: Question, answersSoFar: SurveyAnswers): boolean {
  if (!question.conditionalOn) return true;
  return conditionSatisfied(question.conditionalOn, answersSoFar);
}

/**
 * Pure function: given a survey's full question schema and the answers
 * collected so far, returns the questions that should be shown next — i.e.
 * every question that is (a) visible under its own conditionalOn rule (or
 * has none) and (b) not already answered. Order is preserved from
 * `survey.questions`. No LLM, no I/O — real branching logic only.
 */
export function evaluateConditionalQuestions(survey: Survey, answersSoFar: SurveyAnswers): Question[] {
  return survey.questions.filter(
    (question) => isQuestionVisible(question, answersSoFar) && !(question.key in answersSoFar),
  );
}

export interface RecordSurveyResponseOptions {
  /** Continues/updates an existing in-progress response instead of starting a new one. */
  responseId?: string;
  leadId?: string | null;
  visitorId?: string | null;
  /** NPS/CSAT scalar score, if this submission carries one. */
  score?: number | null;
  /** Marks this response as finished (sets completed = true, completed_at = now()). */
  markComplete?: boolean;
}

interface QueryableDb {
  query: PoolClient["query"];
}

/**
 * Inserts a brand-new survey_responses row, or (when options.responseId is
 * given) merges `partialAnswers` into an existing one — this is what makes
 * partial/abandoned saves possible: a multi-step form/widget can call this
 * once per step, and formAbandonmentTracking.ts can later measure how many
 * respondents never reached a markComplete call.
 */
export async function recordSurveyResponse(
  tenantDb: QueryableDb,
  tenantId: string,
  surveyId: string,
  partialAnswers: SurveyAnswers,
  options: RecordSurveyResponseOptions = {},
): Promise<string> {
  const { responseId, leadId, visitorId, score, markComplete } = options;

  if (responseId) {
    const result = await tenantDb.query<{ id: string }>(
      `UPDATE survey_responses
         SET answers = answers || $1::jsonb,
             score = COALESCE($2, score),
             lead_id = COALESCE($3, lead_id),
             visitor_id = COALESCE($4, visitor_id),
             completed = completed OR $5,
             completed_at = CASE WHEN $5 THEN now() ELSE completed_at END
       WHERE id = $6 AND tenant_id = $7 AND survey_id = $8
       RETURNING id`,
      [
        JSON.stringify(partialAnswers ?? {}),
        score ?? null,
        leadId ?? null,
        visitorId ?? null,
        Boolean(markComplete),
        responseId,
        tenantId,
        surveyId,
      ],
    );
    if (result.rowCount === 0) {
      throw new Error(`survey_responses row ${responseId} not found for survey ${surveyId}/tenant ${tenantId}`);
    }
    return result.rows[0].id;
  }

  const result = await tenantDb.query<{ id: string }>(
    `INSERT INTO survey_responses (
       survey_id, tenant_id, lead_id, visitor_id, answers, score, completed, completed_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, CASE WHEN $7 THEN now() ELSE NULL END)
     RETURNING id`,
    [
      surveyId,
      tenantId,
      leadId ?? null,
      visitorId ?? null,
      JSON.stringify(partialAnswers ?? {}),
      score ?? null,
      Boolean(markComplete),
    ],
  );
  return result.rows[0].id;
}

export interface NpsResult {
  /** %promoters - %detractors, rounded to the nearest integer, range -100..100. */
  score: number;
  promoters: number;
  passives: number;
  detractors: number;
}

/**
 * Standard NPS math: respondents scoring 9-10 are promoters, 7-8 are
 * passives, 0-6 are detractors. The NPS score itself is
 * %promoters - %detractors (never (promoters-detractors)/total alone,
 * which only coincides with the standard formula when there are no
 * passives — this computes the percentages explicitly first).
 */
export function computeNpsScore(responses: Array<{ score: number | null }>): NpsResult {
  const scored = responses.filter((r): r is { score: number } => typeof r.score === "number");
  const total = scored.length;

  let promoters = 0;
  let passives = 0;
  let detractors = 0;

  for (const { score } of scored) {
    if (score >= 9) promoters += 1;
    else if (score >= 7) passives += 1;
    else detractors += 1;
  }

  if (total === 0) {
    return { score: 0, promoters: 0, passives: 0, detractors: 0 };
  }

  const promoterPct = (promoters / total) * 100;
  const detractorPct = (detractors / total) * 100;

  return {
    score: Math.round(promoterPct - detractorPct),
    promoters,
    passives,
    detractors,
  };
}

export interface CsatResult {
  average: number;
  /** score -> count of responses with that exact score. */
  distribution: Record<number, number>;
  /** Standard CSAT "top-box" %: share of responses at the top of a 1-5 scale (4 or 5), i.e. "satisfied" or "very satisfied". */
  topBoxPercent: number;
}

/**
 * Standard CSAT math over a conventional 1-5 satisfaction scale:
 *   - average = mean of all scores.
 *   - distribution = raw histogram, for charting.
 *   - topBoxPercent = (count of responses scoring 4 or 5) / total * 100 —
 *     the industry-standard "% satisfied" definition (top-two-box of a
 *     5-point scale), not just the literal top score.
 */
export function computeCsatScore(responses: Array<{ score: number | null }>): CsatResult {
  const scored = responses.filter((r): r is { score: number } => typeof r.score === "number");
  const total = scored.length;

  const distribution: Record<number, number> = {};
  let sum = 0;
  let topBoxCount = 0;

  for (const { score } of scored) {
    distribution[score] = (distribution[score] ?? 0) + 1;
    sum += score;
    if (score >= 4) topBoxCount += 1;
  }

  if (total === 0) {
    return { average: 0, distribution: {}, topBoxPercent: 0 };
  }

  return {
    average: sum / total,
    distribution,
    topBoxPercent: (topBoxCount / total) * 100,
  };
}

export interface SurveyResponseForCrmSync {
  id: string;
  survey_id: string;
  lead_id: string | null;
  score: number | null;
  completed: boolean;
}

/**
 * Writes a real activity-timeline entry for this response, reusing the
 * EXISTING mechanism apps/api/src/lib/activityTimeline.ts already reads
 * from — audit_events rows with entity_type = 'lead' (see that file's own
 * header comment and lib/leadIngestion.ts's 'lead.created' write, which is
 * the exact same pattern). activityTimeline.ts itself is a read-only
 * aggregator with no write function of its own to call into; audit_events
 * is the table both it and leadIngestion.ts already treat as the lead
 * activity write path, so this inserts into that same table rather than
 * creating a second notes/activity table.
 *
 * No-ops (returns false) when the response isn't linked to a lead — a
 * survey response is never forced to become/affect a lead.
 */
export async function syncResponseToCrm(
  tenantDb: QueryableDb,
  tenantId: string,
  response: SurveyResponseForCrmSync,
): Promise<boolean> {
  if (!response.lead_id) return false;

  await tenantDb.query(
    `INSERT INTO audit_events (tenant_id, actor_type, action, entity_type, entity_id, metadata)
     VALUES ($1, 'system', $2, 'lead', $3, $4::jsonb)`,
    [
      tenantId,
      response.completed ? "survey.response_completed" : "survey.response_partial",
      response.lead_id,
      JSON.stringify({
        surveyId: response.survey_id,
        responseId: response.id,
        score: response.score,
      }),
    ],
  );
  return true;
}
