import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { getLeadActivityTimeline } from "../lib/activityTimeline.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/activity
 *
 * Deliberately a SEPARATE route file (not added to routes/leads.ts) to
 * avoid colliding with concurrent edits to that file from other
 * in-progress work. See apps/api/src/lib/activityTimeline.ts for the real
 * aggregation query this just exposes over HTTP.
 */
export const leadActivityRouter = Router({ mergeParams: true });
leadActivityRouter.use(requireAuth, requireTenantMembership);

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

async function assertLeadInProject(req: Request, projectId: string, leadId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
    leadId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Lead not found");
}

/** GET /leads/:leadId/activity — unified, chronological activity timeline for a lead */
leadActivityRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await assertLeadInProject(req, projectId, leadId);

    const items = await getLeadActivityTimeline(req.tenantDb!, req.tenantId!, projectId, leadId);
    res.json({ activity: items });
  } catch (err) {
    next(err);
  }
});
