import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
import { enqueueWebsiteIntelligenceSnapshot } from "../lib/websiteIntelligenceQueue.js";
import { detectChanges } from "../lib/websiteChangeDetection.js";
import { analyzeContentGap, type SnapshotForGapAnalysis } from "../lib/contentGapAnalysis.js";

/**
 * Workstream E: deep website & competitor intelligence.
 *
 * NOT mounted yet — app.ts is off-limits this round (hot/modified by
 * another in-flight change — see `git status`). Mount this router
 * alongside the existing competitors/seo routers:
 *
 *   import { websiteIntelligenceRouter } from "./routes/websiteIntelligence.js";
 *   app.use(
 *     "/api/v1/tenants/:tenantId/projects/:projectId/website-intelligence",
 *     mainCors,
 *     websiteIntelligenceRouter,
 *   );
 *
 * (Insert it near line 237, right after the existing
 * `.../projectId/seo` mount — see apps/api/src/app.ts.)
 *
 * The actual Crawl4AI fetch + structured extraction is deliberately NOT
 * done synchronously in this route (crawling can be slow — see mission
 * brief) — POST /snapshots only writes a `queued` placeholder row's
 * worth of bookkeeping via the real BullMQ job
 * (apps/worker/src/jobs/websiteIntelligenceSnapshotJob.ts), which performs
 * the extraction and writes the real website_intelligence_snapshots row.
 */
export const websiteIntelligenceRouter = Router({ mergeParams: true });
websiteIntelligenceRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

const SNAPSHOT_TYPES = ["pricing", "product_catalog", "case_studies", "positioning"] as const;

const triggerSchema = z.object({
  targetUrl: z.string().trim().url(),
  snapshotType: z.enum(SNAPSHOT_TYPES),
});

/**
 * POST /snapshots — trigger a new structured-extraction snapshot. Queues a
 * real BullMQ job; the extraction itself happens asynchronously in
 * apps/worker. Returns 202 with nothing to poll yet but the queued
 * acknowledgement — GET /snapshots (below) is how a caller later finds the
 * resulting row.
 */
websiteIntelligenceRouter.post("/snapshots", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = triggerSchema.parse(req.body);

    try {
      await enqueueWebsiteIntelligenceSnapshot({
        tenantId: req.tenantId as string,
        projectId,
        targetUrl: body.targetUrl,
        snapshotType: body.snapshotType,
        requestedBy: req.userId as string,
      });
    } catch (err) {
      logger.error({ err, projectId, targetUrl: body.targetUrl }, "failed to enqueue website-intelligence snapshot");
      res.status(502).json({
        error: { code: "enqueue_failed", message: "Failed to enqueue website-intelligence snapshot job" },
      });
      return;
    }

    res.status(202).json({ status: "queued", targetUrl: body.targetUrl, snapshotType: body.snapshotType });
  } catch (err) {
    next(err);
  }
});

const listQuerySchema = z.object({
  targetUrl: z.string().trim().url().optional(),
  snapshotType: z.enum(SNAPSHOT_TYPES).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/** GET /snapshots — list snapshots for this project, optionally filtered. */
websiteIntelligenceRouter.get("/snapshots", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const query = listQuerySchema.parse(req.query);

    const conditions = ["tenant_id = $1", "project_id = $2"];
    const values: unknown[] = [req.tenantId, projectId];
    if (query.targetUrl) {
      values.push(query.targetUrl);
      conditions.push(`target_url = $${values.length}`);
    }
    if (query.snapshotType) {
      values.push(query.snapshotType);
      conditions.push(`snapshot_type = $${values.length}`);
    }
    values.push(query.limit ?? 50);

    const result = await req.tenantDb!.query(
      `SELECT * FROM website_intelligence_snapshots WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
    res.json({ snapshots: result.rows });
  } catch (err) {
    next(err);
  }
});

const changesQuerySchema = z.object({
  targetUrl: z.string().trim().url(),
  snapshotType: z.enum(SNAPSHOT_TYPES),
});

/** GET /changes — real content-hash-based change detection between the two latest snapshots of a target_url/type. */
websiteIntelligenceRouter.get("/changes", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const query = changesQuerySchema.parse(req.query);

    const changeResult = await detectChanges(
      req.tenantDb!,
      req.tenantId as string,
      projectId,
      query.targetUrl,
      query.snapshotType,
    );
    res.json(changeResult);
  } catch (err) {
    next(err);
  }
});

const gapQuerySchema = z.object({
  ourTargetUrl: z.string().trim().url(),
  competitorTargetUrl: z.string().trim().url(),
  snapshotType: z.enum(SNAPSHOT_TYPES),
});

async function loadLatestSnapshot(
  tenantDb: NonNullable<Request["tenantDb"]>,
  tenantId: string,
  projectId: string,
  targetUrl: string,
  snapshotType: string,
): Promise<SnapshotForGapAnalysis | null> {
  const result = await tenantDb.query(
    `SELECT extracted_data FROM website_intelligence_snapshots
     WHERE tenant_id = $1 AND project_id = $2 AND target_url = $3 AND snapshot_type = $4
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, projectId, targetUrl, snapshotType],
  );
  if (result.rowCount === 0) return null;
  return {
    snapshotType: snapshotType as SnapshotForGapAnalysis["snapshotType"],
    extractedData: result.rows[0].extracted_data,
  };
}

/**
 * GET /content-gap — compares our own latest snapshot for `ourTargetUrl`
 * against a competitor's latest snapshot for `competitorTargetUrl` (same
 * snapshotType) and returns real topics/features/products present in
 * theirs but absent from ours. Honestly reports `comparable: false` when
 * either side has no snapshot yet.
 */
websiteIntelligenceRouter.get("/content-gap", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const query = gapQuerySchema.parse(req.query);

    const [ourSnapshot, competitorSnapshot] = await Promise.all([
      loadLatestSnapshot(req.tenantDb!, req.tenantId as string, projectId, query.ourTargetUrl, query.snapshotType),
      loadLatestSnapshot(
        req.tenantDb!,
        req.tenantId as string,
        projectId,
        query.competitorTargetUrl,
        query.snapshotType,
      ),
    ]);

    res.json(analyzeContentGap(ourSnapshot, competitorSnapshot));
  } catch (err) {
    next(err);
  }
});
