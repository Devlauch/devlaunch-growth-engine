import { Router } from "express";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { leadInputSchema, ingestLead } from "../lib/leadIngestion.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { runGrowthAnalysis, type GrowthAnalysisResult } from "../lib/growthAnalyzer.js";
import { enqueueReportGeneration } from "../lib/reportQueue.js";
import { INTERNAL_TENANT_ID, INTERNAL_PROJECT_ID } from "../lib/internalGrowthWorkspace.js";

/**
 * Mounted at /api/v1/public (app.ts is off-limits this round — mount this
 * router there alongside the other `/api/v1/public` routers, e.g.
 * `app.use("/api/v1/public/growth", publicCors, publicGrowthRouter)` or
 * folded into the existing publicCors block at the same prefix as
 * publicLeadsRouter).
 *
 * Unauthenticated-by-design public capture for DevLaunch's OWN customer-
 * acquisition site (not a per-tenant embeddable widget like
 * publicLeads.ts/publicLandingPages.ts — there is no project public key
 * here because there is exactly one "project": DevLaunch's own internal
 * workspace, see ../lib/internalGrowthWorkspace.ts). Both endpoints below:
 *
 *  - are rate-limited per IP (see ../middleware/rateLimit.ts — same
 *    fixed-window mechanism as every other public endpoint in this repo),
 *  - include a simple honeypot field (`companyWebsiteConfirm`) that a real
 *    visitor's form never fills in (kept empty/hidden via CSS on the real
 *    form) — if it arrives non-empty, this is treated as an honest "looks
 *    like a bot" signal: the request is accepted with a 201 but NOTHING is
 *    written (no fabricated-looking success record is created either; it's
 *    simply a no-op, not a fake row),
 *  - reuse the EXISTING ingestLead() path for the real lead row (source
 *    "public_widget") — never a second lead-insert path,
 *  - always write into DevLaunch's own internal tenant/project (never a
 *    client tenant's rows), and that tenant is RLS-isolated identically to
 *    every other tenant.
 */
export const publicGrowthRouter = Router();

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

const growthAuditIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicGrowthAuditRateLimitPerIpPerMin,
  name: "public-growth-audit-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});

const demoRequestIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicDemoRequestRateLimitPerIpPerMin,
  name: "public-demo-request-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+\.[a-z]{2,63}$/i, "domain must look like example.com (no protocol, path, or spaces)");

const growthAuditSchema = z.object({
  domain: domainSchema,
  email: z.string().trim().email().max(320),
  // Honeypot: a real visitor's browser never populates this (hidden via CSS
  // on the real form, never shown to a human). Optional so the schema
  // itself never rejects a legitimate submission that omits it.
  companyWebsiteConfirm: z.string().max(500).optional(),
});

/**
 * POST /api/v1/public/growth-audit
 *
 * Triggers a REAL crawl via runGrowthAnalysis() (../lib/growthAnalyzer.ts —
 * the same function routes/growthAnalyzer.ts uses for an authenticated
 * client tenant's own growth analyzer), stores the result in the existing
 * growth_analyses table, creates a real lead via ingestLead(), records the
 * request in growth_audit_requests, and enqueues the existing PDF report
 * pipeline (kind: "growth_audit") so the visitor's "personalised business
 * report" is generated for real, off the real crawl result — never
 * fabricated.
 */
publicGrowthRouter.post("/growth-audit", growthAuditIpLimiter, async (req, res, next) => {
  try {
    const body = growthAuditSchema.parse(req.body ?? {});

    if (body.companyWebsiteConfirm && body.companyWebsiteConfirm.trim().length > 0) {
      logger.warn({ ip: hashIp(req.ip ?? "unknown") }, "public growth-audit honeypot triggered, dropping silently");
      res.status(201).json({ accepted: true });
      return;
    }

    const domain = body.domain.toLowerCase();
    const ipHash = hashIp(req.ip ?? "unknown");

    // Real crawl happens BEFORE any DB client is checked out — it can take
    // several seconds and must never hold a pooled connection/transaction
    // open while it runs.
    const analysis: GrowthAnalysisResult = await runGrowthAnalysis(domain);

    const client = await pool.connect();
    let settled = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [INTERNAL_TENANT_ID]);

      const analysisInsert = await client.query(
        `INSERT INTO growth_analyses (
           tenant_id, project_id, domain, status, pages_discovered, pages_crawled, crawl_error,
           sitemap_found, robots_found, extracted_keywords, products_services, value_propositions,
           target_audience_signals, recommended_icp, content_gaps, conversion_opportunities,
           growth_plan_summary, completed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17, now())
         RETURNING id`,
        [
          INTERNAL_TENANT_ID,
          INTERNAL_PROJECT_ID,
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
          JSON.stringify([]),
          JSON.stringify(analysis.conversionOpportunities),
          analysis.growthPlanSummary,
        ],
      );
      const growthAnalysisId = analysisInsert.rows[0].id as string;

      const lead = await ingestLead({
        client,
        tenantId: INTERNAL_TENANT_ID,
        projectId: INTERNAL_PROJECT_ID,
        input: {
          email: body.email,
          company: domain,
          customFields: { requestType: "growth_audit", domain, growthAnalysisId },
        },
        source: "public_widget",
        origin: req.header("origin") ?? null,
        ipHash,
      });

      const requestInsert = await client.query(
        `INSERT INTO growth_audit_requests (tenant_id, project_id, domain, email, lead_id, growth_analysis_id, status, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [INTERNAL_TENANT_ID, INTERNAL_PROJECT_ID, domain, body.email, lead.id, growthAnalysisId, analysis.status, ipHash],
      );
      const growthAuditRequestId = requestInsert.rows[0].id as string;

      const now = new Date();
      const reportInsert = await client.query(
        `INSERT INTO generated_reports (tenant_id, project_id, schedule_id, status, period_start, period_end, kind, growth_analysis_id, created_by)
         VALUES ($1, $2, NULL, 'queued', $3, $3, 'growth_audit', $4, 'public_growth_audit')
         RETURNING id`,
        [INTERNAL_TENANT_ID, INTERNAL_PROJECT_ID, now.toISOString(), growthAnalysisId],
      );
      const reportId = reportInsert.rows[0].id as string;

      await client.query("COMMIT");
      settled = true;
      client.release();

      try {
        await enqueueReportGeneration({
          reportId,
          tenantId: INTERNAL_TENANT_ID,
          projectId: INTERNAL_PROJECT_ID,
          scheduleId: null,
          periodStart: now.toISOString(),
          periodEnd: now.toISOString(),
          kind: "growth_audit",
          growthAnalysisId,
        });
      } catch (err) {
        logger.error({ err, reportId }, "failed to enqueue growth-audit report generation");
      }

      res.status(201).json({
        growthAuditRequestId,
        status: analysis.status,
        growthPlanSummary: analysis.growthPlanSummary,
        reportId,
      });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  } catch (err) {
    next(err);
  }
});

const demoRequestExtraSchema = z.object({
  companyWebsiteConfirm: z.string().max(500).optional(),
});

/**
 * POST /api/v1/public/demo-request
 *
 * A real "request a demo" form submission. Reuses leadInputSchema +
 * ingestLead() verbatim (source "public_widget"), writes a demo_requests
 * row tied to that real lead, and records an explicit
 * `demo_request.created` audit_events entry (in addition to ingestLead's
 * own `lead.created` entry) so a demo request is independently auditable
 * from a generic lead capture.
 */
publicGrowthRouter.post("/demo-request", demoRequestIpLimiter, async (req, res, next) => {
  try {
    const body = { ...leadInputSchema.parse(req.body), ...demoRequestExtraSchema.parse(req.body ?? {}) };

    if (body.companyWebsiteConfirm && body.companyWebsiteConfirm.trim().length > 0) {
      logger.warn({ ip: hashIp(req.ip ?? "unknown") }, "public demo-request honeypot triggered, dropping silently");
      res.status(201).json({ accepted: true });
      return;
    }
    if (!body.name || !body.email) {
      throw Errors.badRequest("name and email are required");
    }

    const ipHash = hashIp(req.ip ?? "unknown");
    const origin = req.header("origin") ?? null;

    const client = await pool.connect();
    let settled = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [INTERNAL_TENANT_ID]);

      const lead = await ingestLead({
        client,
        tenantId: INTERNAL_TENANT_ID,
        projectId: INTERNAL_PROJECT_ID,
        input: { ...body, customFields: { ...(body.customFields ?? {}), requestType: "demo_request" } },
        source: "public_widget",
        origin,
        ipHash,
      });

      const demoInsert = await client.query(
        `INSERT INTO demo_requests (tenant_id, project_id, name, email, company, message, lead_id, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [INTERNAL_TENANT_ID, INTERNAL_PROJECT_ID, body.name, body.email, body.company ?? null, body.message ?? null, lead.id, ipHash],
      );
      const demoRequestId = demoInsert.rows[0].id as string;

      await client.query(
        `INSERT INTO audit_events (tenant_id, actor_type, action, entity_type, entity_id, metadata)
         VALUES ($1, 'system', 'demo_request.created', 'demo_request', $2, $3::jsonb)`,
        [INTERNAL_TENANT_ID, demoRequestId, JSON.stringify({ lead_id: lead.id, origin })],
      );

      await client.query("COMMIT");
      settled = true;
      client.release();

      res.status(201).json({ demoRequestId, lead: { id: lead.id, createdAt: lead.createdAt } });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  } catch (err) {
    next(err);
  }
});

const growthAuditReportIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicGrowthAuditRateLimitPerIpPerMin * 5,
  name: "public-growth-audit-report-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});

/**
 * GET /api/v1/public/growth-audit/:growthAuditRequestId/report
 *
 * Milestone 7 gap-close: POST /growth-audit (above) queues a real PDF
 * through the EXISTING client-report pipeline (apps/worker/src/reports/
 * growthAuditReportWorker.ts, same generated_reports table/worker/BullMQ
 * queue/file-store as the authenticated per-tenant reports feature —
 * nothing duplicated), but that pipeline's only download route
 * (GET .../reports/:id/download, routes/reports.ts) is authenticated +
 * tenant-membership-gated — an anonymous website visitor can never reach
 * it. This is the small, additive adapter the visitor's own browser polls/
 * downloads from instead.
 *
 * Auth model: `growthAuditRequestId` is a server-generated v4 UUID (~122
 * bits of entropy) returned ONLY in the original POST /growth-audit 201
 * response body to the exact visitor who submitted that request — nothing
 * about it is guessable or enumerable, so it is used directly as the
 * bearer "token" for this one-time public link, the same trust model this
 * codebase already applies to its public per-tenant widget ids
 * (projects.public_key) elsewhere. It is NOT the visitor's email (never
 * trust a client-supplied email as an auth credential) and it is NOT the
 * underlying generated_reports.id (kept as an internal implementation
 * detail, never exposed here). Rate-limited per-IP like every other public
 * endpoint in this router, specifically to blunt brute-force enumeration
 * attempts even though the id space itself is already infeasible to guess.
 */
publicGrowthRouter.get("/growth-audit/:growthAuditRequestId/report", growthAuditReportIpLimiter, async (req, res, next) => {
  try {
    const growthAuditRequestId = z.string().uuid().parse(req.params.growthAuditRequestId);

    // Same RLS-tenant-context pattern as POST /growth-audit above — this
    // pool connects via the non-superuser devlaunch_app role (migration
    // 321_create_app_role.sql), so RLS is genuinely enforced here, not just
    // the WHERE tenant_id filter below (defense in depth, same as every
    // other tenant-scoped query in this codebase).
    const client = await pool.connect();
    let row: { report_id: string | null; status: string | null; file_path: string | null; error: string | null } | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [INTERNAL_TENANT_ID]);
      const result = await client.query(
        `SELECT gar.report_id, gr.status, gr.file_path, gr.error
         FROM growth_audit_requests gar
         LEFT JOIN generated_reports gr ON gr.id = gar.report_id AND gr.tenant_id = gar.tenant_id
         WHERE gar.id = $1 AND gar.tenant_id = $2 AND gar.project_id = $3`,
        [growthAuditRequestId, INTERNAL_TENANT_ID, INTERNAL_PROJECT_ID],
      );
      row = result.rows[0] as typeof row;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (!row) throw Errors.notFound("Growth audit request not found");

    if (!row.report_id || !row.status) {
      res.json({ status: "queued" });
      return;
    }
    if (row.status !== "succeeded") {
      res.json({ status: row.status, error: row.status === "failed" ? row.error : undefined });
      return;
    }
    if (!row.file_path) {
      throw Errors.notFound("Report file is missing");
    }

    // Same path-safety reasoning as routes/reports.ts's authenticated
    // download: file_path is whatever reportFileStore.ts wrote at
    // generation time (tenantId/reportId.pdf), never attacker-controlled.
    const fullPath = path.join(env.reportFilesDir, row.file_path);
    fs.stat(fullPath, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        next(Errors.notFound("Report file is missing on disk"));
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="growth-audit-report.pdf"`);
      res.setHeader("Content-Length", String(stat.size));
      const stream = fs.createReadStream(fullPath);
      stream.on("error", (streamErr) => next(streamErr));
      stream.pipe(res);
    });
  } catch (err) {
    next(err);
  }
});
