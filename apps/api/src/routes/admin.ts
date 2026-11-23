import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePlatformAdmin } from "../middleware/tenant.js";

/**
 * Platform-admin "root" routes — only reachable by a caller whose own email
 * is in env.PLATFORM_ADMIN_EMAILS (see middleware/tenant.ts's
 * requirePlatformAdmin and config/env.ts's doc comment). These are
 * deliberately read-only and genuinely cross-tenant: every other route in
 * this app is scoped to one :tenantId via requireTenantMembership, which
 * forces a per-request app.current_tenant_id context. These two instead
 * query `tenants`/`memberships`/`users` directly with no tenant_id filter —
 * safe only because neither of those tables carries a tenant-isolation RLS
 * policy keyed on "is this row's tenant the caller's own tenant" the way
 * tenant-owned data (leads, deals, campaigns, ...) does; `tenants` and
 * `users` are themselves the cross-tenant directory tables.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth, requirePlatformAdmin);

/** GET /api/v1/admin/tenants — every tenant on the platform, regardless of membership. */
adminRouter.get("/tenants", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.slug, t.name, t.industry, t.status, t.created_at,
              count(m.id)::int AS member_count
       FROM tenants t
       LEFT JOIN memberships m ON m.tenant_id = t.id AND m.status = 'active'
       GROUP BY t.id
       ORDER BY t.created_at DESC`,
    );
    res.json({ tenants: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/admin/users — every user on the platform, with every tenant they belong to. */
adminRouter.get("/users", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.status, u.last_login_at, u.created_at,
              coalesce(
                jsonb_agg(
                  jsonb_build_object('tenantId', t.id, 'tenantName', t.name, 'tenantSlug', t.slug, 'role', m.role)
                ) FILTER (WHERE m.id IS NOT NULL),
                '[]'::jsonb
              ) AS tenants
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
       LEFT JOIN tenants t ON t.id = m.tenant_id
       GROUP BY u.id
       ORDER BY u.created_at DESC`,
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/admin/tenants/:tenantId/users — every user (with role) in one specific tenant. */
adminRouter.get("/tenants/:tenantId/users", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.status, m.role, m.status AS membership_status, m.created_at AS joined_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.tenantId],
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});
