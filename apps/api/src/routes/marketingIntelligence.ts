import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { answerQuestion } from "../lib/marketingQa.js";
import { recommendNextActions } from "../lib/nextBestAction.js";
import { generateReport, type ReportPeriodType } from "../lib/reportGenerator.js";

/**
 * marketingIntelligenceRouter: mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/marketing-intelligence
 *
 * Phase 2 item 6, "Marketing Intelligence Agent": ask questions in natural
 * language, explain why leads/conversions changed, generate weekly/monthly
 * reports, recommend the next best marketing action.
 *
 * "Natural language" here is a deterministic intent classifier
 * (src/lib/marketingQa.ts), NOT an LLM call — no LLM API key is wired up in
 * this environment. Every question asked through POST /ask is logged to
 * marketing_qa_log regardless of whether it matched a supported intent,
 * which is the honest audit trail this feature promises (an unmatched
 * question is still real, logged data — never silently dropped).
 */
export const marketingIntelligenceRouter = Router({ mergeParams: true });
marketingIntelligenceRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

function getProjectId(req: import("express").Request): string {
  return z.string().uuid().parse((req.params as Record<string, string>).projectId);
}

const askSchema = z.object({
  question: z.string().trim().min(1).max(2000),
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/marketing-intelligence/ask */
marketingIntelligenceRouter.post("/ask", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);
    const body = askSchema.parse(req.body);

    const { matchedIntent, answer, llmExplanation } = await answerQuestion(
      req.tenantDb!,
      req.tenantId!,
      projectId,
      body.question,
    );

    // Logged regardless of match/no-match — an honest audit trail of every
    // question asked, matched or not.
    await req.tenantDb!.query(
      `INSERT INTO marketing_qa_log (tenant_id, project_id, user_id, question, matched_intent, answer_summary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.tenantId, projectId, req.userId ?? null, body.question, matchedIntent, answer],
    );

    res.status(200).json({ matchedIntent, answer, llmExplanation });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/marketing-intelligence/qa-log */
marketingIntelligenceRouter.get("/qa-log", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const result = await req.tenantDb!.query(
      `SELECT id, question, matched_intent, answer_summary, created_at
       FROM marketing_qa_log
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );

    res.json({ qaLog: result.rows });
  } catch (err) {
    next(err);
  }
});

const PERIOD_TYPES = ["weekly", "monthly"] as const;

const createReportSchema = z.object({
  periodType: z.enum(PERIOD_TYPES),
  periodStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be an ISO date string (YYYY-MM-DD)"),
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/marketing-intelligence/reports */
marketingIntelligenceRouter.post("/reports", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);
    const body = createReportSchema.parse(req.body);

    const periodStart = new Date(`${body.periodStart}T00:00:00.000Z`);
    if (Number.isNaN(periodStart.getTime())) {
      throw Errors.badRequest("periodStart is not a valid date");
    }

    const reportData = await generateReport(
      req.tenantDb!,
      req.tenantId!,
      projectId,
      body.periodType as ReportPeriodType,
      periodStart,
    );

    const insertResult = await req.tenantDb!.query(
      `INSERT INTO marketing_reports (tenant_id, project_id, period_type, period_start, period_end, summary_data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, project_id, period_type, period_start, period_end, summary_data, generated_at, created_at`,
      [req.tenantId, projectId, reportData.periodType, reportData.periodStart, reportData.periodEnd, reportData],
    );

    res.status(201).json({ report: insertResult.rows[0] });
  } catch (err) {
    next(err);
  }
});

const listReportsQuerySchema = z.object({
  periodType: z.enum(PERIOD_TYPES).optional(),
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/marketing-intelligence/reports */
marketingIntelligenceRouter.get("/reports", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);
    const query = listReportsQuerySchema.parse(req.query);

    const conditions = ["tenant_id = $1", "project_id = $2"];
    const params: unknown[] = [req.tenantId, projectId];
    if (query.periodType) {
      params.push(query.periodType);
      conditions.push(`period_type = $${params.length}`);
    }

    const result = await req.tenantDb!.query(
      `SELECT id, tenant_id, project_id, period_type, period_start, period_end, summary_data, generated_at, created_at
       FROM marketing_reports
       WHERE ${conditions.join(" AND ")}
       ORDER BY period_start DESC`,
      params,
    );

    res.json({ reports: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/marketing-intelligence/reports/:id */
marketingIntelligenceRouter.get("/reports/:id", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);
    const reportId = z.string().uuid().parse((req.params as Record<string, string>).id);

    const result = await req.tenantDb!.query(
      `SELECT id, tenant_id, project_id, period_type, period_start, period_end, summary_data, generated_at, created_at
       FROM marketing_reports
       WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [reportId, req.tenantId, projectId],
    );
    if (result.rowCount === 0) throw Errors.notFound("Report not found");

    res.json({ report: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/marketing-intelligence/next-best-actions */
marketingIntelligenceRouter.get("/next-best-actions", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const actions = await recommendNextActions(req.tenantDb!, req.tenantId!, projectId);

    res.json({ actions });
  } catch (err) {
    next(err);
  }
});
