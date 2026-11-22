import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { extractKeywords, type ExtractedKeyword } from "../lib/keywordExtraction.js";
import {
  COMPETITOR_CANDIDATE_PATHS,
  Crawl4AINotConfiguredError,
  Crawl4AIUnreachableError,
  fetchCompetitorPage,
} from "../lib/crawl4aiClient.js";
import { detectCompetitorChanges, type SnapshotPage } from "../lib/competitorChangeDetection.js";
import { stripHtml, extractTitle } from "../lib/htmlText.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/competitors
 * (app.ts is off-limits this round — mount this router there alongside the
 * other project-scoped routers). Phase 2 item 1, "Competitor Intelligence
 * Agent": CRUD on `competitors`, plus crawling a competitor's site directly
 * (apps/api has no runtime dependency on apps/worker — see
 * ../lib/crawl4aiClient.ts's doc comment) and diffing against its prior
 * snapshot via ../lib/competitorChangeDetection.ts.
 */
export const competitorsRouter = Router({ mergeParams: true });
competitorsRouter.use(requireAuth, requireTenantMembership);

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

async function loadCompetitorOr404(req: Request, projectId: string, competitorId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM competitors WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [competitorId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Competitor not found");
  return r.rows[0];
}

function normalizeDomainToOrigin(domain: string): string {
  if (/^https?:\/\//i.test(domain)) return domain.replace(/\/+$/, "");
  return `https://${domain.replace(/\/+$/, "")}`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const createCompetitorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(5000).optional(),
  isActive: z.boolean().optional(),
});

const updateCompetitorSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    domain: z.string().trim().min(1).max(500).optional(),
    notes: z.string().trim().max(5000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

/** GET / */
competitorsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM competitors WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at ASC`,
      [req.tenantId, projectId],
    );
    res.json({ competitors: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST / */
competitorsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createCompetitorSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO competitors (tenant_id, project_id, name, domain, notes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.tenantId, projectId, body.name, body.domain, body.notes ?? null, body.isActive ?? true],
    );

    res.status(201).json({ competitor: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** PATCH /:id */
competitorsRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const competitorId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCompetitorOr404(req, projectId, competitorId);
    const body = updateCompetitorSchema.parse(req.body);

    const fields: string[] = [];
    const values: unknown[] = [competitorId];
    if (body.name !== undefined) {
      values.push(body.name);
      fields.push(`name = $${values.length}`);
    }
    if (body.domain !== undefined) {
      values.push(body.domain);
      fields.push(`domain = $${values.length}`);
    }
    if (body.notes !== undefined) {
      values.push(body.notes);
      fields.push(`notes = $${values.length}`);
    }
    if (body.isActive !== undefined) {
      values.push(body.isActive);
      fields.push(`is_active = $${values.length}`);
    }

    const result = await req.tenantDb!.query(
      `UPDATE competitors SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      values,
    );

    res.json({ competitor: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /:id */
competitorsRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const competitorId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCompetitorOr404(req, projectId, competitorId);

    await req.tenantDb!.query(`DELETE FROM competitors WHERE id = $1`, [competitorId]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Crawl + diff
// ---------------------------------------------------------------------------

/**
 * POST /:id/crawl
 *
 * Crawls a conservative, fixed, small set of paths
 * (COMPETITOR_CANDIDATE_PATHS: /, /about, /pricing, /blog) on the
 * competitor's own domain directly over HTTP against a running Crawl4AI
 * service, stores a new competitor_snapshots row (one sha256 contentHash
 * per page, via node:crypto — never raw HTML), then diffs it against the
 * competitor's most recent prior snapshot (if any) via
 * ../lib/competitorChangeDetection.ts and persists any detected
 * competitor_changes rows. Fails loudly (502) rather than fabricating a
 * crawl result when Crawl4AI is unreachable or unconfigured.
 */
competitorsRouter.post("/:id/crawl", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const competitorId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const competitor = await loadCompetitorOr404(req, projectId, competitorId);

    const origin = normalizeDomainToOrigin(competitor.domain);
    const pages: SnapshotPage[] = [];

    try {
      for (const path of COMPETITOR_CANDIDATE_PATHS) {
        const url = new URL(path, origin).toString();
        const fetched = await fetchCompetitorPage(url);
        if (fetched.statusCode >= 400 || !fetched.html) {
          // A single page 404ing / being empty is not a service-level
          // failure — just skip it, same as websiteCrawler's own behavior.
          continue;
        }
        const extractedText = stripHtml(fetched.html);
        const title = fetched.title ?? extractTitle(fetched.html);
        pages.push({
          url,
          pageType: path === "/" ? "home" : path.replace(/^\//, ""),
          title,
          extractedText,
          contentHash: createHash("sha256").update(extractedText).digest("hex"),
        });
      }
    } catch (err) {
      if (err instanceof Crawl4AINotConfiguredError) {
        throw Errors.badGateway(err.message);
      }
      if (err instanceof Crawl4AIUnreachableError) {
        throw Errors.badGateway(err.message);
      }
      throw err;
    }

    const combinedText = pages.map((p) => p.extractedText).join(" ");
    const extractedKeywords: ExtractedKeyword[] = extractKeywords(combinedText, 30);

    const previousSnapshotResult = await req.tenantDb!.query(
      `SELECT * FROM competitor_snapshots WHERE competitor_id = $1 AND tenant_id = $2
       ORDER BY crawled_at DESC LIMIT 1`,
      [competitorId, req.tenantId],
    );
    const previousSnapshot = previousSnapshotResult.rows[0] ?? null;
    const previousPages: SnapshotPage[] | null = previousSnapshot ? previousSnapshot.pages : null;

    const snapshotResult = await req.tenantDb!.query(
      `INSERT INTO competitor_snapshots (tenant_id, competitor_id, pages, extracted_keywords, raw_metadata)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
       RETURNING *`,
      [
        req.tenantId,
        competitorId,
        JSON.stringify(pages),
        JSON.stringify(extractedKeywords),
        JSON.stringify({ candidatePaths: COMPETITOR_CANDIDATE_PATHS, pagesFetched: pages.length }),
      ],
    );
    const snapshot = snapshotResult.rows[0];

    const detected = detectCompetitorChanges(previousPages, pages);
    const changesDetected: unknown[] = [];
    for (const change of detected) {
      const inserted = await req.tenantDb!.query(
        `INSERT INTO competitor_changes
           (tenant_id, competitor_id, change_type, page_url, before_snapshot_id, after_snapshot_id, diff_summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.tenantId,
          competitorId,
          change.changeType,
          change.pageUrl,
          previousSnapshot?.id ?? null,
          snapshot.id,
          change.diffSummary,
        ],
      );
      changesDetected.push(inserted.rows[0]);
    }

    res.status(201).json({ snapshot, changesDetected });
  } catch (err) {
    next(err);
  }
});

/** GET /:id/snapshots */
competitorsRouter.get("/:id/snapshots", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const competitorId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCompetitorOr404(req, projectId, competitorId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM competitor_snapshots WHERE competitor_id = $1 AND tenant_id = $2 ORDER BY crawled_at DESC`,
      [competitorId, req.tenantId],
    );
    res.json({ snapshots: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /:id/changes */
competitorsRouter.get("/:id/changes", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const competitorId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCompetitorOr404(req, projectId, competitorId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM competitor_changes WHERE competitor_id = $1 AND tenant_id = $2 ORDER BY detected_at DESC`,
      [competitorId, req.tenantId],
    );
    res.json({ changes: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:id/report
 *
 * A real, generated-from-real-data report — never an LLM-written
 * narrative. `positioningSummary` is short, templated text built directly
 * from the competitor's latest snapshot's top keywords and the count of
 * changes detected in the last 30 days.
 */
competitorsRouter.get("/:id/report", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const competitorId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const competitor = await loadCompetitorOr404(req, projectId, competitorId);

    const latestSnapshotResult = await req.tenantDb!.query(
      `SELECT * FROM competitor_snapshots WHERE competitor_id = $1 AND tenant_id = $2
       ORDER BY crawled_at DESC LIMIT 1`,
      [competitorId, req.tenantId],
    );
    const latestSnapshot = latestSnapshotResult.rows[0] ?? null;

    const recentChangesResult = await req.tenantDb!.query(
      `SELECT * FROM competitor_changes
       WHERE competitor_id = $1 AND tenant_id = $2 AND detected_at >= now() - interval '30 days'
       ORDER BY detected_at DESC`,
      [competitorId, req.tenantId],
    );
    const recentChanges = recentChangesResult.rows;

    const topKeywords: ExtractedKeyword[] = latestSnapshot ? latestSnapshot.extracted_keywords : [];

    let positioningSummary: string;
    if (!latestSnapshot) {
      positioningSummary = `No crawl has been run yet for ${competitor.domain} — run "Crawl now" to generate a report.`;
    } else {
      const topFive = topKeywords
        .slice(0, 5)
        .map((k) => k.keyword)
        .join(", ");
      const topFiveText = topFive.length > 0 ? topFive : "no recurring terms found yet";
      positioningSummary =
        `Top recurring terms on ${competitor.domain}: ${topFiveText}. ` +
        `${recentChanges.length} change(s) detected in the last 30 days.`;
    }

    res.json({
      competitor,
      latestSnapshot,
      recentChanges,
      topKeywords,
      positioningSummary,
    });
  } catch (err) {
    next(err);
  }
});
