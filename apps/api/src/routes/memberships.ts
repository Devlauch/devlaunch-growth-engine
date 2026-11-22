import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { requireRole, ROLES } from "../middleware/rbac.js";
import { Errors } from "../lib/httpError.js";

export const membershipsRouter = Router({ mergeParams: true });
membershipsRouter.use(requireAuth, requireTenantMembership);

// 'member' is kept accepted on PATCH only so an existing pre-spec row can
// still be read/patched (e.g. status changes) without being forced to pick
// a new role in the same request; it is not offered as an invite role.
const patchableRoles = [...ROLES, "member"] as const;

const inviteMembershipSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(ROLES).default("viewer"),
});

const patchMembershipSchema = z.object({
  role: z.enum(patchableRoles).optional(),
  status: z.enum(["active", "invited", "revoked"]).optional(),
});

/**
 * POST /api/v1/tenants/:tenantId/memberships — invite an existing user (by
 * email) into this tenant with a specific role. Owner/admin only.
 *
 * This only attaches a *real* users row to this tenant — it never
 * fabricates a user account for an email with no existing registration
 * (there is no invite-email-delivery infra in this phase to safely create
 * one), so an email with no matching account is a 404, not a silent
 * placeholder user.
 */
membershipsRouter.post("/", requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const body = inviteMembershipSchema.parse(req.body);

    const user = await req.tenantDb!.query("SELECT id FROM users WHERE email = $1", [body.email]);
    if (user.rowCount === 0) {
      throw Errors.notFound("No user with this email has registered yet");
    }
    const userId = user.rows[0].id;

    const result = await req.tenantDb!.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status, invited_by)
       VALUES ($1, $2, $3, 'invited', $4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, tenant_id, user_id, role, status, created_at`,
      [req.tenantId, userId, body.role, req.userId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'membership.created', 'membership', $3, $4::jsonb)`,
      [req.tenantId, req.userId, result.rows[0].id, JSON.stringify({ invitedEmail: body.email, role: body.role })],
    );

    res.status(201).json({ membership: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/memberships — any active member may view the roster. */
membershipsRouter.get("/", async (req, res, next) => {
  try {
    const result = await req.tenantDb!.query(
      `SELECT m.id, m.user_id, m.role, m.status, m.created_at, u.email, u.full_name
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1
       ORDER BY m.created_at ASC`,
      [req.tenantId],
    );
    res.json({ memberships: result.rows });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/tenants/:tenantId/memberships/:membershipId — change role/status. Owner/admin only. */
membershipsRouter.patch("/:membershipId", requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const membershipId = z.string().uuid().parse(req.params.membershipId);
    const body = patchMembershipSchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      throw Errors.badRequest("At least one of role/status is required");
    }

    if (body.role && body.role !== "owner") {
      await assertNotLastActiveOwner(req, membershipId, "This is the tenant's only owner — promote another owner before changing this role");
    }
    if (body.status && body.status !== "active") {
      await assertNotLastActiveOwner(req, membershipId, "This is the tenant's only owner — promote another owner before changing this membership's status");
    }

    const result = await req.tenantDb!.query(
      `UPDATE memberships
       SET role = COALESCE($3, role), status = COALESCE($4, status)
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, user_id, role, status, updated_at`,
      [membershipId, req.tenantId, body.role ?? null, body.status ?? null],
    );

    if (result.rowCount === 0) {
      throw Errors.notFound("Membership not found");
    }

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'membership.updated', 'membership', $3, $4::jsonb)`,
      [req.tenantId, req.userId, membershipId, JSON.stringify(body)],
    );

    res.json({ membership: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/tenants/:tenantId/memberships/:membershipId — remove a
 * member from this tenant. Owner/admin only.
 */
membershipsRouter.delete("/:membershipId", requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const membershipId = z.string().uuid().parse(req.params.membershipId);

    await assertNotLastActiveOwner(req, membershipId, "This is the tenant's only owner — promote another owner before removing this membership");

    const result = await req.tenantDb!.query(
      `DELETE FROM memberships WHERE id = $1 AND tenant_id = $2 RETURNING id, user_id, role`,
      [membershipId, req.tenantId],
    );

    if (result.rowCount === 0) {
      throw Errors.notFound("Membership not found");
    }

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'membership.removed', 'membership', $3, $4::jsonb)`,
      [req.tenantId, req.userId, membershipId, JSON.stringify({ removedUserId: result.rows[0].user_id })],
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * Guards against a tenant being left with zero active owners (an
 * unrecoverable lockout, since only an owner/admin can grant the owner
 * role back): throws a conflict if `membershipId` is currently the
 * tenant's only active owner.
 */
async function assertNotLastActiveOwner(
  req: import("express").Request,
  membershipId: string,
  message: string,
): Promise<void> {
  const target = await req.tenantDb!.query(
    `SELECT role, status FROM memberships WHERE id = $1 AND tenant_id = $2`,
    [membershipId, req.tenantId],
  );
  if (target.rowCount === 0 || target.rows[0].role !== "owner" || target.rows[0].status !== "active") {
    return;
  }

  const otherActiveOwners = await req.tenantDb!.query(
    `SELECT 1 FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active' AND id != $2`,
    [req.tenantId, membershipId],
  );
  if (otherActiveOwners.rowCount === 0) {
    throw Errors.conflict(message);
  }
}
