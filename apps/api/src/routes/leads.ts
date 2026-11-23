import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/leads
 *
 * Read-only list for the dashboard's "Lead capture widget" settings
 * screen, so a tenant admin can see that the public embed widget (or any
 * other lead source) is actually landing rows — without fabricating any
 * numbers when there are none yet (see leads table's `source` check
 * constraint in packages/db/migrations/015_create_leads.sql for the
 * possible source values).
 */
export const leadsRouter = Router({ mergeParams: true });
leadsRouter.use(requireAuth, requireTenantMembership);

leadsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);

    const project = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
      projectId,
      req.tenantId,
    ]);
    if (project.rowCount === 0) throw Errors.notFound("Project not found");

    const result = await req.tenantDb!.query(
      `SELECT id, name, email, company, message, source, status, created_at
       FROM leads
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.tenantId, projectId],
    );
    res.json({ leads: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:id — single lead detail, for the lead-detail dashboard page (shows
 * core fields plus embeds the activity timeline / notes panel, which fetch
 * their own data separately). Same tenant/project scoping as the list route
 * above.
 */
leadsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const leadId = z.string().uuid().parse((req.params as Record<string, string>).id);

    const project = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
      projectId,
      req.tenantId,
    ]);
    if (project.rowCount === 0) throw Errors.notFound("Project not found");

    const result = await req.tenantDb!.query(
      `SELECT id, name, email, company, message, source, status, created_at
       FROM leads
       WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [leadId, req.tenantId, projectId],
    );
    if (result.rowCount === 0) throw Errors.notFound("Lead not found");

    res.json({ lead: result.rows[0] });
  } catch (err) {
    next(err);
  }
});
