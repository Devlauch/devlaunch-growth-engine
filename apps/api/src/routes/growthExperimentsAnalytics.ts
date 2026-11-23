import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { computeFunnel, type FunnelStepDef } from "../lib/funnelAnalytics.js";
import { getVisitorJourney } from "../lib/visitorJourney.js";
import { computeCohortRetention } from "../lib/cohortAnalysis.js";
import { segmentVisitors, type SegmentRule } from "../lib/behavioralSegmentation.js";

/**
 * Workstream C1: "Advanced Analytics" — visitor-behavior funnels, visitor
 * journey reconstruction, cohort retention, and behavioral segmentation, all
 * built on the EXISTING site_visitors/site_sessions/site_pageviews/
 * site_events tables (see apps/api/src/lib/funnelAnalytics.ts,
 * visitorJourney.ts, cohortAnalysis.ts, behavioralSegmentation.ts for the
 * real SQL behind every number).
 *
 * Mount line (app.ts is off-limits this round — give this exact line to
 * whoever owns app.ts next, same convention as siteAnalyticsRouter /
 * growthAnalyticsRouter's own handback notes):
 *
 *   import { growthExperimentsAnalyticsRouter } from "./routes/growthExperimentsAnalytics.js";
 *   ...
 *   app.use(
 *     "/api/v1/tenants/:tenantId/projects/:projectId/advanced-analytics",
 *     mainCors,
 *     growthExperimentsAnalyticsRouter,
 *   );
 *
 * Deliberately a SEPARATE route (and separate file name) from
 * site-analytics (siteAnalytics.ts) and growth-analytics
 * (growthAnalytics.ts) — neither of those is edited this round.
 */
export const growthExperimentsAnalyticsRouter = Router({ mergeParams: true });
growthExperimentsAnalyticsRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

const sinceDaysQuerySchema = z.coerce.number().int().min(1).max(3650).optional();

const funnelStepFilterSchema = z
  .object({
    path: z.string().trim().min(1).max(2048).optional(),
    propertyKey: z.string().trim().min(1).max(200).optional(),
    propertyEquals: z.string().trim().max(2000).optional(),
  })
  .optional();

const funnelStepSchema: z.ZodType<FunnelStepDef> = z.object({
  eventName: z.string().trim().min(1).max(200),
  filter: funnelStepFilterSchema,
});

const funnelBodySchema = z.object({
  steps: z.array(funnelStepSchema).min(1).max(10),
  sinceDays: z.number().int().min(1).max(3650).optional(),
});

const segmentRuleSchema: z.ZodType<SegmentRule> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event_count_at_least"),
    eventName: z.string().trim().min(1).max(200),
    minCount: z.number().int().min(1).max(1_000_000),
  }),
  z.object({
    type: z.literal("page_visited"),
    path: z.string().trim().min(1).max(2048),
  }),
  z.object({
    type: z.literal("utm_source"),
    value: z.string().trim().min(1).max(500),
  }),
]);

const segmentBodySchema = z.object({
  rules: z.array(segmentRuleSchema).max(20).default([]),
});

/** POST /advanced-analytics/funnel */
growthExperimentsAnalyticsRouter.post("/funnel", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const { steps, sinceDays } = funnelBodySchema.parse(req.body);
    const funnel = await computeFunnel(req.tenantDb!, req.tenantId!, projectId, steps, { sinceDays });
    res.json({ funnel });
  } catch (err) {
    next(err);
  }
});

/** GET /advanced-analytics/visitor-journey/:visitorId */
growthExperimentsAnalyticsRouter.get("/visitor-journey/:visitorId", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const visitorId = z.string().trim().min(1).max(100).parse(req.params.visitorId);
    const journey = await getVisitorJourney(req.tenantDb!, req.tenantId!, projectId, visitorId);
    res.json({ journey });
  } catch (err) {
    next(err);
  }
});

/** GET /advanced-analytics/cohort-retention?sinceDays=&maxWeekOffset= */
growthExperimentsAnalyticsRouter.get("/cohort-retention", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const sinceDays = sinceDaysQuerySchema.parse(
      typeof req.query.sinceDays === "string" ? req.query.sinceDays : undefined,
    );
    const maxWeekOffset = z.coerce
      .number()
      .int()
      .min(1)
      .max(52)
      .optional()
      .parse(typeof req.query.maxWeekOffset === "string" ? req.query.maxWeekOffset : undefined);

    const cohortTable = await computeCohortRetention(req.tenantDb!, req.tenantId!, projectId, "first_visit_week", {
      sinceDays,
      maxWeekOffset,
    });
    res.json({ cohortTable });
  } catch (err) {
    next(err);
  }
});

/** POST /advanced-analytics/segment */
growthExperimentsAnalyticsRouter.post("/segment", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const { rules } = segmentBodySchema.parse(req.body);
    const segment = await segmentVisitors(req.tenantDb!, req.tenantId!, projectId, rules);
    res.json({ segment });
  } catch (err) {
    next(err);
  }
});
