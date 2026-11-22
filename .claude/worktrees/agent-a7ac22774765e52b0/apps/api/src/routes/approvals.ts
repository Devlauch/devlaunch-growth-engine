import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { requireRole, GTM_ROLES } from "../middleware/rbac.js";
import { Errors } from "../lib/httpError.js";

export const approvalsRouter = Router({ mergeParams: true });
approvalsRouter.use(requireAuth, requireTenantMembership);

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * GET /api/v1/tenants/:tenantId/approvals
 *
 * Human-in-the-loop queue: agent executions / actions that must be
 * reviewed before anything is sent (this is also where a lead captured
 * via the public widget gets qualified before any outreach — see
 * src/routes/publicLeads.ts, which only ever creates a `leads` row, never
 * an approval or outbound action by itself).
 */
approvalsRouter.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const result = await req.tenantDb!.query(
      `SELECT id, agent_execution_id, campaign_id, status, requested_by, reviewed_by, reason, decision_notes, requested_at, reviewed_at, expires_at
       FROM approvals
       WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY requested_at DESC
       LIMIT 100`,
      [req.tenantId, status ?? null],
    );
    res.json({ approvals: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tenants/:tenantId/approvals/:approvalId/decision
 *
 * Approving/rejecting is a go-to-market sign-off action, so it is
 * restricted to owner/admin/marketer — analyst/sales/viewer (and the
 * legacy 'member') can see the queue (GET above) but may not decide it.
 */
approvalsRouter.post("/:approvalId/decision", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const approvalId = z.string().uuid().parse(req.params.approvalId);
    const body = decisionSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE approvals
       SET status = $3, reviewed_by = $4, decision_notes = $5, reviewed_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
       RETURNING id, agent_execution_id, campaign_id, status, reviewed_by, decision_notes, reviewed_at`,
      [approvalId, req.tenantId, body.decision, req.userId, body.notes ?? null],
    );

    if (result.rowCount === 0) {
      throw Errors.notFound("Pending approval not found");
    }

    const approval = result.rows[0];

    // Generic approvals resolution: when this approval is for a campaign
    // (campaign_id set — see packages/db/migrations
    // 023_add_campaign_id_to_approvals.sql), flip the campaign itself to
    // approved/rejected in the same tenant-scoped transaction. This is the
    // only place a campaign ever leaves 'pending_approval' — there is no
    // separate/parallel campaign-approval mechanism.
    if (approval.campaign_id) {
      await req.tenantDb!.query(
        `UPDATE campaigns SET status = $3
         WHERE id = $1 AND tenant_id = $2 AND status = 'pending_approval'`,
        [approval.campaign_id, req.tenantId, body.decision],
      );
    }

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'approval.decided', 'approval', $3, $4::jsonb)`,
      [req.tenantId, req.userId, approvalId, JSON.stringify({ decision: body.decision, campaignId: approval.campaign_id ?? undefined })],
    );

    res.json({ approval });
  } catch (err) {
    next(err);
  }
});
