import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { auditLandingPage, type LandingPageFinding } from "../lib/landingPageAudit.js";
import { computeFunnelDropoff } from "../lib/funnelDropoff.js";
import { generateExperimentSuggestions } from "../lib/experimentSuggestions.js";

/**
 * conversionOptimizationRouter: mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization
 *
 * Phase 2 item 5, "Conversion Optimization Agent": landing page analysis
 * (POST/GET /landing-page-audits, real fetch+regex via
 * lib/landingPageAudit.ts), funnel drop-off detection (GET /funnel-dropoff,
 * real SQL via lib/funnelDropoff.ts), and A/B experiment suggestions
 * (GET /experiment-suggestions, real rule-based generation via
 * lib/experimentSuggestions.ts driven by the two above).
 *
 * experimentsRouter (same file, same export group): CRUD for experiments
 * plus recording/aggregating real experiment_results.
 *
 * Both exports point at the SAME underlying Router instance (same
 * convention intent as discovery.ts's discoverySourcesRouter /
 * discoveredOrganizationsRouter, but those mount at distinct subpaths;
 * here the spec calls for both groups at the exact same
 * .../conversion-optimization base path, so they are kept as one Router
 * with one requireAuth/requireTenantMembership pass — mounting the same
 * router instance twice at an identical path would otherwise run tenant
 * membership checks, and open a pooled transaction, twice per request).
 */
const router = Router({ mergeParams: true });
router.use(requireAuth, requireTenantMembership);

export const conversionOptimizationRouter = router;
export const experimentsRouter = router;

async function assertProjectInTenant(req: import("express").Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

function getProjectId(req: import("express").Request): string {
  return z.string().uuid().parse((req.params as Record<string, string>).projectId);
}

/* -------------------------------------------------------------------- */
/* Landing page audits                                                   */
/* -------------------------------------------------------------------- */

const createAuditSchema = z.object({
  url: z.string().trim().url(),
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization/landing-page-audits */
conversionOptimizationRouter.post("/landing-page-audits", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await assertProjectInTenant(req, projectId);
    const body = createAuditSchema.parse(req.body);

    const auditResult = await auditLandingPage(body.url);

    const result = await req.tenantDb!.query(
      `INSERT INTO landing_page_audits
         (tenant_id, project_id, url, has_cta, has_form, word_count, heading_count, load_status, findings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        body.url,
        auditResult.hasCta,
        auditResult.hasForm,
        auditResult.wordCount,
        auditResult.headingCount,
        auditResult.loadStatus,
        JSON.stringify(auditResult.findings),
      ],
    );

    res.status(201).json({ audit: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization/landing-page-audits */
conversionOptimizationRouter.get("/landing-page-audits", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM landing_page_audits WHERE tenant_id = $1 AND project_id = $2 ORDER BY audited_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ audits: result.rows });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------- */
/* Funnel drop-off                                                        */
/* -------------------------------------------------------------------- */

/** GET /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization/funnel-dropoff */
conversionOptimizationRouter.get("/funnel-dropoff", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await assertProjectInTenant(req, projectId);

    const result = await computeFunnelDropoff(req.tenantDb!, req.tenantId!, projectId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------- */
/* Experiment suggestions                                                */
/* -------------------------------------------------------------------- */

/** GET /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization/experiment-suggestions */
conversionOptimizationRouter.get("/experiment-suggestions", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await assertProjectInTenant(req, projectId);
    const db = req.tenantDb!;

    const latestAuditResult = await db.query(
      `SELECT findings FROM landing_page_audits
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY audited_at DESC
       LIMIT 1`,
      [req.tenantId, projectId],
    );
    const latestFindings: LandingPageFinding[] = latestAuditResult.rows[0]?.findings ?? [];

    const dropoff = await computeFunnelDropoff(db, req.tenantId!, projectId);

    const suggestions = generateExperimentSuggestions(latestFindings, dropoff);
    res.json({ suggestions });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------- */
/* Experiments CRUD + results                                            */
/* -------------------------------------------------------------------- */

const createExperimentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  hypothesis: z.string().trim().min(1).max(5000),
  variantADescription: z.string().trim().min(1).max(2000),
  variantBDescription: z.string().trim().min(1).max(2000),
});

const STATUS_VALUES = ["suggested", "running", "completed", "abandoned"] as const;
type ExperimentStatus = (typeof STATUS_VALUES)[number];

// Allowed transitions, enforced at the API layer (same convention as
// campaigns.ts's draft/pending_approval/approved lifecycle).
const ALLOWED_TRANSITIONS: Record<ExperimentStatus, ExperimentStatus[]> = {
  suggested: ["running", "abandoned"],
  running: ["completed", "abandoned"],
  completed: [],
  abandoned: [],
};

const updateExperimentSchema = z.object({
  status: z.enum(STATUS_VALUES),
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization/experiments */
experimentsRouter.get("/experiments", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM experiments WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ experiments: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization/experiments */
experimentsRouter.post("/experiments", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await assertProjectInTenant(req, projectId);
    const body = createExperimentSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO experiments (tenant_id, project_id, name, hypothesis, variant_a_description, variant_b_description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.tenantId, projectId, body.name, body.hypothesis, body.variantADescription, body.variantBDescription],
    );

    res.status(201).json({ experiment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

async function loadExperimentOr404(
  req: import("express").Request,
  projectId: string,
  experimentId: string,
): Promise<{ id: string; status: ExperimentStatus }> {
  const result = await req.tenantDb!.query(
    `SELECT id, status FROM experiments WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [experimentId, req.tenantId, projectId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Experiment not found");
  return result.rows[0];
}

/** PATCH /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization/experiments/:id */
experimentsRouter.patch("/experiments/:id", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await assertProjectInTenant(req, projectId);
    const experimentId = z.string().uuid().parse((req.params as Record<string, string>).id);
    const body = updateExperimentSchema.parse(req.body);

    const existing = await loadExperimentOr404(req, projectId, experimentId);

    if (!ALLOWED_TRANSITIONS[existing.status].includes(body.status)) {
      throw Errors.conflict(
        `Cannot transition experiment from '${existing.status}' to '${body.status}'. Allowed from '${existing.status}': ${
          ALLOWED_TRANSITIONS[existing.status].length > 0 ? ALLOWED_TRANSITIONS[existing.status].join(", ") : "(none — terminal status)"
        }.`,
      );
    }

    const setStartedAt = body.status === "running";
    const setEndedAt = body.status === "completed" || body.status === "abandoned";

    const result = await req.tenantDb!.query(
      `UPDATE experiments
       SET status = $1,
           started_at = CASE WHEN $2 THEN now() ELSE started_at END,
           ended_at = CASE WHEN $3 THEN now() ELSE ended_at END
       WHERE id = $4 AND tenant_id = $5 AND project_id = $6
       RETURNING *`,
      [body.status, setStartedAt, setEndedAt, experimentId, req.tenantId, projectId],
    );

    res.json({ experiment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const recordResultSchema = z.object({
  variant: z.enum(["a", "b"]),
  visitors: z.number().int().min(0),
  conversions: z.number().int().min(0),
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization/experiments/:id/results */
experimentsRouter.post("/experiments/:id/results", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await assertProjectInTenant(req, projectId);
    const experimentId = z.string().uuid().parse((req.params as Record<string, string>).id);
    await loadExperimentOr404(req, projectId, experimentId);
    const body = recordResultSchema.parse(req.body);

    // Validated here (not just left to the DB constraint) so the caller
    // gets a clear 400 with a real message instead of a raw DB error.
    if (body.conversions > body.visitors) {
      throw Errors.badRequest("conversions cannot exceed visitors");
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO experiment_results (tenant_id, experiment_id, variant, visitors, conversions)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.tenantId, experimentId, body.variant, body.visitors, body.conversions],
    );

    res.status(201).json({ result: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Below this many visitors for a variant, a conversion rate is too noisy to
// call a winner on — same spirit as learningLoop.ts's MIN_VARIANT_SAMPLE_SIZE,
// a documented threshold rather than a magic number.
const MIN_SAMPLE_SIZE_PER_VARIANT = 20;

interface VariantAggregateRow {
  variant: "a" | "b";
  total_visitors: string;
  total_conversions: string;
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization/experiments/:id/results */
experimentsRouter.get("/experiments/:id/results", async (req, res, next) => {
  try {
    const projectId = getProjectId(req);
    await assertProjectInTenant(req, projectId);
    const experimentId = z.string().uuid().parse((req.params as Record<string, string>).id);
    await loadExperimentOr404(req, projectId, experimentId);

    const result = await req.tenantDb!.query<VariantAggregateRow>(
      `SELECT variant, SUM(visitors)::text AS total_visitors, SUM(conversions)::text AS total_conversions
       FROM experiment_results
       WHERE tenant_id = $1 AND experiment_id = $2
       GROUP BY variant`,
      [req.tenantId, experimentId],
    );

    const totals: Record<"a" | "b", { visitors: number; conversions: number; conversionRate: number }> = {
      a: { visitors: 0, conversions: 0, conversionRate: 0 },
      b: { visitors: 0, conversions: 0, conversionRate: 0 },
    };
    for (const row of result.rows) {
      const visitors = Number(row.total_visitors);
      const conversions = Number(row.total_conversions);
      totals[row.variant] = {
        visitors,
        conversions,
        conversionRate: visitors > 0 ? conversions / visitors : 0,
      };
    }

    const enoughData =
      totals.a.visitors >= MIN_SAMPLE_SIZE_PER_VARIANT && totals.b.visitors >= MIN_SAMPLE_SIZE_PER_VARIANT;

    if (!enoughData) {
      res.json({ variants: totals, winner: null, note: "not enough data yet" });
      return;
    }

    let winner: "a" | "b" | null = null;
    if (totals.a.conversionRate > totals.b.conversionRate) winner = "a";
    else if (totals.b.conversionRate > totals.a.conversionRate) winner = "b";

    res.json({ variants: totals, winner, note: null });
  } catch (err) {
    next(err);
  }
});
