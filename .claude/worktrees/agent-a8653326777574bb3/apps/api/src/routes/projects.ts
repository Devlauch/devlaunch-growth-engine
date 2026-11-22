import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

export const projectsRouter = Router({ mergeParams: true });
projectsRouter.use(requireAuth, requireTenantMembership);

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  description: z.string().trim().max(2000).optional(),
});

// An absolute origin: scheme://host[:port], no path/query/fragment/trailing
// slash. Deliberately stricter than the WHATWG URL parser (which would
// normalize/accept things like a trailing slash) since these are compared
// byte-for-byte against the browser's Origin header in publicLeads.ts.
const originSchema = z
  .string()
  .trim()
  .max(500)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/?#]+$/,
    "Each origin must be an absolute origin like https://example.com (no path)",
  );

const patchProjectSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  publicWidgetEnabled: z.boolean().optional(),
  allowedOrigins: z.array(originSchema).max(20).optional(),
  // Roadmap item 6 ("Inbound lead capture") widget config. Nullable (not
  // just optional) so a tenant admin can explicitly clear a previously-set
  // question/link/message back to "none" / the default, not just leave it
  // unchanged by omitting the field.
  widgetQualifyingQuestion: z.string().trim().max(500).nullable().optional(),
  widgetBookingLinkUrl: z.string().trim().max(500).nullable().optional(),
  widgetThankYouMessage: z.string().trim().max(2000).nullable().optional(),
});

/** POST /api/v1/tenants/:tenantId/projects */
projectsRouter.post("/", async (req, res, next) => {
  try {
    const body = createProjectSchema.parse(req.body);
    const publicApiKey = `pk_${randomBytes(24).toString("hex")}`;

    const existing = await req.tenantDb!.query(
      "SELECT 1 FROM projects WHERE tenant_id = $1 AND slug = $2",
      [req.tenantId, body.slug],
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw Errors.conflict("A project with this slug already exists in this tenant");
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO projects (tenant_id, name, slug, description, created_by, public_api_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, name, slug, description, status, public_api_key, allowed_origins, public_widget_enabled, created_at`,
      [req.tenantId, body.name, body.slug, body.description ?? null, req.userId, publicApiKey],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'project.created', 'project', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, result.rows[0].id],
    );

    res.status(201).json({ project: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects */
projectsRouter.get("/", async (req, res, next) => {
  try {
    const result = await req.tenantDb!.query(
      `SELECT id, tenant_id, name, slug, description, status, created_at
       FROM projects WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [req.tenantId],
    );
    res.json({ projects: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId */
projectsRouter.get("/:projectId", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const result = await req.tenantDb!.query(
      `SELECT id, tenant_id, name, slug, description, status, public_api_key, allowed_origins, public_widget_enabled,
              widget_qualifying_question, widget_booking_link_url, widget_thank_you_message, created_at, updated_at
       FROM projects WHERE id = $1 AND tenant_id = $2`,
      [projectId, req.tenantId],
    );
    if (result.rowCount === 0) throw Errors.notFound("Project not found");
    res.json({ project: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tenants/:tenantId/projects/:projectId/utm-sample-leads
 *
 * Roadmap item 6 ("Inbound lead capture"): read-only sample of leads that
 * actually carry UTM tracking data, so a tenant admin configuring the
 * widget (see apps/dashboard/src/pages/WidgetSettingsPage.tsx) can confirm
 * UTM/source tracking is really landing rows, without fabricating any
 * example data when there are none yet. Mirrors the tenant-isolated
 * read-only pattern in src/routes/leads.ts, scoped additionally to
 * utm_source IS NOT NULL.
 */
projectsRouter.get("/:projectId/utm-sample-leads", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);

    const project = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
      projectId,
      req.tenantId,
    ]);
    if (project.rowCount === 0) throw Errors.notFound("Project not found");

    const result = await req.tenantDb!.query(
      `SELECT id, name, email, source, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
              referrer_url, qualifying_answer, created_at
       FROM leads
       WHERE tenant_id = $1 AND project_id = $2 AND utm_source IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.tenantId, projectId],
    );
    res.json({ leads: result.rows });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/tenants/:tenantId/projects/:projectId */
projectsRouter.patch("/:projectId", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const body = patchProjectSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      throw Errors.badRequest("At least one field is required");
    }

    // The three widget-config fields are nullable (clearable), so a plain
    // COALESCE($n, column) pattern — which treats a supplied null the same
    // as "field omitted" — can't express "set this back to null". Instead
    // each gets a presence flag ($n::boolean) alongside its value, and the
    // CASE only overwrites the column when the field was actually present
    // in the request body.
    const hasWidgetQualifyingQuestion = Object.prototype.hasOwnProperty.call(body, "widgetQualifyingQuestion");
    const hasWidgetBookingLinkUrl = Object.prototype.hasOwnProperty.call(body, "widgetBookingLinkUrl");
    const hasWidgetThankYouMessage = Object.prototype.hasOwnProperty.call(body, "widgetThankYouMessage");

    const result = await req.tenantDb!.query(
      `UPDATE projects
       SET name = COALESCE($3, name),
           description = COALESCE($4, description),
           status = COALESCE($5, status),
           public_widget_enabled = COALESCE($6, public_widget_enabled),
           allowed_origins = COALESCE($7, allowed_origins),
           widget_qualifying_question = CASE WHEN $8::boolean THEN $9 ELSE widget_qualifying_question END,
           widget_booking_link_url = CASE WHEN $10::boolean THEN $11 ELSE widget_booking_link_url END,
           widget_thank_you_message = CASE WHEN $12::boolean THEN $13 ELSE widget_thank_you_message END
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, name, slug, description, status, public_api_key, allowed_origins, public_widget_enabled,
                 widget_qualifying_question, widget_booking_link_url, widget_thank_you_message, updated_at`,
      [
        projectId,
        req.tenantId,
        body.name ?? null,
        body.description ?? null,
        body.status ?? null,
        body.publicWidgetEnabled ?? null,
        body.allowedOrigins ?? null,
        hasWidgetQualifyingQuestion,
        body.widgetQualifyingQuestion ?? null,
        hasWidgetBookingLinkUrl,
        body.widgetBookingLinkUrl ?? null,
        hasWidgetThankYouMessage,
        body.widgetThankYouMessage ?? null,
      ],
    );
    if (result.rowCount === 0) throw Errors.notFound("Project not found");

    // Use a distinct audit action when this request touched the public
    // widget's exposure surface, so audit-log readers can tell "a project
    // was renamed" apart from "this project's public lead-capture surface
    // (which origins/keys can submit leads) changed" at a glance.
    const touchesWidgetSettings = body.publicWidgetEnabled !== undefined || body.allowedOrigins !== undefined;
    const action = touchesWidgetSettings ? "project.widget_settings_updated" : "project.updated";

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, $3, 'project', $4, $5::jsonb)`,
      [req.tenantId, req.userId, action, projectId, JSON.stringify(body)],
    );

    res.json({ project: result.rows[0] });
  } catch (err) {
    next(err);
  }
});
