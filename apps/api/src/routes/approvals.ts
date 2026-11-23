import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { requireRole, GTM_ROLES } from "../middleware/rbac.js";
import { Errors } from "../lib/httpError.js";
import { notify } from "../lib/notify.js";
import { autoAssignLeadRoundRobin } from "../lib/leadPromotion.js";

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
       RETURNING id, agent_execution_id, campaign_id, growth_advisor_action_id, status, requested_by, reviewed_by, decision_notes, reviewed_at,
         (SELECT c.project_id FROM campaigns c WHERE c.id = campaign_id) AS campaign_project_id`,
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

    // AI Growth Advisor's one approval-gated action: a prepared
    // 'auto_assign_leads' growth_advisor_actions row. This is the only
    // place that action is ever actually executed — never by the
    // prepare-action endpoint itself (see routes/growthAdvisor.ts). Rejected
    // just flips the action's status; approved re-runs the real, unchanged
    // autoAssignLeadRoundRobin (lib/leadPromotion.ts) for each lead id the
    // action recorded, and records exactly what happened per lead — never a
    // fabricated "done".
    if (approval.growth_advisor_action_id) {
      const actionResult = await req.tenantDb!.query(
        `SELECT id, tenant_id, project_id, recommendation_id, action_type, payload, status
         FROM growth_advisor_actions WHERE id = $1 AND tenant_id = $2 AND status = 'pending_approval'`,
        [approval.growth_advisor_action_id, req.tenantId],
      );
      const action = actionResult.rows[0];
      if (action) {
        if (body.decision === "approved") {
          const leadIds: string[] = Array.isArray(action.payload?.leadIds) ? action.payload.leadIds : [];
          const results: Array<{ leadId: string; created: boolean; skippedReason?: string }> = [];
          for (const leadId of leadIds) {
            const assignment = await autoAssignLeadRoundRobin(
              req.tenantDb!,
              req.tenantId as string,
              action.project_id,
              leadId,
              req.userId as string,
            );
            results.push({ leadId, created: assignment.created, skippedReason: assignment.skippedReason });
          }
          await req.tenantDb!.query(
            `UPDATE growth_advisor_actions SET status = 'approved', result = $2::jsonb WHERE id = $1`,
            [action.id, JSON.stringify({ results })],
          );
        } else {
          await req.tenantDb!.query(`UPDATE growth_advisor_actions SET status = 'rejected' WHERE id = $1`, [action.id]);
        }
      }
    }

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'approval.decided', 'approval', $3, $4::jsonb)`,
      [req.tenantId, req.userId, approvalId, JSON.stringify({ decision: body.decision, campaignId: approval.campaign_id ?? undefined })],
    );

    // Real in-app notification: tell the original requester their approval
    // was decided — never email/WhatsApp (see src/lib/notify.ts). Skip
    // notifying someone of their own decision on their own request.
    if (approval.requested_by && approval.requested_by !== req.userId) {
      await notify({
        client: req.tenantDb!,
        tenantId: req.tenantId!,
        userId: approval.requested_by,
        type: "approval.decided",
        title: body.decision === "approved" ? "Your request was approved" : "Your request was rejected",
        body: approval.campaign_id
          ? `Your campaign approval request was ${body.decision}.`
          : `Your approval request was ${body.decision}.`,
        linkUrl:
          approval.campaign_id && approval.campaign_project_id
            ? `/tenants/${req.tenantId}/projects/${approval.campaign_project_id}/campaigns/${approval.campaign_id}`
            : null,
      });
    }

    res.json({ approval });
  } catch (err) {
    next(err);
  }
});
