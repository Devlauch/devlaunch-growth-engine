import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { env } from "../config/env.js";
import { runSiteAudit } from "../lib/siteAudit.js";
import { checkCoreWebVitals } from "../lib/coreWebVitals.js";
import {
  NotConfiguredError,
  generateSeoRecommendations,
  type RankingProvider,
} from "../lib/keywordRankingStub.js";
import { getRankingProvider } from "../lib/serpProvider.js";
import { recordUsageEvent } from "../lib/usageEvents.js";

/**
 * Technical SEO Agent (Phase 2 item 3). Mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/seo.
 *
 * - POST/GET /audits: real, zero-external-account site audits (sitemap,
 *   robots.txt, broken links, metadata — see ../lib/siteAudit.ts) plus an
 *   optional real Core Web Vitals check via Google PageSpeed Insights (see
 *   ../lib/coreWebVitals.ts) when GOOGLE_PAGESPEED_API_KEY is configured.
 * - POST/GET /keyword-rankings: uses getRankingProvider() (../lib/
 *   serpProvider.ts), which resolves a real SerpApi-backed RankingProvider
 *   when SERPAPI_API_KEY is configured, or ../lib/keywordRankingStub.ts's
 *   honest NotConfiguredRankingProvider otherwise — SERP position tracking
 *   requires a paid provider, and no SerpApi key is configured in this
 *   environment, so this always records the request with position: null,
 *   source: 'not_configured' rather than ever fabricating a number.
 */
export const seoRouter = Router({ mergeParams: true });
seoRouter.use(requireAuth, requireTenantMembership);

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

async function loadAuditOr404(req: Request, auditId: string) {
  const r = await req.tenantDb!.query(`SELECT * FROM seo_audits WHERE id = $1 AND tenant_id = $2`, [
    auditId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("SEO audit not found");
  return r.rows[0];
}

const createAuditSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,63}$/i, "domain must look like example.com (no protocol, path, or spaces)"),
});

const createRankingSchema = z.object({
  keyword: z.string().trim().min(1).max(500),
});

/** POST /seo/audits */
seoRouter.post("/audits", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createAuditSchema.parse(req.body);
    const domain = body.domain.toLowerCase();

    const crawl = await runSiteAudit(domain);

    const rootUrl = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
    const cwv = await checkCoreWebVitals(rootUrl, env.googlePageSpeedApiKey);

    const brokenLinksCount = crawl.issues.filter((i) => i.issueType === "broken_link").length;
    const missingMetaCount = crawl.issues.filter(
      (i) => i.issueType === "missing_title" || i.issueType === "missing_meta_description",
    ).length;

    const auditResult = await req.tenantDb!.query(
      `INSERT INTO seo_audits (
         tenant_id, project_id, domain, sitemap_found, robots_found, pages_checked,
         broken_links_count, missing_meta_count, core_web_vitals, core_web_vitals_status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        domain,
        crawl.sitemapFound,
        crawl.robotsFound,
        crawl.pagesChecked,
        brokenLinksCount,
        missingMetaCount,
        cwv.data ? JSON.stringify({ ...cwv.data, error: cwv.error }) : cwv.error ? JSON.stringify({ error: cwv.error }) : null,
        cwv.status,
      ],
    );
    const audit = auditResult.rows[0];

    const issueRows = [];
    for (const issue of crawl.issues) {
      const r = await req.tenantDb!.query(
        `INSERT INTO seo_audit_issues (tenant_id, audit_id, issue_type, url, detail, severity)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [req.tenantId, audit.id, issue.issueType, issue.url, issue.detail, issue.severity],
      );
      issueRows.push(r.rows[0]);
    }

    const recommendations = generateSeoRecommendations(
      {
        sitemap_found: audit.sitemap_found,
        robots_found: audit.robots_found,
        pages_checked: audit.pages_checked,
        broken_links_count: audit.broken_links_count,
        missing_meta_count: audit.missing_meta_count,
        core_web_vitals_status: audit.core_web_vitals_status,
        core_web_vitals: audit.core_web_vitals,
      },
      crawl.issues,
    );

    res.status(201).json({ audit, issues: issueRows, recommendations });
  } catch (err) {
    next(err);
  }
});

/** GET /seo/audits */
seoRouter.get("/audits", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM seo_audits WHERE tenant_id = $1 AND project_id = $2 ORDER BY audited_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ audits: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /seo/audits/:id */
seoRouter.get("/audits/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const auditId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const audit = await loadAuditOr404(req, auditId);
    if (audit.project_id !== projectId) throw Errors.notFound("SEO audit not found");

    const issuesResult = await req.tenantDb!.query(
      `SELECT * FROM seo_audit_issues WHERE audit_id = $1 AND tenant_id = $2 ORDER BY severity ASC, created_at ASC`,
      [auditId, req.tenantId],
    );

    const recommendations = generateSeoRecommendations(
      {
        sitemap_found: audit.sitemap_found,
        robots_found: audit.robots_found,
        pages_checked: audit.pages_checked,
        broken_links_count: audit.broken_links_count,
        missing_meta_count: audit.missing_meta_count,
        core_web_vitals_status: audit.core_web_vitals_status,
        core_web_vitals: audit.core_web_vitals,
      },
      issuesResult.rows,
    );

    res.json({ audit, issues: issuesResult.rows, recommendations });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /seo/keyword-rankings
 *
 * Uses getRankingProvider() (../lib/serpProvider.ts): a real
 * SerpApiRankingProvider when SERPAPI_API_KEY is configured, or the honest
 * NotConfiguredRankingProvider (always throws NotConfiguredError)
 * otherwise — either way, caught here and turned into an honest 202 record
 * (position: null, source: 'not_configured' when not configured) rather
 * than a 500 or a fabricated position.
 */
seoRouter.post("/keyword-rankings", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createRankingSchema.parse(req.body);

    const provider: RankingProvider = getRankingProvider();
    let position: number | null = null;
    let source = "not_configured";
    try {
      const result = await provider.checkRanking(body.keyword, projectId);
      position = result.position;
      source = result.source;
      if (source === "serpapi") {
        await recordUsageEvent({
          client: req.tenantDb!,
          tenantId: req.tenantId!,
          projectId,
          eventType: "serp_api_request",
          metadata: { keyword: body.keyword },
        });
      }
    } catch (err) {
      if (!(err instanceof NotConfiguredError)) {
        await recordUsageEvent({
          client: req.tenantDb!,
          tenantId: req.tenantId!,
          projectId,
          eventType: "serp_request_failed",
          metadata: { keyword: body.keyword, error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
      // Expected when SERPAPI_API_KEY is not configured in this
      // environment. Record the request honestly rather than failing.
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO keyword_rankings (tenant_id, project_id, keyword, position, source)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.tenantId, projectId, body.keyword, position, source],
    );

    res.status(202).json({
      ranking: result.rows[0],
      note:
        "Keyword rank tracking requires a paid SERP provider — not configured. This records the request for when one is wired in.",
    });
  } catch (err) {
    next(err);
  }
});

/** GET /seo/keyword-rankings */
seoRouter.get("/keyword-rankings", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM keyword_rankings WHERE tenant_id = $1 AND project_id = $2 ORDER BY checked_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ keywordRankings: result.rows });
  } catch (err) {
    next(err);
  }
});
