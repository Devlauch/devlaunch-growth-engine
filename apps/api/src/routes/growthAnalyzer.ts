import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import {
  runGrowthAnalysis,
  computeContentGaps,
  buildGrowthPlanSummary,
  type GrowthAnalysisResult,
} from "../lib/growthAnalyzer.js";
import type { ExtractedKeyword } from "../lib/keywordExtraction.js";

/**
 * AI Website Growth Analyzer (DevLaunch Growth Engine, feature 1). Intended
 * mount point (app.ts is off-limits this round — mount this router there
 * alongside the other project-scoped routers):
 *   /api/v1/tenants/:tenantId/projects/:projectId/growth-analyses
 *
 * - POST /analyze: crawls the given domain (reusing ../lib/crawl4aiClient.ts
 *   + ../lib/siteAudit.ts), runs deterministic extraction/recommendation
 *   heuristics (../lib/growthAnalyzer.ts), diffs against this project's
 *   tracked competitors' latest crawled keywords (routes/competitors.ts /
 *   competitor_snapshots — reused, not re-crawled here) for content gaps,
 *   and persists one growth_analyses row + its growth_recommendations rows.
 * - GET /: lists past analyses for the project.
 * - GET /:id: one analysis + its recommendations.
 * - POST /:id/accept-icp: copies the analysis's 'icp' recommendation into
 *   the EXISTING icp_profiles table (007_create_icp_profiles.sql) — never a
 *   second ICP table/column. The suggested industries/geographies/segments
 *   are folded into icp_profiles.firmographics (jsonb), tagged
 *   `source: "growth_analyzer"`, since icp_profiles has no dedicated
 *   `source` column and routes/icpProfiles.ts is read-only for this round.
 */
export const growthAnalyzerRouter = Router({ mergeParams: true });
growthAnalyzerRouter.use(requireAuth, requireTenantMembership);

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

async function loadAnalysisOr404(req: Request, projectId: string, analysisId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM growth_analyses WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [analysisId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Growth analysis not found");
  return r.rows[0];
}

const analyzeSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,63}$/i, "domain must look like example.com (no protocol, path, or spaces)"),
});

/**
 * Loads this project's tracked competitors' latest crawled keywords (from
 * competitor_snapshots, populated by POST .../competitors/:id/crawl — see
 * routes/competitors.ts) so content gaps are computed from real, previously
 * crawled competitor data rather than crawling competitors again here.
 */
async function loadCompetitorKeywordSets(
  req: Request,
  projectId: string,
): Promise<Array<{ competitorName: string; keywords: ExtractedKeyword[] }>> {
  const result = await req.tenantDb!.query(
    `SELECT c.name AS competitor_name, s.extracted_keywords
     FROM competitors c
     JOIN LATERAL (
       SELECT extracted_keywords FROM competitor_snapshots
       WHERE competitor_id = c.id AND tenant_id = c.tenant_id
       ORDER BY crawled_at DESC LIMIT 1
     ) s ON true
     WHERE c.tenant_id = $1 AND c.project_id = $2`,
    [req.tenantId, projectId],
  );
  return result.rows.map((row: { competitor_name: string; extracted_keywords: ExtractedKeyword[] }) => ({
    competitorName: row.competitor_name,
    keywords: row.extracted_keywords,
  }));
}

/** POST /analyze */
growthAnalyzerRouter.post("/analyze", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = analyzeSchema.parse(req.body);
    const domain = body.domain.toLowerCase();

    const analysis: GrowthAnalysisResult = await runGrowthAnalysis(domain);

    const competitorKeywordSets = await loadCompetitorKeywordSets(req, projectId);
    const contentGaps = computeContentGaps(analysis.extractedKeywords, competitorKeywordSets);

    // Rebuild the summary with the real content-gap count now available
    // (runGrowthAnalysis itself has no DB access, so it summarizes with 0).
    const growthPlanSummary = buildGrowthPlanSummary({
      domain,
      pagesCrawled: analysis.pagesCrawled,
      recommendedIcp: analysis.recommendedIcp,
      productsServices: analysis.productsServices,
      valuePropositions: analysis.valuePropositions,
      contentGapsCount: contentGaps.length,
      conversionOpportunities: analysis.conversionOpportunities,
    });

    const insertResult = await req.tenantDb!.query(
      `INSERT INTO growth_analyses (
         tenant_id, project_id, domain, status, pages_discovered, pages_crawled, crawl_error,
         sitemap_found, robots_found, extracted_keywords, products_services, value_propositions,
         target_audience_signals, recommended_icp, content_gaps, conversion_opportunities,
         growth_plan_summary, completed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17, now())
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        domain,
        analysis.status,
        analysis.pagesDiscovered,
        analysis.pagesCrawled,
        analysis.crawlError,
        analysis.sitemapFound,
        analysis.robotsFound,
        JSON.stringify(analysis.extractedKeywords),
        JSON.stringify(analysis.productsServices),
        JSON.stringify(analysis.valuePropositions),
        JSON.stringify(analysis.targetAudienceSignals),
        JSON.stringify(analysis.recommendedIcp),
        JSON.stringify(contentGaps),
        JSON.stringify(analysis.conversionOpportunities),
        growthPlanSummary,
      ],
    );
    const growthAnalysis = insertResult.rows[0];

    const recommendations: unknown[] = [];

    const icpRec = await req.tenantDb!.query(
      `INSERT INTO growth_recommendations (tenant_id, project_id, growth_analysis_id, recommendation_type, title, detail)
       VALUES ($1, $2, $3, 'icp', $4, $5::jsonb)
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        growthAnalysis.id,
        `Recommended ICP for ${domain}`,
        JSON.stringify(analysis.recommendedIcp),
      ],
    );
    recommendations.push(icpRec.rows[0]);

    for (const gap of contentGaps) {
      const gapRec = await req.tenantDb!.query(
        `INSERT INTO growth_recommendations (tenant_id, project_id, growth_analysis_id, recommendation_type, title, detail)
         VALUES ($1, $2, $3, 'content_gap', $4, $5::jsonb)
         RETURNING *`,
        [
          req.tenantId,
          projectId,
          growthAnalysis.id,
          `Content gap vs. ${gap.competitorName}`,
          JSON.stringify(gap),
        ],
      );
      recommendations.push(gapRec.rows[0]);
    }

    const highSeverityIssues = analysis.conversionOpportunities.filter((i) => i.severity === "high");
    if (highSeverityIssues.length > 0) {
      const convRec = await req.tenantDb!.query(
        `INSERT INTO growth_recommendations (tenant_id, project_id, growth_analysis_id, recommendation_type, title, detail)
         VALUES ($1, $2, $3, 'conversion_opportunity', $4, $5::jsonb)
         RETURNING *`,
        [
          req.tenantId,
          projectId,
          growthAnalysis.id,
          `${highSeverityIssues.length} high-severity technical issue(s) found`,
          JSON.stringify(highSeverityIssues),
        ],
      );
      recommendations.push(convRec.rows[0]);
    }

    res.status(201).json({ analysis: growthAnalysis, recommendations });
  } catch (err) {
    next(err);
  }
});

/** GET / */
growthAnalyzerRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM growth_analyses WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ analyses: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /:id */
growthAnalyzerRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const analysisId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const analysis = await loadAnalysisOr404(req, projectId, analysisId);

    const recommendationsResult = await req.tenantDb!.query(
      `SELECT * FROM growth_recommendations WHERE growth_analysis_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [analysisId, req.tenantId],
    );

    res.json({ analysis, recommendations: recommendationsResult.rows });
  } catch (err) {
    next(err);
  }
});

const acceptIcpSchema = z
  .object({
    recommendationId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .optional();

/**
 * POST /:id/accept-icp
 *
 * Copies this analysis's 'icp' growth_recommendations row into a new
 * icp_profiles row (same shape routes/icpProfiles.ts's own POST / accepts —
 * see that file's createIcpSchema, read but not edited this round).
 * industries/geographies/segments + the recommendation rationale are folded
 * into icp_profiles.firmographics as structured, human-reviewable data
 * (never auto-applied without this explicit accept call).
 */
growthAnalyzerRouter.post("/:id/accept-icp", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const analysisId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const analysis = await loadAnalysisOr404(req, projectId, analysisId);
    const body = acceptIcpSchema.parse(req.body ?? {}) ?? {};

    const recQuery = body.recommendationId
      ? await req.tenantDb!.query(
          `SELECT * FROM growth_recommendations
           WHERE id = $1 AND growth_analysis_id = $2 AND tenant_id = $3 AND recommendation_type = 'icp'`,
          [body.recommendationId, analysisId, req.tenantId],
        )
      : await req.tenantDb!.query(
          `SELECT * FROM growth_recommendations
           WHERE growth_analysis_id = $1 AND tenant_id = $2 AND recommendation_type = 'icp'
           ORDER BY created_at ASC LIMIT 1`,
          [analysisId, req.tenantId],
        );
    if (recQuery.rowCount === 0) throw Errors.notFound("No ICP recommendation found for this analysis");
    const recommendation = recQuery.rows[0];
    if (recommendation.accepted) throw Errors.conflict("This ICP recommendation has already been accepted");

    const detail = recommendation.detail as {
      industries: string[];
      geographies: string[];
      segments: string[];
      rationale: string;
    };

    const name = body.name ?? `Growth Analyzer suggestion — ${analysis.domain}`;
    const segment = detail.segments[0] ?? null;

    const icpResult = await req.tenantDb!.query(
      `INSERT INTO icp_profiles (tenant_id, project_id, name, segment, description, pain_points, channels, firmographics, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        name,
        segment,
        detail.rationale,
        [],
        [],
        JSON.stringify({
          source: "growth_analyzer",
          growthAnalysisId: analysisId,
          industries: detail.industries,
          geographies: detail.geographies,
          segments: detail.segments,
        }),
        false,
      ],
    );
    const icpProfile = icpResult.rows[0];

    const updatedRec = await req.tenantDb!.query(
      `UPDATE growth_recommendations SET accepted = true, accepted_at = now(), accepted_icp_profile_id = $1
       WHERE id = $2 RETURNING *`,
      [icpProfile.id, recommendation.id],
    );

    res.status(201).json({ icpProfile, recommendation: updatedRec.rows[0] });
  } catch (err) {
    next(err);
  }
});
