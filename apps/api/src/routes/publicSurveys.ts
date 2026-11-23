import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { logger } from "../lib/logger.js";
import { recordSurveyResponse, syncResponseToCrm, type Survey } from "../lib/surveyEngine.js";
import { leadInputSchema, ingestLead } from "../lib/leadIngestion.js";

/**
 * Public, unauthenticated-by-design survey endpoints — the server side of
 * packages/embed-widget/surveys.js, the exact same security model as
 * routes/publicLeads.ts: no session/JWT, protected instead by
 *   1. The survey's own uuid `id` as the lookup key (unguessable, same
 *      role publicLeads.ts's public_api_key plays) — see
 *      packages/db/migrations/631_enable_rls_surveys.sql's
 *      app.lookup_survey_id carve-out.
 *   2. Rate limiting, per IP and per survey id (below).
 *   3. Input validation (zod schemas here + leadIngestion.ts's own).
 *
 * This is a DISTINCT feature from publicLeads.ts's lead-capture widget: a
 * survey response only ever becomes/updates a `leads` row when the caller
 * explicitly supplies `contact` info AND the submission is final
 * (markComplete) — and even then, only via the EXISTING ingestLead(), never
 * a direct INSERT INTO leads.
 *
 * Consent: raw IP is never persisted (survey_responses has no IP column at
 * all — see 632_create_survey_responses.sql). The hash below is used only
 * as an in-memory rate-limit key, exactly like publicLeads.ts's hashIp.
 * Do-Not-Track is honored client-side by surveys.js (same convention as
 * packages/embed-widget/analytics.js): a DNT browser never calls this route
 * in the first place, so there is nothing further to opt out of here.
 */
export const publicSurveysRouter = Router();

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

const PUBLIC_SURVEYS_RATE_LIMIT_PER_IP_PER_MIN = Number(process.env.PUBLIC_SURVEYS_RATE_LIMIT_PER_IP_PER_MIN ?? 30);
const PUBLIC_SURVEYS_RATE_LIMIT_PER_KEY_PER_MIN = Number(process.env.PUBLIC_SURVEYS_RATE_LIMIT_PER_KEY_PER_MIN ?? 120);

const perIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: PUBLIC_SURVEYS_RATE_LIMIT_PER_IP_PER_MIN,
  name: "public-surveys-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});

const perKeyLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: PUBLIC_SURVEYS_RATE_LIMIT_PER_KEY_PER_MIN,
  name: "public-surveys-key",
  keyFn: (req) => req.params.id,
});

const surveyIdParamSchema = z.string().uuid();

/**
 * GET /api/v1/public/surveys/:id
 *
 * Returns only what the widget needs to render: type + question schema.
 * Never exposes tenant_id/project_id or any other tenant-internal field.
 */
publicSurveysRouter.get("/surveys/:id", perIpLimiter, perKeyLimiter, async (req, res, next) => {
  const client = await pool.connect();
  let settled = false;
  try {
    const surveyId = surveyIdParamSchema.parse(req.params.id);

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.lookup_survey_id', $1, true)", [surveyId]);

    const result = await client.query(
      `SELECT id, type, questions FROM surveys WHERE id = $1 AND status = 'active'`,
      [surveyId],
    );

    await client.query("ROLLBACK");
    settled = true;
    client.release();

    if (result.rowCount === 0) {
      next(Errors.notFound("Unknown or inactive survey"));
      return;
    }

    const survey = result.rows[0];
    res.json({ survey: { id: survey.id, type: survey.type, questions: survey.questions } });
  } catch (err) {
    if (!settled) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
});

// A deliberately small, local shape for the optional "this response should
// become/update a lead" payload — NOT a copy of leadInputSchema (that's a
// ZodEffects, due to its own .refine(), so it has no .partial() to borrow).
// The real, authoritative validation (including leadInputSchema's own
// "name or email required" refine) still happens via leadInputSchema.parse()
// right before ingestLead() is called below, so nothing here is a parallel
// source of truth — this just lets the request shape declare the field as
// fully optional until that gate.
const contactSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  company: z.string().trim().max(200).optional(),
  message: z.string().trim().max(5000).optional(),
});

const submitResponseSchema = z.object({
  responseId: z.string().uuid().optional(),
  answers: z.record(z.string(), z.unknown()).default({}),
  score: z.number().int().min(0).max(10).optional(),
  markComplete: z.boolean().optional().default(false),
  visitorId: z.string().trim().min(8).max(100).optional(),
  // Only present when the submission should become/update a lead — never
  // inferred/guessed from arbitrary answer keys. Re-validated by the
  // EXISTING leadIngestion.ts schema right below, not reimplemented here.
  contact: contactSchema.optional(),
});

/**
 * POST /api/v1/public/surveys/:id/responses
 *
 * Submit or partial-save a response. Every call writes/merges into one
 * survey_responses row (see lib/surveyEngine.ts's recordSurveyResponse):
 * the FIRST call for a given respondent omits `responseId` and gets one
 * back; every subsequent call (next step, or the final submit) passes that
 * same `responseId` so this update merges into the SAME row instead of
 * creating a new one — that's what makes abandonment measurable
 * (lib/formAbandonmentTracking.ts counts rows that never got a
 * markComplete=true call).
 */
publicSurveysRouter.post("/surveys/:id/responses", perIpLimiter, perKeyLimiter, async (req, res, next) => {
  const client = await pool.connect();
  let settled = false;
  try {
    const surveyId = surveyIdParamSchema.parse(req.params.id);
    const body = submitResponseSchema.parse(req.body);

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.lookup_survey_id', $1, true)", [surveyId]);

    const surveyResult = await client.query<{ id: string; tenant_id: string; project_id: string; type: string }>(
      `SELECT id, tenant_id, project_id, type FROM surveys WHERE id = $1 AND status = 'active'`,
      [surveyId],
    );

    if (surveyResult.rowCount === 0) {
      await client.query("ROLLBACK");
      settled = true;
      client.release();
      logger.warn({ surveyId }, "public survey response rejected: unknown/inactive survey");
      next(Errors.notFound("Unknown or inactive survey"));
      return;
    }

    const survey = surveyResult.rows[0];

    // Switch into this survey's real tenant so the actual write goes
    // through the normal tenant-isolated survey_responses RLS policy
    // (633_enable_rls_survey_responses.sql) — same two-step pattern as
    // routes/publicLeads.ts.
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [survey.tenant_id]);

    let leadId: string | null = null;
    if (body.markComplete && body.contact && (body.contact.name || body.contact.email)) {
      const contactInput = leadInputSchema.parse(body.contact);
      const lead = await ingestLead({
        client,
        tenantId: survey.tenant_id,
        projectId: survey.project_id,
        input: contactInput,
        source: "public_widget",
        origin: req.header("origin") ?? null,
        ipHash: hashIp(req.ip ?? "unknown"),
      });
      leadId = lead.id;
    }

    const responseId = await recordSurveyResponse(client, survey.tenant_id, surveyId, body.answers, {
      responseId: body.responseId,
      leadId,
      visitorId: body.visitorId ?? null,
      score: body.score ?? null,
      markComplete: body.markComplete,
    });

    if (body.markComplete) {
      const responseRow = await client.query<{
        id: string;
        survey_id: string;
        lead_id: string | null;
        score: number | null;
        completed: boolean;
      }>(
        `SELECT id, survey_id, lead_id, score, completed FROM survey_responses WHERE id = $1 AND tenant_id = $2`,
        [responseId, survey.tenant_id],
      );
      if ((responseRow.rowCount ?? 0) > 0) {
        try {
          await syncResponseToCrm(client, survey.tenant_id, responseRow.rows[0]);
        } catch (err) {
          // Best-effort, same posture as leadIngestion.ts's own Chatwoot
          // sync: a CRM-timeline write must never fail the survey submit.
          logger.warn({ err, surveyId, responseId }, "survey->CRM activity sync failed, continuing");
        }
      }
    }

    await client.query("COMMIT");
    settled = true;
    client.release();

    res.status(201).json({ responseId, leadId, completed: body.markComplete });
  } catch (err) {
    if (!settled) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
});

// Re-exported only so test files can build a minimal Survey-shaped fixture
// without re-declaring the type.
export type { Survey };
