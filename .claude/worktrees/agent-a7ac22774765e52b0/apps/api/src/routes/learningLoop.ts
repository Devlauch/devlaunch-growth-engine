import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * learningLoopRouter: mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/learning-loop
 *
 * Roadmap item 17, "Learning loop": compare which message variants and
 * segments get replies, and show the winners to the user. After 30-50
 * outcomes, review the scoring rubric against real wins.
 *
 * Both endpoints here run real comparison SQL against real tables. Neither
 * fabricates sample data: until there is enough real reply/feedback volume,
 * they say so honestly instead of presenting a misleading rate computed
 * from a handful of rows.
 */
export const learningLoopRouter = Router({ mergeParams: true });
learningLoopRouter.use(requireAuth, requireTenantMembership);

async function assertProjectInTenant(req: import("express").Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

function isMissingRelationError(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === "42P01";
}

// Below this total number of leads contacted (summed across channels), a
// per-channel reply rate is too noisy to be meaningful — a single reply on
// 2 sends would show as a 50% rate. Documented threshold, not a magic
// number: this is the smallest sample size we consider worth showing a
// rate for at all (the rubric-review threshold below, 30, is a separate,
// larger bar for "review the scoring rubric itself").
const MIN_VARIANT_SAMPLE_SIZE = 5;

// Roadmap item 17: "after 30-50 outcomes, review the scoring rubric
// against real wins." We use the low end of that range as the point at
// which we tell the user review is worthwhile.
const RUBRIC_REVIEW_THRESHOLD = 30;

interface VariantPerformanceRow {
  channel: string;
  total_variants: string;
  leads_contacted: string;
  leads_replied_interested: string;
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/learning-loop/variant-performance */
learningLoopRouter.get("/variant-performance", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);
    const db = req.tenantDb!;

    try {
      // Best-effort proxy for "sent": approved message_drafts (nothing in
      // this codebase actually dispatches mail yet — see
      // src/lib/integrations.ts's not-connected registry — so "approved"
      // is the closest real signal of "a human signed off on sending
      // this"). Reply signal: lead_replies rows classified 'interested'
      // for the same lead.
      const result = await db.query<VariantPerformanceRow>(
        `WITH variant_totals AS (
           SELECT mdv.channel,
                  COUNT(*) AS total_variants,
                  COUNT(DISTINCT md.lead_id) AS leads_contacted
           FROM message_draft_variants mdv
           JOIN message_drafts md
             ON md.id = mdv.message_draft_id AND md.tenant_id = mdv.tenant_id
           WHERE md.tenant_id = $1 AND md.project_id = $2 AND md.status = 'approved'
           GROUP BY mdv.channel
         ),
         reply_totals AS (
           SELECT mdv.channel,
                  COUNT(DISTINCT lr.lead_id) AS leads_replied_interested
           FROM message_draft_variants mdv
           JOIN message_drafts md
             ON md.id = mdv.message_draft_id AND md.tenant_id = mdv.tenant_id
           JOIN lead_replies lr
             ON lr.lead_id = md.lead_id AND lr.tenant_id = md.tenant_id AND lr.classification = 'interested'
           WHERE md.tenant_id = $1 AND md.project_id = $2 AND md.status = 'approved'
           GROUP BY mdv.channel
         )
         SELECT vt.channel, vt.total_variants, vt.leads_contacted,
                COALESCE(rt.leads_replied_interested, 0) AS leads_replied_interested
         FROM variant_totals vt
         LEFT JOIN reply_totals rt ON rt.channel = vt.channel
         ORDER BY vt.channel`,
        [req.tenantId, projectId],
      );

      const totalLeadsContacted = result.rows.reduce((sum, row) => sum + Number(row.leads_contacted), 0);

      if (totalLeadsContacted < MIN_VARIANT_SAMPLE_SIZE) {
        res.json({ channels: [], note: "not enough data yet" });
        return;
      }

      const channels = result.rows.map((row) => {
        const leadsContacted = Number(row.leads_contacted);
        const leadsRepliedInterested = Number(row.leads_replied_interested);
        return {
          channel: row.channel,
          totalVariants: Number(row.total_variants),
          leadsContacted,
          leadsRepliedInterested,
          replyRate: leadsContacted > 0 ? leadsRepliedInterested / leadsContacted : 0,
        };
      });

      res.json({ channels, note: null });
    } catch (err) {
      if (isMissingRelationError(err)) {
        res.json({ channels: [], note: "not enough data yet" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/learning-loop/rubric-review-readiness */
learningLoopRouter.get("/rubric-review-readiness", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);
    const db = req.tenantDb!;

    try {
      const result = await db.query<{ feedback: string; count: string }>(
        `SELECT lsf.feedback, COUNT(*) AS count
         FROM lead_score_feedback lsf
         JOIN leads l ON l.id = lsf.lead_id
         WHERE lsf.tenant_id = $1 AND l.project_id = $2
         GROUP BY lsf.feedback`,
        [req.tenantId, projectId],
      );

      let goodCount = 0;
      let badCount = 0;
      for (const row of result.rows) {
        if (row.feedback === "good") goodCount = Number(row.count);
        if (row.feedback === "bad") badCount = Number(row.count);
      }
      const feedbackCount = goodCount + badCount;

      res.json({
        feedbackCount,
        readyForReview: feedbackCount >= RUBRIC_REVIEW_THRESHOLD,
        goodCount,
        badCount,
      });
    } catch (err) {
      if (isMissingRelationError(err)) {
        res.json({ feedbackCount: 0, readyForReview: false, goodCount: 0, badCount: 0 });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});
