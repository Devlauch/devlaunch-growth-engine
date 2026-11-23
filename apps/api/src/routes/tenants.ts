import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTransaction, withUserContext } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { captureProductEvent } from "../lib/productAnalytics.js";

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

// A real 6-digit hex color, e.g. "#6d5cf0" — matches the CHECK constraint
// added in packages/db/migrations/210_add_branding_to_tenants.sql, so a bad
// value is rejected here before it ever reaches the DB.
const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "primaryColor must be a 6-digit hex color like #6d5cf0");

// subdomain is a plain requested-reference string only — see the migration
// comment and BrandingPage.tsx. No DNS/TLS/custom-domain provisioning
// happens anywhere for this value.
const subdomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "subdomain must be lowercase alphanumeric with single hyphens");

const patchBrandingSchema = z.object({
  industry: z.string().trim().max(200).nullable().optional(),
  goals: z.string().trim().max(5000).nullable().optional(),
  logoUrl: z.string().trim().url().max(2000).nullable().optional(),
  primaryColor: hexColorSchema.nullable().optional(),
  subdomain: subdomainSchema.nullable().optional(),
});

function requireOwnerOrAdmin(req: import("express").Request) {
  if (req.membershipRole !== "owner" && req.membershipRole !== "admin") {
    throw Errors.forbidden("Requires role: owner or admin");
  }
}

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

    // Internal product analytics: a real new tenant signup — see
    // productAnalytics.ts's doc comment (internal product-usage telemetry
    // only, unrelated to the tenant-facing site analytics feature).
    captureProductEvent("tenant_created", tenant.id, {
      slug: tenant.slug,
      industry: tenant.industry,
      createdByUserId: req.userId,
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
      `SELECT id, slug, name, industry, goals, logo_url, primary_color, subdomain, status, settings,
              created_at, updated_at
       FROM tenants WHERE id = $1`,
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

/**
 * PATCH /api/v1/tenants/:tenantId — update client-onboarding (industry/
 * goals) and white-label branding (logo/color/requested-subdomain) fields.
 * Owner/admin only, same role gate as membershipsRouter's mutating routes.
 *
 * Every field is nullable-and-optional so a field can be explicitly cleared
 * (sent as null) versus left unchanged (omitted) — same presence-flag
 * pattern as projects.ts's PATCH handler for its nullable widget-config
 * fields.
 *
 * subdomain is NEVER provisioned by this route or anywhere else in this
 * codebase — it is stored exactly as a "requested, not yet live" reference
 * string. No DNS record, TLS certificate, or routing rule is created.
 */
tenantsRouter.patch("/:tenantId", requireTenantMembership, async (req, res, next) => {
  try {
    requireOwnerOrAdmin(req);
    const body = patchBrandingSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      throw Errors.badRequest("At least one field is required");
    }

    const hasIndustry = Object.prototype.hasOwnProperty.call(body, "industry");
    const hasGoals = Object.prototype.hasOwnProperty.call(body, "goals");
    const hasLogoUrl = Object.prototype.hasOwnProperty.call(body, "logoUrl");
    const hasPrimaryColor = Object.prototype.hasOwnProperty.call(body, "primaryColor");
    const hasSubdomain = Object.prototype.hasOwnProperty.call(body, "subdomain");

    const result = await req.tenantDb!.query(
      `UPDATE tenants
       SET industry = CASE WHEN $2::boolean THEN $3 ELSE industry END,
           goals = CASE WHEN $4::boolean THEN $5 ELSE goals END,
           logo_url = CASE WHEN $6::boolean THEN $7 ELSE logo_url END,
           primary_color = CASE WHEN $8::boolean THEN $9 ELSE primary_color END,
           subdomain = CASE WHEN $10::boolean THEN $11 ELSE subdomain END
       WHERE id = $1
       RETURNING id, slug, name, industry, goals, logo_url, primary_color, subdomain, status, settings,
                 created_at, updated_at`,
      [
        req.tenantId,
        hasIndustry,
        body.industry ?? null,
        hasGoals,
        body.goals ?? null,
        hasLogoUrl,
        body.logoUrl ?? null,
        hasPrimaryColor,
        body.primaryColor ?? null,
        hasSubdomain,
        body.subdomain ?? null,
      ],
    );
    if (result.rowCount === 0) throw Errors.notFound("Tenant not found");

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, $3, 'tenant', $1, $4::jsonb)`,
      [req.tenantId, req.userId, "tenant.branding_updated", JSON.stringify(body)],
    );

    res.json({ tenant: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tenants/:tenantId/onboarding-completeness — a small
 * checklist computed strictly from real row existence (never a fabricated
 * percentage):
 *   - orgCreated:        always true once the tenant row itself exists
 *                        (requireTenantMembership already proved this).
 *   - brandingSet:       at least one of industry/goals/logo_url/
 *                        primary_color has actually been saved.
 *   - firstProjectCreated: this tenant owns at least one project row.
 *   - widgetEnabled:     at least one project has public_widget_enabled = true.
 */
tenantsRouter.get("/:tenantId/onboarding-completeness", requireTenantMembership, async (req, res, next) => {
  try {
    const tenantResult = await req.tenantDb!.query(
      "SELECT industry, goals, logo_url, primary_color FROM tenants WHERE id = $1",
      [req.tenantId],
    );
    if (tenantResult.rowCount === 0) throw Errors.notFound("Tenant not found");
    const t = tenantResult.rows[0];

    const projectStatsResult = await req.tenantDb!.query(
      `SELECT count(*)::int AS project_count,
              count(*) FILTER (WHERE public_widget_enabled = true)::int AS widget_enabled_count
       FROM projects WHERE tenant_id = $1`,
      [req.tenantId],
    );
    const stats = projectStatsResult.rows[0] as { project_count: number; widget_enabled_count: number };

    const brandingSet = Boolean(t.industry || t.goals || t.logo_url || t.primary_color);
    const firstProjectCreated = stats.project_count > 0;
    const widgetEnabled = stats.widget_enabled_count > 0;

    const checklist = [
      { key: "orgCreated", label: "Organization created", done: true },
      { key: "brandingSet", label: "Branding & profile set", done: brandingSet },
      { key: "firstProjectCreated", label: "First project created", done: firstProjectCreated },
      { key: "widgetEnabled", label: "Lead-capture widget enabled", done: widgetEnabled },
    ];
    const completedCount = checklist.filter((c) => c.done).length;

    res.json({ checklist, completedCount, totalCount: checklist.length });
  } catch (err) {
    next(err);
  }
});
