import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { buildMeetingPrepBrief } from "../lib/meetingPrep.js";
import { getObjectionInsights } from "../lib/objectionInsights.js";

/**
 * Two small, independent routers, kept in one file (deliberately NOT added
 * to routes/meetings.ts or routes/replies.ts — both may be under
 * concurrent edit from other in-progress work):
 *
 *   - meetingPrepRouter: mounted at
 *     /api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/meetings/:meetingId/prep
 *     Exposes meetingPrep.ts's buildMeetingPrepBrief over HTTP.
 *
 *   - objectionInsightsRouter: mounted at
 *     /api/v1/tenants/:tenantId/projects/:projectId/objection-insights
 *     Exposes objectionInsights.ts's getObjectionInsights over HTTP.
 */

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

export const meetingPrepRouter = Router({ mergeParams: true });
meetingPrepRouter.use(requireAuth, requireTenantMembership);

/** GET /leads/:leadId/meetings/:meetingId/prep — full data-backed meeting prep brief */
meetingPrepRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    const meetingId = paramId(req, "meetingId");
    await assertProjectInTenant(req, projectId);
    await assertLeadInProject(req, projectId, leadId);

    const brief = await buildMeetingPrepBrief(req.tenantDb!, req.tenantId!, projectId, leadId, meetingId);
    res.json({ brief });
  } catch (err) {
    next(err);
  }
});

export const objectionInsightsRouter = Router({ mergeParams: true });
objectionInsightsRouter.use(requireAuth, requireTenantMembership);

const objectionInsightsQuerySchema = z.object({
  lookbackDays: z.coerce.number().int().min(1).max(3650).optional(),
});

/** GET /objection-insights — real counts/trend of objection-flavored reply signal, project-scoped */
objectionInsightsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const query = objectionInsightsQuerySchema.parse(req.query);

    const insights = await getObjectionInsights(
      req.tenantDb!,
      req.tenantId!,
      projectId,
      query.lookbackDays ?? 90,
    );
    res.json({ insights });
  } catch (err) {
    next(err);
  }
});
