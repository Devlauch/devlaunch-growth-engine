import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import {
  buildLandingPageBlocks,
  type IcpProfileInput,
  type ProjectProfileInput,
  type QualifyingQuestion,
} from "../lib/landingPageBuilder.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/landing-pages
 * (app.ts is off-limits this round — mount this router there alongside the
 * other project-scoped routers, e.g. right after competitorsRouter).
 *
 * Feature 2, "AI Landing Page & Lead Magnet Builder": authenticated CRUD +
 * publish/unpublish on landing_pages, plus variant (A/B test) management,
 * lead magnet management, and a real conversion-stats rollup. The public,
 * unauthenticated surface (render a published page, submit its form, track
 * events) lives in routes/publicLandingPages.ts.
 */
export const landingPagesRouter = Router({ mergeParams: true });
landingPagesRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadLandingPageOr404(req: Request, projectId: string, landingPageId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM landing_pages WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [landingPageId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Landing page not found");
  return r.rows[0];
}

/** Loads the project's real brand-voice inputs for landingPageBuilder.ts — never invented. */
async function loadBuilderInputs(
  req: Request,
  projectId: string,
  icpProfileId?: string | null,
): Promise<{ profile: ProjectProfileInput; icp: IcpProfileInput | null }> {
  const profileResult = await req.tenantDb!.query(
    `SELECT company_name, industry, value_proposition FROM project_profiles WHERE project_id = $1 AND tenant_id = $2`,
    [projectId, req.tenantId],
  );
  const profile: ProjectProfileInput = profileResult.rows[0] ?? {
    company_name: null,
    industry: null,
    value_proposition: null,
  };

  let icp: IcpProfileInput | null = null;
  if (icpProfileId) {
    const icpResult = await req.tenantDb!.query(
      `SELECT name, segment, pain_points FROM icp_profiles WHERE id = $1 AND project_id = $2 AND tenant_id = $3`,
      [icpProfileId, projectId, req.tenantId],
    );
    if (icpResult.rowCount === 0) throw Errors.badRequest("icpProfileId does not refer to an ICP profile in this project");
    icp = icpResult.rows[0];
  }

  return { profile, icp };
}

const qualifyingQuestionSchema: z.ZodType<QualifyingQuestion> = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(300),
  type: z.enum(["text", "select"]),
  options: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  required: z.boolean().optional(),
});

const copyFieldsSchema = z.object({
  audienceLabel: z.string().trim().max(200).optional(),
  headline: z.string().trim().max(300).optional(),
  subheadline: z.string().trim().max(500).optional(),
  bodyCopy: z.string().trim().max(5000).optional(),
  benefits: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  testimonialQuote: z.string().trim().max(1000).optional(),
  testimonialAuthor: z.string().trim().max(200).optional(),
  ctaText: z.string().trim().max(200).optional(),
  ctaUrl: z.string().trim().url().max(2000).optional(),
  qualifyingQuestions: z.array(qualifyingQuestionSchema).max(10).optional(),
});

const createLandingPageSchema = copyFieldsSchema.extend({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase letters, numbers, and single hyphens"),
  title: z.string().trim().min(1).max(200),
  icpProfileId: z.string().uuid().optional(),
  seoTitle: z.string().trim().max(200).optional(),
  seoDescription: z.string().trim().max(500).optional(),
  seoOgImageUrl: z.string().trim().url().max(2000).optional(),
  customDomain: z.string().trim().max(300).optional(),
});

const updateLandingPageSchema = copyFieldsSchema
  .extend({
    title: z.string().trim().min(1).max(200).optional(),
    icpProfileId: z.string().uuid().optional(),
    seoTitle: z.string().trim().max(200).optional(),
    seoDescription: z.string().trim().max(500).optional(),
    seoOgImageUrl: z.string().trim().url().max(2000).optional(),
    customDomain: z.string().trim().max(300).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

/** GET / — list landing pages for a project */
landingPagesRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM landing_pages WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ landingPages: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST / — create a landing page, building its deterministic template blocks */
landingPagesRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createLandingPageSchema.parse(req.body);

    const { profile, icp } = await loadBuilderInputs(req, projectId, body.icpProfileId);
    const blocks = buildLandingPageBlocks(profile, icp, body);

    const result = await req.tenantDb!.query(
      `INSERT INTO landing_pages (
         tenant_id, project_id, slug, title, audience_label, headline, subheadline, body_copy, benefits,
         testimonial_quote, testimonial_author, cta_text, cta_url, qualifying_questions, blocks,
         seo_title, seo_description, seo_og_image_url, custom_domain
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18, $19)
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        body.slug,
        body.title,
        body.audienceLabel ?? null,
        body.headline ?? null,
        body.subheadline ?? null,
        body.bodyCopy ?? null,
        body.benefits ?? [],
        body.testimonialQuote ?? null,
        body.testimonialAuthor ?? null,
        body.ctaText ?? null,
        body.ctaUrl ?? null,
        JSON.stringify(body.qualifyingQuestions ?? []),
        JSON.stringify(blocks),
        body.seoTitle ?? null,
        body.seoDescription ?? null,
        body.seoOgImageUrl ?? null,
        body.customDomain ?? null,
      ],
    );

    res.status(201).json({ landingPage: result.rows[0] });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      next(Errors.conflict("A landing page with this slug already exists for this project"));
      return;
    }
    next(err);
  }
});

/** GET /:id */
landingPagesRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPage = await loadLandingPageOr404(req, projectId, paramId(req, "id"));
    res.json({ landingPage });
  } catch (err) {
    next(err);
  }
});

/** PATCH /:id — update copy fields and rebuild the deterministic blocks */
landingPagesRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    const existing = await loadLandingPageOr404(req, projectId, landingPageId);
    const body = updateLandingPageSchema.parse(req.body);

    const merged = {
      audienceLabel: body.audienceLabel ?? existing.audience_label,
      headline: body.headline ?? existing.headline,
      subheadline: body.subheadline ?? existing.subheadline,
      bodyCopy: body.bodyCopy ?? existing.body_copy,
      benefits: body.benefits ?? existing.benefits,
      testimonialQuote: body.testimonialQuote ?? existing.testimonial_quote,
      testimonialAuthor: body.testimonialAuthor ?? existing.testimonial_author,
      ctaText: body.ctaText ?? existing.cta_text,
      ctaUrl: body.ctaUrl ?? existing.cta_url,
      qualifyingQuestions: body.qualifyingQuestions ?? existing.qualifying_questions,
    };

    const { profile, icp } = await loadBuilderInputs(req, projectId, body.icpProfileId);
    const blocks = buildLandingPageBlocks(profile, icp, merged);

    const result = await req.tenantDb!.query(
      `UPDATE landing_pages SET
         title = $1, audience_label = $2, headline = $3, subheadline = $4, body_copy = $5, benefits = $6,
         testimonial_quote = $7, testimonial_author = $8, cta_text = $9, cta_url = $10,
         qualifying_questions = $11::jsonb, blocks = $12::jsonb,
         seo_title = $13, seo_description = $14, seo_og_image_url = $15, custom_domain = $16
       WHERE id = $17 AND tenant_id = $18 AND project_id = $19
       RETURNING *`,
      [
        body.title ?? existing.title,
        merged.audienceLabel,
        merged.headline,
        merged.subheadline,
        merged.bodyCopy,
        merged.benefits,
        merged.testimonialQuote,
        merged.testimonialAuthor,
        merged.ctaText,
        merged.ctaUrl,
        JSON.stringify(merged.qualifyingQuestions),
        JSON.stringify(blocks),
        body.seoTitle ?? existing.seo_title,
        body.seoDescription ?? existing.seo_description,
        body.seoOgImageUrl ?? existing.seo_og_image_url,
        body.customDomain ?? existing.custom_domain,
        landingPageId,
        req.tenantId,
        projectId,
      ],
    );

    res.json({ landingPage: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /:id */
landingPagesRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);

    await req.tenantDb!.query(`DELETE FROM landing_pages WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
      landingPageId,
      req.tenantId,
      projectId,
    ]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/** POST /:id/publish */
landingPagesRouter.post("/:id/publish", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);

    const result = await req.tenantDb!.query(
      `UPDATE landing_pages SET status = 'published', published_at = now()
       WHERE id = $1 AND tenant_id = $2 AND project_id = $3
       RETURNING *`,
      [landingPageId, req.tenantId, projectId],
    );
    res.json({ landingPage: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** POST /:id/unpublish */
landingPagesRouter.post("/:id/unpublish", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);

    const result = await req.tenantDb!.query(
      `UPDATE landing_pages SET status = 'draft', published_at = NULL
       WHERE id = $1 AND tenant_id = $2 AND project_id = $3
       RETURNING *`,
      [landingPageId, req.tenantId, projectId],
    );
    res.json({ landingPage: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------- */
/* A/B test variants — reuses the existing experiments/experiment_results */
/* tables (088/089) via the landing_page_variants join table (264).       */
/* -------------------------------------------------------------------- */

/** GET /:id/variants */
landingPagesRouter.get("/:id/variants", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM landing_page_variants WHERE tenant_id = $1 AND landing_page_id = $2 ORDER BY variant ASC`,
      [req.tenantId, landingPageId],
    );
    res.json({ variants: result.rows });
  } catch (err) {
    next(err);
  }
});

const startAbTestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  hypothesis: z.string().trim().min(1).max(5000),
  variantBHeadline: z.string().trim().max(300).optional(),
  variantBSubheadline: z.string().trim().max(500).optional(),
  variantBCtaText: z.string().trim().max(200).optional(),
});

/**
 * POST /:id/ab-test — starts an A/B test on this landing page: creates one
 * `experiments` row (the existing Phase 2 table, status 'running') plus the
 * two `landing_page_variants` rows ('a' = control, unchanged; 'b' =
 * challenger, with the overrides given here re-rendered through the exact
 * same deterministic landingPageBuilder.ts used for the base page). Real
 * visitor/conversion numbers accumulate from there via
 * routes/publicLandingPages.ts writing real landing_page_events AND, for
 * the attached experiment, real experiment_results rows — so this
 * experiment can be read with the EXISTING
 * GET /conversion-optimization/experiments/:id/results endpoint, unchanged.
 */
landingPagesRouter.post("/:id/ab-test", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    const landingPage = await loadLandingPageOr404(req, projectId, landingPageId);
    const body = startAbTestSchema.parse(req.body);

    const existingVariants = await req.tenantDb!.query(
      `SELECT 1 FROM landing_page_variants WHERE landing_page_id = $1 AND tenant_id = $2`,
      [landingPageId, req.tenantId],
    );
    if ((existingVariants.rowCount ?? 0) > 0) {
      throw Errors.conflict("This landing page already has variants — stop/abandon the existing experiment first");
    }

    const { profile, icp } = await loadBuilderInputs(req, projectId);
    const variantBBlocks = buildLandingPageBlocks(profile, icp, {
      audienceLabel: landingPage.audience_label,
      headline: body.variantBHeadline ?? landingPage.headline,
      subheadline: body.variantBSubheadline ?? landingPage.subheadline,
      bodyCopy: landingPage.body_copy,
      benefits: landingPage.benefits,
      testimonialQuote: landingPage.testimonial_quote,
      testimonialAuthor: landingPage.testimonial_author,
      ctaText: body.variantBCtaText ?? landingPage.cta_text,
      ctaUrl: landingPage.cta_url,
      qualifyingQuestions: landingPage.qualifying_questions,
    });

    const experimentResult = await req.tenantDb!.query(
      `INSERT INTO experiments (tenant_id, project_id, name, hypothesis, variant_a_description, variant_b_description, status, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', now())
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        body.name,
        body.hypothesis,
        "Current landing page, unchanged (control).",
        `Challenger variant${body.variantBHeadline ? `: headline "${body.variantBHeadline}"` : ""}${
          body.variantBCtaText ? `, CTA "${body.variantBCtaText}"` : ""
        }.`,
      ],
    );
    const experiment = experimentResult.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO landing_page_variants (tenant_id, landing_page_id, experiment_id, variant, is_control, blocks)
       VALUES ($1, $2, $3, 'a', true, '[]'::jsonb)`,
      [req.tenantId, landingPageId, experiment.id],
    );
    const variantBResult = await req.tenantDb!.query(
      `INSERT INTO landing_page_variants (tenant_id, landing_page_id, experiment_id, variant, is_control, headline, subheadline, cta_text, blocks)
       VALUES ($1, $2, $3, 'b', false, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        req.tenantId,
        landingPageId,
        experiment.id,
        body.variantBHeadline ?? null,
        body.variantBSubheadline ?? null,
        body.variantBCtaText ?? null,
        JSON.stringify(variantBBlocks),
      ],
    );

    res.status(201).json({ experiment, variantB: variantBResult.rows[0] });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------- */
/* Lead magnets                                                          */
/* -------------------------------------------------------------------- */

const leadMagnetSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  // Stub: no upload/storage infra in this codebase — the client hosts the
  // file themselves and gives us its URL/path.
  fileUrl: z.string().trim().min(1).max(2000),
});

const updateLeadMagnetSchema = leadMagnetSchema.partial().refine((body) => Object.keys(body).length > 0, {
  message: "No fields to update",
});

/** GET /:id/lead-magnets */
landingPagesRouter.get("/:id/lead-magnets", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM lead_magnets WHERE tenant_id = $1 AND landing_page_id = $2 ORDER BY created_at DESC`,
      [req.tenantId, landingPageId],
    );
    res.json({ leadMagnets: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /:id/lead-magnets */
landingPagesRouter.post("/:id/lead-magnets", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);
    const body = leadMagnetSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO lead_magnets (tenant_id, project_id, landing_page_id, title, description, file_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.tenantId, projectId, landingPageId, body.title, body.description ?? null, body.fileUrl],
    );
    res.status(201).json({ leadMagnet: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

async function loadLeadMagnetOr404(req: Request, landingPageId: string, leadMagnetId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM lead_magnets WHERE id = $1 AND tenant_id = $2 AND landing_page_id = $3`,
    [leadMagnetId, req.tenantId, landingPageId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Lead magnet not found");
  return r.rows[0];
}

/** PATCH /:id/lead-magnets/:magnetId */
landingPagesRouter.patch("/:id/lead-magnets/:magnetId", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);
    const leadMagnetId = paramId(req, "magnetId");
    const existing = await loadLeadMagnetOr404(req, landingPageId, leadMagnetId);
    const body = updateLeadMagnetSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE lead_magnets SET title = $1, description = $2, file_url = $3
       WHERE id = $4 AND tenant_id = $5 AND landing_page_id = $6
       RETURNING *`,
      [
        body.title ?? existing.title,
        body.description ?? existing.description,
        body.fileUrl ?? existing.file_url,
        leadMagnetId,
        req.tenantId,
        landingPageId,
      ],
    );
    res.json({ leadMagnet: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /:id/lead-magnets/:magnetId */
landingPagesRouter.delete("/:id/lead-magnets/:magnetId", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);
    const leadMagnetId = paramId(req, "magnetId");
    await loadLeadMagnetOr404(req, landingPageId, leadMagnetId);

    await req.tenantDb!.query(`DELETE FROM lead_magnets WHERE id = $1 AND tenant_id = $2 AND landing_page_id = $3`, [
      leadMagnetId,
      req.tenantId,
      landingPageId,
    ]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------- */
/* Conversion stats — real rollups from landing_page_events only          */
/* -------------------------------------------------------------------- */

interface EventRollupRow {
  event_type: "page_view" | "form_submit" | "download";
  variant: "a" | "b" | null;
  count: string;
}

/** GET /:id/stats */
landingPagesRouter.get("/:id/stats", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);

    const result = await req.tenantDb!.query<EventRollupRow>(
      `SELECT event_type, variant, COUNT(*)::text AS count
       FROM landing_page_events
       WHERE tenant_id = $1 AND landing_page_id = $2
       GROUP BY event_type, variant`,
      [req.tenantId, landingPageId],
    );

    let views = 0;
    let submits = 0;
    let downloads = 0;
    const byVariant: Record<string, { views: number; submits: number; downloads: number }> = {};

    for (const row of result.rows) {
      const count = Number(row.count);
      if (row.event_type === "page_view") views += count;
      if (row.event_type === "form_submit") submits += count;
      if (row.event_type === "download") downloads += count;

      if (row.variant) {
        byVariant[row.variant] ??= { views: 0, submits: 0, downloads: 0 };
        if (row.event_type === "page_view") byVariant[row.variant].views += count;
        if (row.event_type === "form_submit") byVariant[row.variant].submits += count;
        if (row.event_type === "download") byVariant[row.variant].downloads += count;
      }
    }

    res.json({
      views,
      submits,
      downloads,
      conversionRate: views > 0 ? submits / views : 0,
      byVariant,
    });
  } catch (err) {
    next(err);
  }
});
