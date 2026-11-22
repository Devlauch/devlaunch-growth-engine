import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

export const membershipsRouter = Router({ mergeParams: true });
membershipsRouter.use(requireAuth, requireTenantMembership);

const roles = ["owner", "admin", "member", "viewer"] as const;

const createMembershipSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(roles).default("member"),
});

const patchMembershipSchema = z.object({
  role: z.enum(roles).optional(),
  status: z.enum(["active", "invited", "revoked"]).optional(),
});

function requireRole(req: import("express").Request, allowed: readonly string[]) {
  if (!req.membershipRole || !allowed.includes(req.membershipRole)) {
    throw Errors.forbidden(`Requires one of role: ${allowed.join(", ")}`);
  }
}

/** POST /api/v1/tenants/:tenantId/memberships — add a member (owner/admin only). */
membershipsRouter.post("/", async (req, res, next) => {
  try {
    requireRole(req, ["owner", "admin"]);
    const body = createMembershipSchema.parse(req.body);

    const userExists = await req.tenantDb!.query("SELECT id FROM users WHERE id = $1", [body.userId]);
    if (userExists.rowCount === 0) {
      throw Errors.notFound("User not found");
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status, invited_by)
       VALUES ($1, $2, $3, 'invited', $4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, tenant_id, user_id, role, status, created_at`,
      [req.tenantId, body.userId, body.role, req.userId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'membership.created', 'membership', $3, $4::jsonb)`,
      [req.tenantId, req.userId, result.rows[0].id, JSON.stringify({ invitedUserId: body.userId, role: body.role })],
    );

    res.status(201).json({ membership: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/memberships */
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

/** PATCH /api/v1/tenants/:tenantId/memberships/:membershipId — owner/admin only. */
membershipsRouter.patch("/:membershipId", async (req, res, next) => {
  try {
    requireRole(req, ["owner", "admin"]);
    const membershipId = z.string().uuid().parse(req.params.membershipId);
    const body = patchMembershipSchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      throw Errors.badRequest("At least one of role/status is required");
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
