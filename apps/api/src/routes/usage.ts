import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/usage
 *
 * Real usage tracking, same "never fabricated" rule as analytics.ts: every
 * number here is a direct SQL aggregate over usage_events (packages/db
 * migrations 230/231), written at the actual point each real event
 * happens — see src/lib/usageEvents.ts, src/routes/agentRuns.ts (agent_run,
 * on queue), src/lib/leadIngestion.ts (lead_captured, on real lead
 * capture, internal + public widget), and src/lib/usageTracking.ts
 * (api_request, batched/periodic — see its doc comment for why it isn't a
 * synchronous insert per request).
 *
 * ai_tokens is intentionally never populated: no agent executor in this
 * codebase (apps/worker/src/agents/*) currently returns a real token
 * count — market-research is a Phase 1 mock stub with no live LLM call at
 * all (see marketResearch.ts's `mock: true` output). Rather than invent a
 * number, that event_type simply has zero rows today, and this endpoint
 * reports it as an honest empty/zero bucket — exactly like any other
 * category with no data — never an estimated one.
 */
export const usageRouter = Router({ mergeParams: true });
usageRouter.use(requireAuth, requireTenantMembership);

const EVENT_TYPES = ["agent_run", "api_request", "lead_captured", "ai_tokens"] as const;
type UsageEventType = (typeof EVENT_TYPES)[number];

interface ByTypeRow {
  event_type: UsageEventType;
  count: number;
  quantity: string;
}

interface PerDayRow {
  day: string;
  event_type: UsageEventType;
  quantity: string;
}

/** GET /api/v1/tenants/:tenantId/usage/overview */
usageRouter.get("/overview", async (req, res, next) => {
  try {
    const tenantId = req.tenantId as string;

    const [byType, perDay] = await Promise.all([
      req.tenantDb!.query<ByTypeRow>(
        `SELECT event_type, count(*)::int AS count, coalesce(sum(quantity), 0)::text AS quantity
         FROM usage_events
         WHERE tenant_id = $1
         GROUP BY event_type
         ORDER BY event_type`,
        [tenantId],
      ),
      req.tenantDb!.query<PerDayRow>(
        `SELECT date_trunc('day', created_at)::date AS day, event_type, coalesce(sum(quantity), 0)::text AS quantity
         FROM usage_events
         WHERE tenant_id = $1 AND created_at >= now() - interval '30 days'
         GROUP BY day, event_type
         ORDER BY day, event_type`,
        [tenantId],
      ),
    ]);

    // Every event_type is represented in the summary (so the dashboard can
    // render a real, honest zero for a category with no data yet) — but
    // only from rows that actually came back from the query above, never
    // padded with an invented history.
    const summary = Object.fromEntries(
      EVENT_TYPES.map((eventType) => {
        const row = byType.rows.find((r) => r.event_type === eventType);
        return [eventType, { count: row?.count ?? 0, quantity: row ? Number(row.quantity) : 0 }];
      }),
    ) as Record<UsageEventType, { count: number; quantity: number }>;

    res.json({
      summary,
      perDay: perDay.rows.map((r) => ({ day: r.day, eventType: r.event_type, quantity: Number(r.quantity) })),
    });
  } catch (err) {
    next(err);
  }
});
