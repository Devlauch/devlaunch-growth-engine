import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { leadInputSchema, ingestLead } from "../lib/leadIngestion.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { pickVariant, resolveRenderedBlocks, type Variant } from "../lib/landingPageBuilder.js";

/**
 * Mounted at /api/v1/public (app.ts is off-limits this round — mount this
 * router there alongside publicLeadsRouter, with the same `publicCors`
 * reflect-any-origin + per-route allowlist-check pattern).
 *
 * Unauthenticated-by-design, exactly like routes/publicLeads.ts: an
 * external site embeds a link to GET /projects/:projectPublicKey/landing-pages/:slug,
 * protected the SAME way as publicLeads.ts —
 *   1. The project's own public_api_key (never a tenant id/DB credential).
 *   2. An Origin allowlist checked against the project's allowed_origins.
 *   3. Rate limiting, per IP and per key (same rateLimitMiddleware, reusing
 *      the public-leads env thresholds — this is the same "any outside
 *      website can call this" trust boundary as the lead widget).
 *
 * Form submissions go through the EXACT SAME ingestLead() path used by
 * publicLeads.ts (source: "public_widget" — leads.source is DB-CHECK-
 * constrained to 'internal'|'public_widget'|'agent'|'import', see migration
 * 015_create_leads.sql, and leadIngestion.ts is off-limits this round, so a
 * new enum value isn't introduced here; the landing page/slug/variant are
 * recorded in the lead's customFields instead so the real origin is never
 * lost). This endpoint never builds a second lead-insert path.
 */
export const publicLandingPagesRouter = Router();

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

const perIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicLeadsRateLimitPerIpPerMin,
  name: "public-landing-pages-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});

const perKeyLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicLeadsRateLimitPerKeyPerMin,
  name: "public-landing-pages-key",
  keyFn: (req) => req.params.projectPublicKey,
});

const publicKeyParamSchema = z.string().trim().min(8).max(200);
const slugParamSchema = z.string().trim().min(1).max(200);
const variantSchema = z.enum(["a", "b"]);

interface ResolvedProject {
  id: string;
  tenantId: string;
}

/**
 * Shared project-resolution step, identical in spirit to publicLeads.ts:
 * looks the project up by its public key via the same
 * app.lookup_public_api_key RLS carve-out (019_public_project_lookup_rls.sql),
 * checks public_widget_enabled + the Origin allowlist, and — on success —
 * sets app.current_tenant_id so every subsequent query on this client goes
 * through the normal tenant-isolated RLS policies on landing_pages/
 * lead_magnets/landing_page_events (267_enable_rls_landing_pages.sql), just
 * like any other tenant-scoped write.
 */
async function resolveProjectOrRespond(
  client: import("pg").PoolClient,
  projectPublicKey: string,
  origin: string | null,
): Promise<ResolvedProject | null> {
  await client.query("SELECT set_config('app.lookup_public_api_key', $1, true)", [projectPublicKey]);

  const projectResult = await client.query(
    `SELECT id, tenant_id, allowed_origins, public_widget_enabled
     FROM projects
     WHERE public_api_key = $1`,
    [projectPublicKey],
  );

  if (projectResult.rowCount === 0 || !projectResult.rows[0].public_widget_enabled) {
    return null;
  }

  const project = projectResult.rows[0];
  const allowedOrigins: string[] = project.allowed_origins ?? [];
  if (allowedOrigins.length === 0 || !origin || !allowedOrigins.includes(origin)) {
    return null;
  }

  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [project.tenant_id]);
  return { id: project.id, tenantId: project.tenant_id };
}

/**
 * GET /api/v1/public/projects/:projectPublicKey/landing-pages/:slug
 *
 * Renders a published landing page: resolves its real blocks (base, or the
 * variant a visitor is randomly assigned to when an A/B test is running),
 * its qualifying-question form, SEO metadata, and its lead magnets'
 * title/description (never the gated file_url — that's only ever returned
 * after a real form submission, see POST .../submit below).
 */
publicLandingPagesRouter.get(
  "/projects/:projectPublicKey/landing-pages/:slug",
  perIpLimiter,
  perKeyLimiter,
  async (req, res, next) => {
    const client = await pool.connect();
    let settled = false;
    try {
      const projectPublicKey = publicKeyParamSchema.parse(req.params.projectPublicKey);
      const slug = slugParamSchema.parse(req.params.slug);
      const origin = req.header("origin") ?? null;

      await client.query("BEGIN");
      const project = await resolveProjectOrRespond(client, projectPublicKey, origin);
      if (!project) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        logger.warn({ projectPublicKey, origin }, "public landing page render rejected: unknown key/disabled/bad origin");
        next(Errors.notFound("Unknown or disabled project key"));
        return;
      }

      const pageResult = await client.query(
        `SELECT * FROM landing_pages WHERE project_id = $1 AND slug = $2 AND status = 'published'`,
        [project.id, slug],
      );
      if (pageResult.rowCount === 0) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.notFound("Landing page not found or not published"));
        return;
      }
      const page = pageResult.rows[0];

      const variantsResult = await client.query(
        `SELECT * FROM landing_page_variants WHERE landing_page_id = $1 ORDER BY variant ASC`,
        [page.id],
      );

      let variant: Variant | null = null;
      let renderedBlocks = page.blocks;
      if (variantsResult.rowCount === 2) {
        variant = pickVariant();
        const variantRow = variantsResult.rows.find((v: { variant: Variant }) => v.variant === variant);
        renderedBlocks = resolveRenderedBlocks(page.blocks, variantRow?.blocks ?? null);
      }

      const leadMagnetsResult = await client.query(
        `SELECT id, title, description FROM lead_magnets WHERE landing_page_id = $1 ORDER BY created_at ASC`,
        [page.id],
      );

      await client.query("COMMIT");
      settled = true;
      client.release();

      res.json({
        landingPage: {
          id: page.id,
          slug: page.slug,
          title: page.title,
          seoTitle: page.seo_title,
          seoDescription: page.seo_description,
          seoOgImageUrl: page.seo_og_image_url,
          blocks: renderedBlocks,
          qualifyingQuestions: page.qualifying_questions,
        },
        variant,
        leadMagnets: leadMagnetsResult.rows,
      });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  },
);

const trackEventSchema = z.object({
  eventType: z.enum(["page_view", "download"]),
  variant: variantSchema.optional(),
  leadMagnetId: z.string().uuid().optional(),
});

/**
 * POST /api/v1/public/projects/:projectPublicKey/landing-pages/:slug/track
 *
 * Records a real page_view or download event. form_submit is recorded only
 * by POST .../submit below (never here), so a conversion can never be
 * logged without a real lead actually being captured through ingestLead().
 * A page_view, when the page has an active A/B test, also writes a real
 * experiment_results row (visitors += 1) for the variant served — reusing
 * the EXISTING experiments/experiment_results schema instead of building a
 * second one (see 264_create_landing_page_variants.sql).
 */
publicLandingPagesRouter.post(
  "/projects/:projectPublicKey/landing-pages/:slug/track",
  perIpLimiter,
  perKeyLimiter,
  async (req, res, next) => {
    const client = await pool.connect();
    let settled = false;
    try {
      const projectPublicKey = publicKeyParamSchema.parse(req.params.projectPublicKey);
      const slug = slugParamSchema.parse(req.params.slug);
      const origin = req.header("origin") ?? null;
      const body = trackEventSchema.parse(req.body);

      await client.query("BEGIN");
      const project = await resolveProjectOrRespond(client, projectPublicKey, origin);
      if (!project) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.notFound("Unknown or disabled project key"));
        return;
      }

      const pageResult = await client.query(
        `SELECT id FROM landing_pages WHERE project_id = $1 AND slug = $2 AND status = 'published'`,
        [project.id, slug],
      );
      if (pageResult.rowCount === 0) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.notFound("Landing page not found or not published"));
        return;
      }
      const pageId = pageResult.rows[0].id;

      if (body.leadMagnetId) {
        const magnetCheck = await client.query(`SELECT 1 FROM lead_magnets WHERE id = $1 AND landing_page_id = $2`, [
          body.leadMagnetId,
          pageId,
        ]);
        if (magnetCheck.rowCount === 0) {
          await client.query("ROLLBACK");
          settled = true;
          client.release();
          next(Errors.badRequest("leadMagnetId does not belong to this landing page"));
          return;
        }
      }

      await client.query(
        `INSERT INTO landing_page_events (tenant_id, project_id, landing_page_id, lead_magnet_id, variant, event_type, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [project.tenantId, project.id, pageId, body.leadMagnetId ?? null, body.variant ?? null, body.eventType, hashIp(req.ip ?? "unknown")],
      );

      if (body.eventType === "page_view" && body.variant) {
        await recordExperimentResultIfRunning(client, pageId, project.tenantId, body.variant, { visitors: 1, conversions: 0 });
      }

      await client.query("COMMIT");
      settled = true;
      client.release();
      res.status(201).json({ tracked: true });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  },
);

/** Writes a real experiment_results row (reusing 089_create_experiment_results.sql) for the variant's linked experiment, if this landing page has one running. */
async function recordExperimentResultIfRunning(
  client: import("pg").PoolClient,
  landingPageId: string,
  tenantId: string,
  variant: Variant,
  counts: { visitors: number; conversions: number },
): Promise<void> {
  const variantRow = await client.query(
    `SELECT experiment_id FROM landing_page_variants WHERE landing_page_id = $1 AND variant = $2 AND experiment_id IS NOT NULL`,
    [landingPageId, variant],
  );
  if (variantRow.rowCount === 0) return;
  const experimentId = variantRow.rows[0].experiment_id;

  await client.query(
    `INSERT INTO experiment_results (tenant_id, experiment_id, variant, visitors, conversions)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, experimentId, variant, counts.visitors, counts.conversions],
  );
}

// leadInputSchema is a ZodEffects (it has a top-level .refine()), which has
// no .extend() — so the landing-page-only fields are validated with their
// own small schema and merged in after leadInputSchema.parse() below,
// rather than trying to extend it.
const landingPageSubmitExtraSchema = z.object({
  variant: variantSchema.optional(),
  leadMagnetId: z.string().uuid().optional(),
});

/**
 * POST /api/v1/public/projects/:projectPublicKey/landing-pages/:slug/submit
 *
 * The landing page's enquiry form. Reuses leadInputSchema + ingestLead()
 * from routes/publicLeads.ts verbatim (never a second lead-insert path),
 * tagged source "public_widget" (see the file-level doc comment for why) —
 * every submission is tracked as a real form_submit landing_page_event, and
 * if a `leadMagnetId` was requested, the download is unlocked ("fill form
 * to download") and recorded as a real, gated download event in the same
 * transaction, returning the lead magnet's file_url only now, never before
 * a real lead exists.
 */
publicLandingPagesRouter.post(
  "/projects/:projectPublicKey/landing-pages/:slug/submit",
  perIpLimiter,
  perKeyLimiter,
  async (req, res, next) => {
    const client = await pool.connect();
    let settled = false;
    try {
      const projectPublicKey = publicKeyParamSchema.parse(req.params.projectPublicKey);
      const slug = slugParamSchema.parse(req.params.slug);
      const origin = req.header("origin") ?? null;
      const body = { ...leadInputSchema.parse(req.body), ...landingPageSubmitExtraSchema.parse(req.body) };

      await client.query("BEGIN");
      const project = await resolveProjectOrRespond(client, projectPublicKey, origin);
      if (!project) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        logger.warn({ projectPublicKey, origin }, "public landing page submit rejected: unknown key/disabled/bad origin");
        next(Errors.notFound("Unknown or disabled project key"));
        return;
      }

      const pageResult = await client.query(
        `SELECT id, slug FROM landing_pages WHERE project_id = $1 AND slug = $2 AND status = 'published'`,
        [project.id, slug],
      );
      if (pageResult.rowCount === 0) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.notFound("Landing page not found or not published"));
        return;
      }
      const page = pageResult.rows[0];

      let fileUrl: string | null = null;
      if (body.leadMagnetId) {
        const magnetResult = await client.query(`SELECT file_url FROM lead_magnets WHERE id = $1 AND landing_page_id = $2`, [
          body.leadMagnetId,
          page.id,
        ]);
        if (magnetResult.rowCount === 0) {
          await client.query("ROLLBACK");
          settled = true;
          client.release();
          next(Errors.badRequest("leadMagnetId does not belong to this landing page"));
          return;
        }
        fileUrl = magnetResult.rows[0].file_url;
      }

      const ipHash = hashIp(req.ip ?? "unknown");

      // Same shared lead-ingestion path as publicLeads.ts — never a second
      // insert path. The landing page/slug/variant context is preserved in
      // customFields so it's never lost even though `source` can only be
      // one of the four values leads.source is DB-CHECK-constrained to.
      const lead = await ingestLead({
        client,
        tenantId: project.tenantId,
        projectId: project.id,
        input: {
          ...body,
          customFields: {
            ...(body.customFields ?? {}),
            landingPageId: page.id,
            landingPageSlug: page.slug,
            variant: body.variant ?? null,
          },
        },
        source: "public_widget",
        origin,
        ipHash,
      });

      await client.query(
        `INSERT INTO landing_page_events (tenant_id, project_id, landing_page_id, variant, event_type, ip_hash)
         VALUES ($1, $2, $3, $4, 'form_submit', $5)`,
        [project.tenantId, project.id, page.id, body.variant ?? null, ipHash],
      );
      if (body.variant) {
        await recordExperimentResultIfRunning(client, page.id, project.tenantId, body.variant, { visitors: 0, conversions: 1 });
      }

      if (fileUrl && body.leadMagnetId) {
        await client.query(
          `INSERT INTO landing_page_events (tenant_id, project_id, landing_page_id, lead_magnet_id, variant, event_type, ip_hash)
           VALUES ($1, $2, $3, $4, $5, 'download', $6)`,
          [project.tenantId, project.id, page.id, body.leadMagnetId, body.variant ?? null, ipHash],
        );
      }

      await client.query("COMMIT");
      settled = true;
      client.release();

      res.status(201).json({
        lead: { id: lead.id, createdAt: lead.createdAt },
        download: fileUrl ? { fileUrl } : null,
      });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  },
);
