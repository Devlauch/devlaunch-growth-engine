import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { getContentAttribution } from "../lib/contentAttribution.js";
import { getChannelPerformance } from "../lib/channelComparison.js";

/**
 * contentAttributionRouter: mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/content-attribution
 * channelPerformanceRouter: mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/channel-performance
 * (same file, two sibling routers, same convention as routes/
 * campaignAttribution.ts mounting one router at one resource path — see
 * app.ts wiring notes below for the exact lines to add.)
 *
 * GET /content-attribution: real content-to-lead attribution over
 * content_calendar_items/content_drafts -> landing_pages (newly tagged via
 * landing_pages.content_calendar_item_id/content_draft_id,
 * 420_add_content_origin_to_landing_pages.sql) -> leads (via the
 * already-existing leads.custom_fields->>'landingPageId' identifier). See
 * apps/api/src/lib/contentAttribution.ts's doc comment for the full chain
 * and why this is Option A (a real, additive linkage) rather than a
 * not_yet_tracked stub.
 *
 * GET /channel-performance: per-channel rollup of the same real data
 * campaign_attribution already computes (276_create_campaign_attribution.sql),
 * grouped by campaigns.channel. See
 * apps/api/src/lib/channelComparison.ts's doc comment.
 *
 * NOTE: like routes/campaignAttribution.ts and routes/sequences.ts before
 * it, these routers are intentionally not wired into app.ts here (file
 * boundaries for this task excluded app.ts) — whoever integrates this
 * feature end-to-end should mount them the same way campaignAttributionRouter
 * is mounted. See this task's handback for the exact app.ts lines to add.
 */
export const contentAttributionRouter = Router({ mergeParams: true });
contentAttributionRouter.use(requireAuth, requireTenantMembership);

export const channelPerformanceRouter = Router({ mergeParams: true });
channelPerformanceRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

function parsePagination(req: import("express").Request): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/content-attribution */
contentAttributionRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);
    const { limit, offset } = parsePagination(req);

    const summary = await getContentAttribution(req.tenantDb!, req.tenantId!, projectId, { limit, offset });
    res.json({
      contentAttribution: summary.rows,
      untaggedContentCount: summary.untaggedContentCount,
      note: summary.note,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/channel-performance */
channelPerformanceRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const channelPerformance = await getChannelPerformance(req.tenantDb!, req.tenantId!, projectId);
    res.json({ channelPerformance });
  } catch (err) {
    next(err);
  }
});
