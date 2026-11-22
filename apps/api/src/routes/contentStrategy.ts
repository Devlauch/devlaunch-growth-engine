import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import {
  buildBrandVoiceProfile,
  generateContentCalendar,
  repurposeContent,
  type IcpProfileInput,
  type ProjectProfileInput,
  type RepurposeFormat,
} from "../lib/contentGeneration.js";

/**
 * contentCalendarsRouter — mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/content-calendars
 *
 * Phase 2 item 2 ("Content Strategy Agent"): generates a real 30-day
 * content calendar (LinkedIn posts, blogs, emails) from the project's own
 * project_profiles row (brand voice anchor) and an optional icp_profiles
 * row (audience targeting), via apps/api/src/lib/contentGeneration.ts. See
 * that file's doc comment for why this is deterministic templating, not an
 * LLM call.
 */
export const contentCalendarsRouter = Router({ mergeParams: true });
contentCalendarsRouter.use(requireAuth, requireTenantMembership);

/**
 * contentDraftsRouter — mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/content-drafts
 *
 * Standalone content pieces for the "repurpose one blog into multiple
 * formats" feature, independent of any calendar.
 */
export const contentDraftsRouter = Router({ mergeParams: true });
contentDraftsRouter.use(requireAuth, requireTenantMembership);

const CALENDAR_COLUMNS = `id, tenant_id, project_id, name, start_date, icp_profile_id, created_at, updated_at`;
const ITEM_COLUMNS = `id, tenant_id, calendar_id, day_offset, content_type, title, body, status, created_at, updated_at`;
const DRAFT_COLUMNS = `id, tenant_id, project_id, source_draft_id, format, title, body, brand_voice_note, created_at`;

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadProjectProfileOr404(req: Request, projectId: string): Promise<ProjectProfileInput> {
  const r = await req.tenantDb!.query(
    `SELECT company_name, industry, website_url, value_proposition, target_markets
     FROM project_profiles WHERE project_id = $1 AND tenant_id = $2`,
    [projectId, req.tenantId],
  );
  if (r.rowCount === 0) {
    throw Errors.notFound("Set up a project profile first (POST/PUT .../profile) before generating content.");
  }
  return r.rows[0];
}

async function loadIcpProfileOrNull(
  req: Request,
  projectId: string,
  icpProfileId: string | null | undefined,
): Promise<IcpProfileInput | null> {
  if (!icpProfileId) return null;
  const r = await req.tenantDb!.query(
    `SELECT name, segment, description, pain_points FROM icp_profiles
     WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [icpProfileId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("ICP profile not found");
  return r.rows[0];
}

async function loadCalendarOr404(req: Request, projectId: string, calendarId: string) {
  const r = await req.tenantDb!.query(
    `SELECT ${CALENDAR_COLUMNS} FROM content_calendars WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [calendarId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Content calendar not found");
  return r.rows[0];
}

/** GET /content-calendars */
contentCalendarsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT ${CALENDAR_COLUMNS} FROM content_calendars
       WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ contentCalendars: result.rows });
  } catch (err) {
    next(err);
  }
});

const createCalendarSchema = z.object({
  name: z.string().trim().min(1).max(200),
  startDate: z.string().trim().min(1),
  icpProfileId: z.string().uuid().optional(),
});

/** POST /content-calendars — generates and persists a real 30-day calendar. */
contentCalendarsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createCalendarSchema.parse(req.body);

    const projectProfile = await loadProjectProfileOr404(req, projectId);
    const icpProfile = await loadIcpProfileOrNull(req, projectId, body.icpProfileId);

    const generatedItems = generateContentCalendar(projectProfile, icpProfile, body.startDate);

    const calendarResult = await req.tenantDb!.query(
      `INSERT INTO content_calendars (tenant_id, project_id, name, start_date, icp_profile_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${CALENDAR_COLUMNS}`,
      [req.tenantId, projectId, body.name, body.startDate, body.icpProfileId ?? null],
    );
    const calendar = calendarResult.rows[0];

    const items: Record<string, unknown>[] = [];
    for (const item of generatedItems) {
      const r = await req.tenantDb!.query(
        `INSERT INTO content_calendar_items (tenant_id, calendar_id, day_offset, content_type, title, body)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${ITEM_COLUMNS}`,
        [req.tenantId, calendar.id, item.dayOffset, item.contentType, item.title, item.body],
      );
      items.push(r.rows[0]);
    }

    res.status(201).json({ contentCalendar: calendar, items });
  } catch (err) {
    next(err);
  }
});

/** GET /content-calendars/:id — calendar + its items. */
contentCalendarsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const calendarId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const calendar = await loadCalendarOr404(req, projectId, calendarId);

    const items = await req.tenantDb!.query(
      `SELECT ${ITEM_COLUMNS} FROM content_calendar_items
       WHERE tenant_id = $1 AND calendar_id = $2 ORDER BY day_offset ASC`,
      [req.tenantId, calendarId],
    );

    res.json({ contentCalendar: calendar, items: items.rows });
  } catch (err) {
    next(err);
  }
});

const patchItemSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    body: z.string().trim().min(1).max(20000).optional(),
    status: z.enum(["draft", "approved"]).optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined || v.status !== undefined, {
    message: "At least one of title/body/status must be provided",
  });

/** PATCH /content-calendars/:id/items/:itemId — edit title/body/status. */
contentCalendarsRouter.patch("/:id/items/:itemId", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const calendarId = paramId(req, "id");
    const itemId = paramId(req, "itemId");
    await assertProjectInTenant(req, projectId);
    await loadCalendarOr404(req, projectId, calendarId);
    const body = patchItemSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE content_calendar_items
       SET title = COALESCE($4, title), body = COALESCE($5, body), status = COALESCE($6, status)
       WHERE id = $1 AND tenant_id = $2 AND calendar_id = $3
       RETURNING ${ITEM_COLUMNS}`,
      [itemId, req.tenantId, calendarId, body.title ?? null, body.body ?? null, body.status ?? null],
    );
    if (result.rowCount === 0) throw Errors.notFound("Content calendar item not found");

    res.json({ item: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /content-calendars/:id */
contentCalendarsRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const calendarId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCalendarOr404(req, projectId, calendarId);

    await req.tenantDb!.query(`DELETE FROM content_calendars WHERE id = $1 AND tenant_id = $2`, [
      calendarId,
      req.tenantId,
    ]);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

async function loadDraftOr404(req: Request, projectId: string, draftId: string) {
  const r = await req.tenantDb!.query(
    `SELECT ${DRAFT_COLUMNS} FROM content_drafts WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [draftId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Content draft not found");
  return r.rows[0];
}

/** GET /content-drafts */
contentDraftsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT ${DRAFT_COLUMNS} FROM content_drafts WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ contentDrafts: result.rows });
  } catch (err) {
    next(err);
  }
});

const createDraftSchema = z.object({
  format: z.enum(["blog", "linkedin_post", "email", "twitter_thread", "summary"]),
  title: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20000),
});

/** POST /content-drafts — create an original draft directly (e.g. a blog written by the user). */
contentDraftsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createDraftSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO content_drafts (tenant_id, project_id, format, title, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${DRAFT_COLUMNS}`,
      [req.tenantId, projectId, body.format, body.title, body.body],
    );

    res.status(201).json({ contentDraft: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const repurposeSchema = z.object({
  targetFormats: z
    .array(z.enum(["blog", "linkedin_post", "email", "twitter_thread", "summary"]))
    .min(1)
    .max(5),
});

/** POST /content-drafts/:id/repurpose — real extraction-based repurposing of the source draft's own text. */
contentDraftsRouter.post("/:id/repurpose", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const draftId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const sourceDraft = await loadDraftOr404(req, projectId, draftId);
    const body = repurposeSchema.parse(req.body);

    const projectProfile = await loadProjectProfileOr404(req, projectId);
    const brandVoice = buildBrandVoiceProfile(projectProfile, null);

    const targetFormats = body.targetFormats as RepurposeFormat[];
    const pieces = repurposeContent(sourceDraft.body, sourceDraft.format, targetFormats, brandVoice);

    const repurposed: Record<string, unknown>[] = [];
    for (const piece of pieces) {
      const note = `Matched tone (${brandVoice.tone}) from project_profiles.value_proposition/industry; extracted from source draft ${sourceDraft.id}.`;
      const r = await req.tenantDb!.query(
        `INSERT INTO content_drafts (tenant_id, project_id, source_draft_id, format, title, body, brand_voice_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${DRAFT_COLUMNS}`,
        [req.tenantId, projectId, sourceDraft.id, piece.format, piece.title, piece.body, note],
      );
      repurposed.push(r.rows[0]);
    }

    res.status(201).json({ repurposed });
  } catch (err) {
    next(err);
  }
});
