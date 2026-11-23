import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { assignLead, getCurrentAssignment, getAssignmentHistory } from "../lib/leadAssignment.js";

/**
 * Mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/assignments
 *
 * Phase 2 (Section B, "assign leads to sales representatives"): a thin
 * route wrapper around the already-built apps/api/src/lib/leadAssignment.ts
 * (assignLead/getCurrentAssignment/getAssignmentHistory) — this file adds no
 * new assignment logic of its own, it only exposes that lib over HTTP with
 * the standard tenant/project scoping every other route here uses.
 */
export const leadAssignmentsRouter = Router({ mergeParams: true });
leadAssignmentsRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertLeadInProject(req: Request, projectId: string, leadId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
    leadId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Lead not found in this project");
}

const assignSchema = z.object({
  assignedUserId: z.string().uuid(),
});

/** POST .../leads/:leadId/assignments — assign or reassign this lead. */
leadAssignmentsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertLeadInProject(req, projectId, leadId);
    const body = assignSchema.parse(req.body);

    const assignment = await assignLead(req.tenantDb!, {
      tenantId: req.tenantId!,
      projectId,
      leadId,
      assignedUserId: body.assignedUserId,
      assignedBy: req.userId ?? null,
    });

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'lead.assigned', 'lead', $3, $4::jsonb)`,
      [req.tenantId, req.userId, leadId, JSON.stringify({ assignedUserId: body.assignedUserId })],
    );

    res.status(201).json({ assignment });
  } catch (err) {
    next(err);
  }
});

/** GET .../leads/:leadId/assignments/current — who this lead is assigned to right now (or null). */
leadAssignmentsRouter.get("/current", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertLeadInProject(req, projectId, leadId);

    const assignment = await getCurrentAssignment(req.tenantDb!, leadId);
    res.json({ assignment });
  } catch (err) {
    next(err);
  }
});

/** GET .../leads/:leadId/assignments/history — full reassignment history, most recent first. */
leadAssignmentsRouter.get("/history", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertLeadInProject(req, projectId, leadId);

    const history = await getAssignmentHistory(req.tenantDb!, leadId);
    res.json({ assignments: history });
  } catch (err) {
    next(err);
  }
});
