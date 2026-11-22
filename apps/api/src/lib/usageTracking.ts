import type { Request, Response, NextFunction } from "express";
import type pg from "pg";
import { logger } from "./logger.js";

/**
 * api_request usage instrumentation.
 *
 * A synchronous DB insert on every single API request would double the
 * query volume on the hottest path in this app, for a metric that only
 * ever needs to be approximately real-time (a usage dashboard, refreshed
 * on page load). This follows the exact precedent already in this
 * codebase — src/middleware/rateLimit.ts's in-process fixed-window
 * counter, explicitly documented there as "good enough for Phase 1 / a
 * single worker process": an in-memory Map, incremented per request, then
 * drained by a periodic batch INSERT (one usage_events row per tenant per
 * flush interval, quantity = request count in that window).
 *
 * This does NOT use BullMQ/Redis for the flush itself: the only existing
 * BullMQ usage in this codebase (src/lib/queue.ts) is a point-to-point job
 * queue for agent runs, not a repeatable/cron job — there is no
 * existing scheduled-job pattern to piggyback on, and standing one up
 * just to flush an in-memory counter would be more moving parts than the
 * problem needs. Exactly like rateLimit.ts, a genuine multi-instance
 * deployment should swap this Map for Redis INCR (ioredis is already a
 * dependency via REDIS_URL) without changing any call site.
 */
const TENANT_ID_FROM_PATH_RE =
  /^\/api\/v1\/tenants\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/;

const pendingCounts = new Map<string, number>();

/**
 * Mounted once, globally, in app.ts (before any router), since a request's
 * :tenantId route param isn't populated until Express matches a specific
 * router — but every tenant-scoped route in this app follows the fixed
 * /api/v1/tenants/:tenantId/... prefix, so a plain path regex is enough to
 * attribute the request to a tenant without needing req.params.
 */
export function apiRequestCounterMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const match = TENANT_ID_FROM_PATH_RE.exec(req.path);
  if (match) {
    const tenantId = match[1];
    pendingCounts.set(tenantId, (pendingCounts.get(tenantId) ?? 0) + 1);
  }
  next();
}

/** Drains and returns the current in-memory counts without touching the DB (used by the flush + by tests). */
export function drainPendingApiRequestCounts(): Map<string, number> {
  const snapshot = new Map(pendingCounts);
  pendingCounts.clear();
  return snapshot;
}

type TenantContextRunner = <T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;

/** Flushes whatever request counts have accumulated since the last flush into one usage_events row per tenant. */
export async function flushApiRequestCounts(withTenantContext: TenantContextRunner): Promise<void> {
  const counts = drainPendingApiRequestCounts();
  if (counts.size === 0) return;

  for (const [tenantId, quantity] of counts) {
    try {
      await withTenantContext(tenantId, async (client) => {
        await client.query(
          `INSERT INTO usage_events (tenant_id, event_type, quantity, metadata)
           VALUES ($1, 'api_request', $2, $3::jsonb)`,
          [tenantId, quantity, JSON.stringify({ flushedAt: new Date().toISOString() })],
        );
      });
    } catch (err) {
      // A failed flush must never crash the process or lose future counts
      // — the counter for this tenant simply resumes accumulating from 0
      // and the next flush tries again. We do lose this window's count,
      // which is an acceptable trade-off for an approximate usage metric
      // backed by an in-memory counter (same trade-off rateLimit.ts makes).
      logger.error({ err, tenantId }, "failed to flush api_request usage count");
    }
  }
}

let flushInterval: ReturnType<typeof setInterval> | null = null;

export function startApiRequestUsageFlush(withTenantContext: TenantContextRunner, intervalMs = 30_000): void {
  if (flushInterval) return;
  flushInterval = setInterval(() => {
    void flushApiRequestCounts(withTenantContext);
  }, intervalMs);
  flushInterval.unref?.();
}

export function stopApiRequestUsageFlush(): void {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}
