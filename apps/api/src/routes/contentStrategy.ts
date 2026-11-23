import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import {
  buildBrandVoiceProfile,
  enhanceBlogBodyWithLlm,
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
 * that file's doc comment for why this is deterministic templating by
 * default, not an LLM call — and for `enhanceBlogBodyWithLlm`, the opt-in
 * LLM-enhancement seam this POST handler calls for blog items when the
 * caller passes `enhanceBlogsWithLlm: true` (honestly a no-op unless a
 * real ANTHROPIC_API_KEY is configured and this tenant's monthly LLM token
 * budget isn't exceeded — see content_calendar_items.generation_method,
 * migration 562, for how a blog item's actual production method is
 * labeled in the response/DB rather than left ambiguous).
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

const CALENDAR_COLUMNS = `id, tenant_id, project_id, name, start_date, icp_profile_id, seo_campaign_id, created_at, updated_at`;
const ITEM_COLUMNS = `id, tenant_id, calendar_id, day_offset, content_type, title, body, status, generation_method, created_at, updated_at`;
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

async function assertCampaignInProject(req: Request, projectId: string, seoCampaignId: string) {
  const r = await req.tenantDb!.query(
    "SELECT 1 FROM seo_campaigns WHERE id = $1 AND tenant_id = $2 AND project_id = $3",
    [seoCampaignId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("SEO campaign not found");
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
  // Optional tag against an existing SEO campaign (routes/seoCampaigns.ts)
  // so this calendar's items count toward that campaign's real
  // content-progress tracking — see GET .../seo-campaigns/:id.
  seoCampaignId: z.string().uuid().optional(),
  // Opt-in LLM enhancement (see this file's header comment + migration
  // 562): default false, so existing callers' behavior never changes
  // unless they explicitly ask for it. Even when true, this is an honest
  // no-op unless a real ANTHROPIC_API_KEY is configured for this
  // environment and this tenant's monthly LLM token budget isn't already
  // exceeded — enhanceBlogBodyWithLlm() handles both cases by simply
  // leaving the deterministic template body in place.
  enhanceBlogsWithLlm: z.boolean().optional().default(false),
});

/**
 * POST /content-calendars — generates and persists a real 30-day calendar.
 * When `enhanceBlogsWithLlm` is true, each blog item's deterministic
 * template body is additionally offered to a real, configured LLM for a
 * polish pass (see contentGeneration.ts's enhanceBlogBodyWithLlm) — the
 * template body is only ever replaced when that call genuinely succeeds;
 * every item's `generation_method` column honestly reflects which one
 * actually produced its stored body.
 */
contentCalendarsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createCalendarSchema.parse(req.body);

    const projectProfile = await loadProjectProfileOr404(req, projectId);
    const icpProfile = await loadIcpProfileOrNull(req, projectId, body.icpProfileId);
    if (body.seoCampaignId) await assertCampaignInProject(req, projectId, body.seoCampaignId);

    const generatedItems = generateContentCalendar(projectProfile, icpProfile, body.startDate);

    const calendarResult = await req.tenantDb!.query(
      `INSERT INTO content_calendars (tenant_id, project_id, name, start_date, icp_profile_id, seo_campaign_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${CALENDAR_COLUMNS}`,
      [req.tenantId, projectId, body.name, body.startDate, body.icpProfileId ?? null, body.seoCampaignId ?? null],
    );
    const calendar = calendarResult.rows[0];

    let llmEnhancementSummary: { requested: boolean; enhancedCount: number; lastStatus: string | null } | undefined;
    if (body.enhanceBlogsWithLlm) {
      llmEnhancementSummary = { requested: true, enhancedCount: 0, lastStatus: null };
    }

    const items: Record<string, unknown>[] = [];
    for (const item of generatedItems) {
      let finalBody = item.body;
      let generationMethod: "template" | "llm" = "template";

      if (body.enhanceBlogsWithLlm && item.contentType === "blog") {
        const enhancement = await enhanceBlogBodyWithLlm(req.tenantDb!, req.tenantId!, projectId, item.title, item.body);
        llmEnhancementSummary!.lastStatus = enhancement.status;
        if (enhancement.status === "ok" && enhancement.body) {
          finalBody = enhancement.body;
          generationMethod = "llm";
          llmEnhancementSummary!.enhancedCount += 1;
        }
      }

      const r = await req.tenantDb!.query(
        `INSERT INTO content_calendar_items (tenant_id, calendar_id, day_offset, content_type, title, body, generation_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${ITEM_COLUMNS}`,
        [req.tenantId, calendar.id, item.dayOffset, item.contentType, item.title, finalBody, generationMethod],
      );
      items.push(r.rows[0]);
    }

    res.status(201).json({ contentCalendar: calendar, items, llmEnhancement: llmEnhancementSummary });
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

const patchCalendarSchema = z
  .object({
    seoCampaignId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.seoCampaignId !== undefined, {
    message: "seoCampaignId must be provided (a uuid, or null to untag)",
  });

/**
 * PATCH /content-calendars/:id — tag (or untag, with null) an existing
 * calendar against an SEO campaign (routes/seoCampaigns.ts), so its items'
 * real publish progress counts toward that campaign without duplicating
 * the calendar/items into a second table.
 */
contentCalendarsRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const calendarId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCalendarOr404(req, projectId, calendarId);
    const body = patchCalendarSchema.parse(req.body);
    if (body.seoCampaignId) await assertCampaignInProject(req, projectId, body.seoCampaignId);

    const result = await req.tenantDb!.query(
      `UPDATE content_calendars SET seo_campaign_id = $4
       WHERE id = $1 AND tenant_id = $2 AND project_id = $3
       RETURNING ${CALENDAR_COLUMNS}`,
      [calendarId, req.tenantId, projectId, body.seoCampaignId ?? null],
    );

    res.json({ contentCalendar: result.rows[0] });
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
