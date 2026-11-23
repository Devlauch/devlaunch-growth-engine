import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { clusterKeywords, type KeywordCluster } from "../lib/keywordClustering.js";
import { analyzeInternalLinking } from "../lib/internalLinking.js";
import type { ExtractedKeyword } from "../lib/keywordExtraction.js";

/**
 * SEO campaigns (Phase 5 inbound growth, part A). Intended mount point
 * (app.ts is off-limits this round — mount this router there alongside the
 * other project-scoped routers, same convention as routes/growthAnalyzer.ts):
 *   /api/v1/tenants/:tenantId/projects/:projectId/seo-campaigns
 *
 * A campaign is a tenant picking a deterministic keyword cluster (or a
 * custom set of target keywords) to track content/technical-SEO progress
 * against over time:
 *  - GET /keyword-clusters: clusters this project's own, already-real,
 *    TF-extracted keywords (growth_analyses.extracted_keywords — see
 *    ../lib/growthAnalyzer.ts) via ../lib/keywordClustering.ts's
 *    deterministic (NOT embedding/ML) stem+substring grouping.
 *  - POST /: creates a campaign from a chosen cluster or custom keywords.
 *  - GET /:id: campaign + real progress — content_calendar_items tagged
 *    against it (via content_calendars.seo_campaign_id, see
 *    routes/contentStrategy.ts) and, when a domain is set, the two most
 *    recent seo_audits issue counts for that domain (real technical-SEO
 *    trend, from ../lib/siteAudit.ts via routes/seo.ts — never fabricated).
 *  - POST /:id/internal-link-suggestions: real, concrete internal-linking
 *    suggestions for the campaign's domain (see ../lib/internalLinking.ts),
 *    flagged against whether they match this campaign's target keywords.
 */
export const seoCampaignsRouter = Router({ mergeParams: true });
seoCampaignsRouter.use(requireAuth, requireTenantMembership);

const CAMPAIGN_COLUMNS = `id, tenant_id, project_id, name, domain, target_keywords, source_cluster, status, created_at, updated_at`;

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

async function loadCampaignOr404(req: Request, projectId: string, campaignId: string) {
  const r = await req.tenantDb!.query(
    `SELECT ${CAMPAIGN_COLUMNS} FROM seo_campaigns WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [campaignId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("SEO campaign not found");
  return r.rows[0];
}

/**
 * Loads this project's most recent growth_analyses.extracted_keywords —
 * the real TF keywords already computed by ../lib/growthAnalyzer.ts — as
 * the raw input for clustering. Returns null when no analysis has been run
 * yet (honest "run a growth analysis first" rather than fabricating
 * keywords).
 */
async function loadLatestExtractedKeywords(req: Request, projectId: string): Promise<ExtractedKeyword[] | null> {
  const r = await req.tenantDb!.query(
    `SELECT extracted_keywords FROM growth_analyses
     WHERE tenant_id = $1 AND project_id = $2 AND status <> 'failed'
     ORDER BY created_at DESC LIMIT 1`,
    [req.tenantId, projectId],
  );
  if (r.rowCount === 0) return null;
  return r.rows[0].extracted_keywords as ExtractedKeyword[];
}

/** GET /keyword-clusters — deterministic clusters from this project's latest crawled keywords. */
seoCampaignsRouter.get("/keyword-clusters", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const keywords = await loadLatestExtractedKeywords(req, projectId);
    if (keywords === null) {
      return res.json({
        clusters: [],
        note: "No growth analysis has been run for this project yet — run one (POST .../growth-analyses/analyze) to extract real keywords to cluster.",
      });
    }

    const clusters = clusterKeywords(keywords);
    res.json({
      clusters,
      note: "Clusters are deterministic (stem + shared-substring grouping over real TF-extracted keywords) — not embedding/ML-based semantic clustering.",
    });
  } catch (err) {
    next(err);
  }
});

const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    domain: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9.-]+\.[a-z]{2,63}$/i, "domain must look like example.com")
      .optional(),
    targetKeywords: z.array(z.string().trim().min(1).max(200)).min(1).max(100).optional(),
    clusterKey: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => (v.targetKeywords && v.targetKeywords.length > 0) || v.clusterKey, {
    message: "Provide either targetKeywords or a clusterKey (from GET .../seo-campaigns/keyword-clusters)",
  });

/** POST / — create a campaign from a chosen cluster (by clusterKey) or custom target keywords. */
seoCampaignsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createCampaignSchema.parse(req.body);

    let targetKeywords: string[];
    let sourceCluster: KeywordCluster | null = null;

    if (body.clusterKey) {
      const keywords = await loadLatestExtractedKeywords(req, projectId);
      if (keywords === null) {
        throw Errors.badRequest("No growth analysis available to cluster — run one first, or pass targetKeywords directly.");
      }
      const clusters = clusterKeywords(keywords);
      const match = clusters.find((c) => c.clusterKey === body.clusterKey);
      if (!match) throw Errors.badRequest(`No keyword cluster found with clusterKey "${body.clusterKey}".`);
      sourceCluster = match;
      targetKeywords = match.keywords.map((k) => k.keyword);
    } else {
      targetKeywords = body.targetKeywords!;
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO seo_campaigns (tenant_id, project_id, name, domain, target_keywords, source_cluster)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [
        req.tenantId,
        projectId,
        body.name,
        body.domain ?? null,
        JSON.stringify(targetKeywords),
        sourceCluster ? JSON.stringify(sourceCluster) : null,
      ],
    );

    res.status(201).json({ campaign: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET / — list campaigns for this project. */
seoCampaignsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT ${CAMPAIGN_COLUMNS} FROM seo_campaigns WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    next(err);
  }
});

const patchCampaignSchema = z
  .object({
    status: z.enum(["active", "paused", "completed"]).optional(),
    domain: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9.-]+\.[a-z]{2,63}$/i, "domain must look like example.com")
      .optional(),
  })
  .refine((v) => v.status !== undefined || v.domain !== undefined, {
    message: "At least one of status/domain must be provided",
  });

/** PATCH /:id — update status (active/paused/completed) and/or domain. */
seoCampaignsRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCampaignOr404(req, projectId, campaignId);
    const body = patchCampaignSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE seo_campaigns
       SET status = COALESCE($4, status), domain = COALESCE($5, domain)
       WHERE id = $1 AND tenant_id = $2 AND project_id = $3
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [campaignId, req.tenantId, projectId, body.status ?? null, body.domain ?? null],
    );

    res.json({ campaign: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:id — campaign + real progress:
 *  - contentProgress: content_calendars tagged against this campaign
 *    (seo_campaign_id) and their items' real status breakdown.
 *  - technicalProgress: when campaign.domain is set, the two most recent
 *    seo_audits issue-count snapshots for that domain (real trend, or an
 *    honest "not enough audits yet" when fewer than 2 exist).
 */
seoCampaignsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const campaign = await loadCampaignOr404(req, projectId, campaignId);

    const calendarsResult = await req.tenantDb!.query(
      `SELECT id, name, start_date FROM content_calendars
       WHERE tenant_id = $1 AND project_id = $2 AND seo_campaign_id = $3
       ORDER BY created_at DESC`,
      [req.tenantId, projectId, campaignId],
    );
    const calendarIds: string[] = calendarsResult.rows.map((r: { id: string }) => r.id);

    let itemsTotal = 0;
    let itemsApproved = 0;
    if (calendarIds.length > 0) {
      const itemsResult = await req.tenantDb!.query(
        `SELECT status, count(*)::int AS count FROM content_calendar_items
         WHERE tenant_id = $1 AND calendar_id = ANY($2::uuid[])
         GROUP BY status`,
        [req.tenantId, calendarIds],
      );
      for (const row of itemsResult.rows as Array<{ status: string; count: number }>) {
        itemsTotal += row.count;
        if (row.status === "approved") itemsApproved = row.count;
      }
    }

    let technicalProgress: Record<string, unknown> = {
      status: "no_domain",
      note: "No domain set on this campaign yet — set one (PATCH .../seo-campaigns/:id) to track technical-SEO issue trend.",
    };
    if (campaign.domain) {
      const auditsResult = await req.tenantDb!.query(
        `SELECT broken_links_count, missing_meta_count, audited_at
         FROM seo_audits WHERE tenant_id = $1 AND project_id = $2 AND domain = $3
         ORDER BY audited_at DESC LIMIT 2`,
        [req.tenantId, projectId, campaign.domain],
      );
      const audits = auditsResult.rows as Array<{
        broken_links_count: number;
        missing_meta_count: number;
        audited_at: string;
      }>;
      if (audits.length === 0) {
        technicalProgress = {
          status: "no_audits",
          note: `No seo_audits found for ${campaign.domain} yet — run one (POST .../seo/audits) to start tracking technical-issue trend.`,
        };
      } else {
        const latest = audits[0];
        const previous = audits[1] ?? null;
        technicalProgress = {
          status: previous ? "trend" : "single_audit",
          latestIssueCount: latest.broken_links_count + latest.missing_meta_count,
          latestAuditedAt: latest.audited_at,
          previousIssueCount: previous ? previous.broken_links_count + previous.missing_meta_count : null,
          previousAuditedAt: previous ? previous.audited_at : null,
        };
      }
    }

    res.json({
      campaign,
      contentProgress: {
        calendars: calendarsResult.rows,
        itemsTotal,
        itemsApproved,
      },
      technicalProgress,
    });
  } catch (err) {
    next(err);
  }
});

const internalLinkSuggestionsSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,63}$/i, "domain must look like example.com")
    .optional(),
});

/**
 * POST /:id/internal-link-suggestions — real, concrete internal-linking
 * recommendations for this campaign's domain (../lib/internalLinking.ts),
 * computed from genuinely crawled page content and real `<a href>`
 * presence — never fabricated. Each suggestion is flagged
 * `matchesCampaign: true` when its shared cluster overlaps this campaign's
 * own target_keywords.
 */
seoCampaignsRouter.post("/:id/internal-link-suggestions", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const campaign = await loadCampaignOr404(req, projectId, campaignId);
    const body = internalLinkSuggestionsSchema.parse(req.body ?? {});

    const domain = body.domain ?? campaign.domain;
    if (!domain) {
      throw Errors.badRequest("No domain set on this campaign — pass one in the request body, or PATCH the campaign to set one.");
    }

    const result = await analyzeInternalLinking(domain);
    const targetKeywordSet = new Set((campaign.target_keywords as string[]) ?? []);

    const suggestions = result.suggestions.map((s) => ({
      ...s,
      matchesCampaign: s.sharedKeywords.some((k) => targetKeywordSet.has(k)),
    }));

    res.json({
      domain: result.domain,
      pagesCrawled: result.pagesCrawled,
      suggestions,
      note:
        "Computed from this domain's own crawled pages and real <a href> link presence (sitemap.xml, falling back to the homepage) — never fabricated. matchesCampaign is true when the suggestion's shared cluster overlaps this campaign's target_keywords.",
    });
  } catch (err) {
    next(err);
  }
});
