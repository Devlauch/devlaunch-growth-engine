import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTransaction, withUserContext } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

export const tenantsRouter = Router();
tenantsRouter.use(requireAuth);

const createTenantSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric with single hyphens"),
  name: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(200).optional(),
});

/** POST /api/v1/tenants — create a tenant and make the caller its owner. */
tenantsRouter.post("/", async (req, res, next) => {
  try {
    const body = createTenantSchema.parse(req.body);
    const tenantId = randomUUID();

    const tenant = await withTransaction(async (client) => {
      // New tenant: no membership exists yet to check, so this is the one
      // place a tenantId is "trusted" directly — but only as a brand-new
      // id we just generated ourselves, and the insert immediately creates
      // the owner membership for the authenticated caller in the same
      // transaction, under the same RLS context.
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      const existingSlug = await client.query("SELECT 1 FROM tenants WHERE slug = $1", [body.slug]);
      if ((existingSlug.rowCount ?? 0) > 0) {
        throw Errors.conflict("A tenant with this slug already exists");
      }

      const inserted = await client.query(
        `INSERT INTO tenants (id, slug, name, industry) VALUES ($1, $2, $3, $4)
         RETURNING id, slug, name, industry, status, created_at`,
        [tenantId, body.slug, body.name, body.industry ?? null],
      );

      await client.query(
        `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
        [tenantId, req.userId],
      );

      await client.query(
        `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'user', $2, 'tenant.created', 'tenant', $1, '{}'::jsonb)`,
        [tenantId, req.userId],
      );

      return inserted.rows[0];
    });

    res.status(201).json({ tenant });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants — list tenants the caller belongs to. */
tenantsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withUserContext(req.userId as string, async (client) => {
      const result = await client.query(
        `SELECT t.id, t.slug, t.name, t.industry, t.status, m.role
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND m.status = 'active'
         ORDER BY t.created_at ASC`,
        [req.userId],
      );
      return result.rows;
    });
    res.json({ tenants: rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId — membership-gated. */
tenantsRouter.get("/:tenantId", requireTenantMembership, async (req, res, next) => {
  try {
    const result = await req.tenantDb!.query(
      "SELECT id, slug, name, industry, status, settings, created_at, updated_at FROM tenants WHERE id = $1",
      [req.tenantId],
    );
    if (result.rowCount === 0) {
      throw Errors.notFound("Tenant not found");
    }
    res.json({ tenant: result.rows[0], role: req.membershipRole });
  } catch (err) {
    next(err);
  }
});
