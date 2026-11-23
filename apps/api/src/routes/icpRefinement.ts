import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { computeIcpConversionPerformance, buildIcpRefinementSummary } from "../lib/icpRefinement.js";

/**
 * ICP refinement feedback loop (Phase 4 business intelligence — "ICP
 * refinement" half of the backlog item; see ../lib/icpRefinement.ts for the
 * real-data aggregation this exposes, and routes/growthAnalyzer.ts /
 * routes/icpProfiles.ts for the one-shot suggestion + acceptance flow this
 * complements but does not replace).
 *
 * Intended mount point (app.ts is off-limits this round — mount this router
 * there alongside routes/icpProfiles.ts):
 *   /api/v1/tenants/:tenantId/projects/:projectId/icp-refinement
 *
 * - GET /: real conversion-rate-by-ICP-segment for every icp_profiles row in
 *   the project, computed fresh from icp_match_scores + leads + deals (no
 *   stored/cached number), plus one overall templated summary string.
 */
export const icpRefinementRouter = Router({ mergeParams: true });
icpRefinementRouter.use(requireAuth, requireTenantMembership);

async function assertProjectInTenant(req: import("express").Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/icp-refinement */
icpRefinementRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);

    const performances = await computeIcpConversionPerformance(req.tenantDb!, req.tenantId!, projectId);
    const summary = buildIcpRefinementSummary(performances);

    res.json({ icpProfilePerformance: performances, summary });
  } catch (err) {
    next(err);
  }
});
