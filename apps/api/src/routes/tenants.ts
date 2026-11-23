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

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric with single hyphens");

// Words that would collide with real routes/paths if used as a tenant slug
// (subdomain-style routing isn't live yet — see tenants.ts's subdomainSchema
// comment — but slugs are still user-facing identifiers and these are
// reserved defensively either way).
const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "login",
  "logout",
  "register",
  "dashboard",
  "onboarding",
  "auth",
  "www",
  "app",
  "static",
  "assets",
  "public",
  "health",
  "tenants",
  "projects",
  "settings",
  "billing",
  "organizations",
]);

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

// Create-organization request: slug is optional (auto-derived from `name`
// when omitted — the onboarding page always omits it and lets the server
// decide, showing the user a live client-side preview only).
const createTenantSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(200).optional(),
  // Optional — becomes the auto-created first project's project_profiles.website_url.
  websiteUrl: z.string().trim().url().max(2000).optional(),
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
  if (req.isPlatformAdmin) return;
  if (req.membershipRole !== "owner" && req.membershipRole !== "admin") {
    throw Errors.forbidden("Requires role: owner or admin");
  }
}

const OWNER_LIMIT_CONSTRAINT = "memberships_one_owned_tenant_per_user";
const SLUG_UNIQUE_CONSTRAINT = "tenants_slug_key";

function pgErrorConstraint(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
    return (err as { constraint?: string }).constraint;
  }
  return undefined;
}

/**
 * POST /api/v1/tenants — create an organization and make the caller its
 * owner, plus a first project ("Main website") in the same transaction.
 *
 * One-owned-organization-per-user rule: a user may own at most one
 * organization (they may still be invited into others as a non-owner
 * member — see docs/DECISIONS.md). Enforced two ways:
 *   1. A fast pre-check here, for a clean error message on the common
 *      case (no retry/race involved).
 *   2. The real source of truth: packages/db/migrations/
 *      649_limit_one_owned_tenant_per_user.sql's partial unique index on
 *      memberships(user_id) WHERE role='owner'. If two requests from the
 *      same user race each other, Postgres allows only one owner-
 *      membership INSERT to succeed; the loser's unique_violation (error
 *      code 23505, constraint name memberships_one_owned_tenant_per_user)
 *      is caught below and mapped to the same 409.
 *
 * Slug collision handling: there is deliberately NO pre-check SELECT
 * against `tenants` for slug availability. `tenants` carries RLS (see
 * packages/db/migrations 013/017's tenants_isolation policy: a row is only
 * visible when its id equals the CALLER'S OWN app.current_tenant_id, or is
 * one of the caller's existing memberships) — since this is a brand-new
 * tenantId no row has yet, and a user with zero memberships has no rows
 * either way, such a SELECT can structurally never see any OTHER tenant's
 * slug and would always report "available" even when it collides. (This
 * was discovered live, via a real end-to-end smoke test against this
 * project's own dev database, not just reasoned about — see
 * docs/DECISIONS.md D6.) Instead, the actual `INSERT INTO tenants` is the
 * source of truth: its real `tenants_slug_key` unique constraint is what
 * catches a collision, and the loop below retries with the next numeric
 * suffix when that specific constraint (and only that one) is violated.
 */
tenantsRouter.post("/", async (req, res, next) => {
  try {
    const body = createTenantSchema.parse(req.body);
    const userId = req.userId as string;

    let baseSlug = body.slug ? body.slug.toLowerCase() : slugify(body.name);
    if (body.slug && RESERVED_SLUGS.has(baseSlug)) {
      throw Errors.badRequest(`"${baseSlug}" is a reserved word and can't be used as a slug`);
    }
    if (!baseSlug) baseSlug = "org";
    if (RESERVED_SLUGS.has(baseSlug)) baseSlug = `${baseSlug}-co`;

    let result: { tenant: Record<string, unknown>; project: Record<string, unknown> } | undefined;
    let attemptSlug = baseSlug;

    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const tenantId = randomUUID();
      try {
        result = await withTransaction(async (client) => {
          // New tenant: no membership exists yet to check, so this is the
          // one place a tenantId is "trusted" directly — but only as a
          // brand-new id we just generated ourselves, and the insert
          // immediately creates the owner membership for the authenticated
          // caller in the same transaction, under the same RLS context.
          await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

          const existingOwned = await client.query(
            `SELECT 1 FROM memberships WHERE user_id = $1 AND role = 'owner' AND status = 'active' LIMIT 1`,
            [userId],
          );
          if ((existingOwned.rowCount ?? 0) > 0) {
            throw Errors.conflict(
              "You already own an organization — you can still be invited into others, but each account can only create/own one.",
            );
          }

          const insertedTenant = await client.query(
            `INSERT INTO tenants (id, slug, name, industry) VALUES ($1, $2, $3, $4)
             RETURNING id, slug, name, industry, status, created_at`,
            [tenantId, attemptSlug, body.name, body.industry ?? null],
          );

          await client.query(
            `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
            [tenantId, userId],
          );

          const projectId = randomUUID();
          const insertedProject = await client.query(
            `INSERT INTO projects (id, tenant_id, name, slug, created_by)
             VALUES ($1, $2, 'Main website', 'main-website', $3)
             RETURNING id, tenant_id, name, slug, status, created_at`,
            [projectId, tenantId, userId],
          );

          if (body.websiteUrl) {
            await client.query(
              `INSERT INTO project_profiles (tenant_id, project_id, company_name, website_url)
               VALUES ($1, $2, $3, $4)`,
              [tenantId, projectId, body.name, body.websiteUrl],
            );
          }

          await client.query(
            `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
             VALUES ($1, 'user', $2, 'tenant.created', 'tenant', $1, '{}'::jsonb)`,
            [tenantId, userId],
          );

          return { tenant: insertedTenant.rows[0], project: insertedProject.rows[0] };
        });
        break; // success
      } catch (err) {
        const constraint = pgErrorConstraint(err);
        if (constraint === OWNER_LIMIT_CONSTRAINT) {
          // The race-condition case the pre-check above can't fully close.
          throw Errors.conflict(
            "You already own an organization — you can still be invited into others, but each account can only create/own one.",
          );
        }
        if (constraint === SLUG_UNIQUE_CONSTRAINT) {
          if (attempt === 50) throw Errors.conflict("Could not find an available slug — please choose a different name");
          attemptSlug = `${baseSlug}-${attempt + 1}`;
          continue;
        }
        throw err; // our own thrown HttpErrors (owner pre-check, validation) and anything else
      }
    }

    const final = result as { tenant: Record<string, unknown>; project: Record<string, unknown> };

    // Internal product analytics: a real new tenant signup — see
    // productAnalytics.ts's doc comment (internal product-usage telemetry
    // only, unrelated to the tenant-facing site analytics feature).
    captureProductEvent("tenant_created", final.tenant.id as string, {
      slug: final.tenant.slug,
      industry: final.tenant.industry,
      createdByUserId: userId,
    });

    res.status(201).json({ tenant: final.tenant, project: final.project });
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
