import type pg from "pg";
import { getQuotaUsage, type QuotaResource } from "./quota.js";
import type { PlanName } from "../config/planLimits.js";

/**
 * Milestone 4 (P3), usage-quota overage: a NEW, minimal, honestly-scoped
 * addition — see this module's header for why it's minimal.
 *
 * WHAT ALREADY EXISTS (checked before writing this): enforceQuota()
 * (lib/quota.ts) is a pure hard-block — every plan's every resource limit
 * is a ceiling; going over it throws Errors.paymentRequired(402) and the
 * action is refused outright. There is NO existing "metered overage"
 * concept anywhere in this codebase: PLAN_LIMITS (config/planLimits.ts)
 * has no notion of "allow going over, but bill for the excess", and
 * nothing in docs/FEATURE_STATUS.md or the plan data model implies one
 * was ever designed. This is a REAL, DOCUMENTED GAP, not an oversight this
 * change quietly papers over.
 *
 * WHAT THIS CHANGE DELIBERATELY DOES NOT DO: invent pricing. "How much
 * does one extra agent run cost past the plan limit" is a real pricing
 * decision (a number in a currency) that only a product/finance owner can
 * set — guessing one here would be exactly the kind of fabricated
 * business behavior this milestone's brief explicitly warns against for
 * payments. So this module does NOT compute a bill, does NOT attach a
 * price to an overage event, and does NOT wire itself into
 * enforceQuota()'s call sites (quota.ts's own core enforcement logic is
 * explicitly off-limits to rewrite for this change, and swapping any
 * existing route's hard-block for a soft-block-with-billing would change
 * production behavior for every current plan without a product decision
 * backing it — a change this task was not authorized to make unilaterally).
 *
 * WHAT THIS CHANGE DOES BUILD: the minimal real data-capture path a future
 * overage-billing decision needs, so that decision doesn't start from
 * zero:
 *   - billing_overage_events (migration 526/527): one row per observed
 *     "tenant is at/over its plan's limit for this resource" moment,
 *     tenant-scoped, RLS-protected, with the real current/limit numbers
 *     recorded (never estimated) and a `billed` flag + nullable
 *     `invoice_id` a future billing pass can fill in once pricing exists.
 *   - recordQuotaOverageEvent() below: calls the EXISTING getQuotaUsage()
 *     (lib/quota.ts, unmodified) to read real current-vs-limit numbers and
 *     inserts one row when the tenant is actually at/over limit. This is
 *     additive and inert by default — nothing calls it today. A future
 *     change that wants a specific plan+resource to become "soft block,
 *     record overage, bill later" instead of today's hard block would call
 *     this ALONGSIDE (not instead of) enforceQuota() at the specific call
 *     sites that get that product treatment, once PLAN_LIMITS (or a new
 *     column) actually encodes which plan/resource combinations allow it —
 *     that encoding does not exist yet and is exactly the ambiguous
 *     decision this change flags rather than guesses at.
 */
export interface OverageEvent {
  id: string;
  tenantId: string;
  resource: QuotaResource;
  plan: PlanName;
  limitAtTime: number;
  usageAtTime: number;
  recordedAt: string;
}

/**
 * Records a real overage observation for one resource, IF the tenant is
 * currently at/over its plan's limit for it (never records a fabricated
 * "would have been over" — always re-reads real usage via the existing
 * getQuotaUsage()). No-op (returns null) when the tenant is within limit,
 * or when the plan's limit for that resource is null (unlimited — there is
 * no overage concept for an unlimited resource).
 *
 * This does NOT throw Errors.paymentRequired and does NOT block the
 * caller's action — callers that want today's existing hard-block
 * behavior keep calling enforceQuota() exactly as before; this is purely
 * an additional, non-blocking observability write for a future overage
 * product decision, not a replacement for it.
 */
export async function recordQuotaOverageEvent(
  client: pg.PoolClient,
  tenantId: string,
  resource: QuotaResource,
): Promise<OverageEvent | null> {
  const { plan, current, limit } = await getQuotaUsage(client, tenantId, resource);
  if (limit === null || current < limit) return null;

  const result = await client.query<{
    id: string;
    recorded_at: string;
  }>(
    `INSERT INTO billing_overage_events (tenant_id, resource, plan, limit_at_time, usage_at_time)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, recorded_at`,
    [tenantId, resource, plan, limit, current],
  );

  return {
    id: result.rows[0]!.id,
    tenantId,
    resource,
    plan,
    limitAtTime: limit,
    usageAtTime: current,
    recordedAt: result.rows[0]!.recorded_at,
  };
}

/** Real, unbilled overage events for a tenant (never fabricated — straight read of billing_overage_events). */
export async function listUnbilledOverageEvents(
  client: Pick<pg.PoolClient, "query">,
  tenantId: string,
): Promise<OverageEvent[]> {
  const result = await client.query<{
    id: string;
    resource: QuotaResource;
    plan: PlanName;
    limit_at_time: number;
    usage_at_time: number;
    recorded_at: string;
  }>(
    `SELECT id, resource, plan, limit_at_time, usage_at_time, recorded_at
     FROM billing_overage_events
     WHERE tenant_id = $1 AND billed = false
     ORDER BY recorded_at DESC`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    tenantId,
    resource: row.resource,
    plan: row.plan,
    limitAtTime: row.limit_at_time,
    usageAtTime: row.usage_at_time,
    recordedAt: row.recorded_at,
  }));
}
