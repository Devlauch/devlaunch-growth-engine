import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/priority-queue
 *
 * Roadmap item 8, "Priority queue": sort leads by score and freshness so the
 * team works the best leads first. Reads leads LEFT JOINed with lead_scores
 * (packages/db migrations 031-034, owned by the scoring-rubric agent — this
 * file only depends on the agreed table/column contract: lead_scores.lead_id
 * REFERENCES leads(id) UNIQUE, total_score numeric, why_summary,
 * next_research_note, computed_at). A lead with no row yet in lead_scores is
 * still real, current pipeline state (an unscored "new" lead), so it is
 * never excluded or errored on — it sorts after every scored lead via
 * `NULLS LAST`, with leads.created_at DESC as the freshness tiebreaker.
 *
 * Every number here is a real SQL aggregate/count — no fabricated totals or
 * placeholder rows (same honesty convention as analytics.ts / leads.ts).
 */
export const priorityQueueRouter = Router({ mergeParams: true });
priorityQueueRouter.use(requireAuth, requireTenantMembership);

const LEAD_STATUSES = ["new", "qualified", "rejected", "approved_for_outreach", "archived"] as const;

// page/pageSize and /today's limit are clamped (capped), not rejected, when
// they exceed their max — only minScore/status are hard-validated, since
// those are filter correctness, not pagination size.
const listQuerySchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .default(25)
    .transform((v) => Math.min(v, 100)),
});

const todayQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(10)
    .transform((v) => Math.min(v, 50)),
});

async function assertProjectInTenant(req: import("express").Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

interface PriorityQueueRow {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  status: string;
  source: string;
  created_at: string;
  total_score: string | number | null;
  why_summary: string | null;
  next_research_note: string | null;
  computed_at: string | null;
}

function toLeadShape(row: PriorityQueueRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    score:
      row.total_score === null || row.total_score === undefined
        ? null
        : {
            totalScore: Number(row.total_score),
            whySummary: row.why_summary,
            nextResearchNote: row.next_research_note,
            computedAt: row.computed_at,
          },
  };
}

/**
 * GET /api/v1/tenants/:tenantId/projects/:projectId/priority-queue
 *
 * Query params: status (optional, one of the leads.status check-constraint
 * values), minScore (optional, 0-100 — applies to lead_scores.total_score;
 * unscored leads naturally fall out of this filter since NULL never
 * satisfies a >= threshold), page (default 1), pageSize (default 25, max
 * 100).
 */
priorityQueueRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);
    const query = listQuerySchema.parse(req.query);

    const conditions = ["leads.tenant_id = $1", "leads.project_id = $2"];
    const params: unknown[] = [req.tenantId, projectId];

    if (query.status) {
      params.push(query.status);
      conditions.push(`leads.status = $${params.length}`);
    }
    if (query.minScore !== undefined) {
      params.push(query.minScore);
      conditions.push(`lead_scores.total_score >= $${params.length}`);
    }

    const whereClause = conditions.join(" AND ");

    const countResult = await req.tenantDb!.query(
      `SELECT count(*)::int AS count
       FROM leads
       LEFT JOIN lead_scores ON lead_scores.lead_id = leads.id
       WHERE ${whereClause}`,
      params,
    );
    const total = countResult.rows[0]?.count ?? 0;

    const limitParamIndex = params.length + 1;
    const offsetParamIndex = params.length + 2;
    const rowsResult = await req.tenantDb!.query<PriorityQueueRow>(
      `SELECT leads.id, leads.name, leads.email, leads.company, leads.status, leads.source, leads.created_at,
              lead_scores.total_score, lead_scores.why_summary, lead_scores.next_research_note, lead_scores.computed_at
       FROM leads
       LEFT JOIN lead_scores ON lead_scores.lead_id = leads.id
       WHERE ${whereClause}
       ORDER BY lead_scores.total_score DESC NULLS LAST, leads.created_at DESC
       LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    );

    res.json({
      leads: rowsResult.rows.map(toLeadShape),
      page: query.page,
      pageSize: query.pageSize,
      total,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tenants/:tenantId/projects/:projectId/priority-queue/today
 *
 * "Today's top leads to contact" — a daily working list for a sales rep.
 * Only leads that already have a score AND are still actionable (status NOT
 * IN approved_for_outreach/archived/rejected), ordered by total_score DESC,
 * limited by `limit` (default 10, max 50). Includes score.computedAt so
 * staleness is visible. If nothing is scored yet, returns an empty array —
 * never a placeholder row or a fabricated count.
 */
priorityQueueRouter.get("/today", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);
    const query = todayQuerySchema.parse(req.query);

    const result = await req.tenantDb!.query<PriorityQueueRow>(
      `SELECT leads.id, leads.name, leads.email, leads.company, leads.status, leads.source, leads.created_at,
              lead_scores.total_score, lead_scores.why_summary, lead_scores.next_research_note, lead_scores.computed_at
       FROM leads
       JOIN lead_scores ON lead_scores.lead_id = leads.id
       WHERE leads.tenant_id = $1 AND leads.project_id = $2
         AND leads.status NOT IN ('approved_for_outreach', 'archived', 'rejected')
       ORDER BY lead_scores.total_score DESC
       LIMIT $3`,
      [req.tenantId, projectId, query.limit],
    );

    res.json({
      leads: result.rows.map(toLeadShape),
    });
  } catch (err) {
    next(err);
  }
});
