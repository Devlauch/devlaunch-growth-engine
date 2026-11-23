import type { PoolClient } from "pg";
import type { UsageEventType } from "./usageEvents.js";

/**
 * Phase 2 reconciliation (Agent A2): honest provider cost/credit reporting,
 * REBUILT against master's richer Hunter usage-metering scheme
 * (packages/db/migrations/440_extend_usage_events_hunter_types.sql — four
 * distinct event types with real `creditsUsed`/`creditsUnit` captured from
 * Hunter's own response headers when present) rather than Phase 2's
 * original single `hunter_api_call` type (migration 295, excluded — see
 * docs/PHASE_2_CREDENTIAL_AND_COST_REPORT.md for the verification
 * evidence that this exclusion is safe).
 *
 * HARD RULE (same one Phase 2's own version followed, and the one this
 * codebase enforces everywhere — see credentialEncryption.ts's own doc
 * comment for the same "no silent downgrade" philosophy): no provider
 * integration in this codebase exposes a real, per-call billed amount or a
 * real "credits remaining" figure in its response. This module NEVER
 * invents either.
 *
 * What it computes instead, per event type:
 *   1. A REAL, already-recorded usage_events call count — never fabricated.
 *   2. Where a provider publishes a stable, uniform list price (currently
 *      only Google's Custom Search JSON API), a clearly-labeled ESTIMATE —
 *      always named `estimatedCostCents`, never `costCents`.
 *   3. Where Hunter's own API response included real `X-Credits-Used` /
 *      `X-Credits-Unit` headers, a REAL `realCreditsUsed` figure summed
 *      directly from those headers — this is NOT an estimate, it is
 *      Hunter's own reported credit consumption, and is reported
 *      separately from (and preferred over, where it exists) a cost
 *      estimate. Verified directly against hunterContactDiscovery.ts's
 *      actual recordUsageEvent call sites: this figure is NOT a
 *      `metadata.creditsUsed` field (no such field exists in this
 *      codebase) — it is the `quantity` of a dedicated `hunter_api_request`
 *      marker row emitted only when Hunter's response included a
 *      credits-used header, identified by that row's non-null
 *      `metadata.creditsUnit` (see ProviderCostRow.realCreditsUsed's own
 *      doc comment for the full mechanics). Hunter still has no published $-per-credit
 *      conversion this review could confirm applies uniformly across
 *      plans, so `estimatedCostCents` stays null for every hunter_* event
 *      type even when `realCreditsUsed` is non-null — the two fields answer
 *      different questions ("how many credits did this really consume" vs
 *      "what might that cost in dollars") and neither substitutes for the
 *      other.
 *
 * `creditsRemaining` stays `null` — no provider integration in this
 * codebase exposes a reliable "remaining balance" endpoint this review
 * could confirm.
 */

/** The usage_events event types this module treats as "a real, metered
 * provider call" for cost-reporting purposes. Deliberately NOT the full
 * UsageEventType union (agent_run/api_request/lead_captured/ai_tokens
 * aren't provider calls with a per-call provider cost).
 *
 * Apollo is deliberately NOT included here: master has no usage_events
 * event type for Apollo calls at all (verified — see
 * docs/PHASE_2_CREDENTIAL_AND_COST_REPORT.md). This module does not invent
 * one; see NOT_TRACKED_PROVIDERS below for how that gap is reported
 * honestly instead. */
export const PROVIDER_CALL_EVENT_TYPES: readonly UsageEventType[] = [
  "google_search_call",
  "hunter_api_request",
  "hunter_discovery",
  "hunter_verification",
  "hunter_request_failed",
];

/** Event types whose usage_events rows carry real per-call credit-usage
 * metadata (`metadata.creditsUsed` / `metadata.creditsUnit`, captured from
 * Hunter's own `X-Credits-Used`/`X-Credits-Unit` response headers — see
 * migration 440's doc comment and hunterProvider.ts's `hunterGet`). Only
 * these event types are eligible for the `realCreditsUsed` figure. */
const CREDIT_METERED_EVENT_TYPES: ReadonlySet<UsageEventType> = new Set([
  "hunter_api_request",
  "hunter_discovery",
  "hunter_verification",
  "hunter_request_failed",
]);

export interface ProviderCostConfigEntry {
  /** A short, human-readable estimate of one call's cost in US cents,
   * clearly NOT a real billed amount. */
  estimatedCostCentsPerCall: number;
  /** Where this estimate comes from, so it can be corrected the moment a
   * real billed figure becomes available. Update this constant, and this
   * note, together if pricing changes — never silently. */
  source: string;
}

/**
 * Deliberately NOT a complete map over PROVIDER_CALL_EVENT_TYPES — an
 * event type with no entry here means "no cost estimate could be honestly
 * computed for this provider," NOT "this provider is free" or "zero cost."
 * computeProviderCostRows (below) reports that absence explicitly
 * (`estimatedCostCents: null`) rather than defaulting to 0 or guessing.
 *
 * - google_search_call: Google's Custom Search JSON API publishes a clear,
 *   stable list price for queries beyond its free daily quota — $5.00 per
 *   1,000 queries (= 0.5 cents/query) as of this writing. This is a
 *   genuinely published list price, not something this codebase invented —
 *   but it IS an estimate: a tenant could be entirely within the free daily
 *   quota (in which case the real cost is $0, not what's computed here), or
 *   on a different negotiated/legacy pricing tier Google doesn't expose
 *   through this API. If Google's pricing page changes, update this
 *   constant (and this comment) — do not leave it silently stale.
 *
 * - hunter_api_request / hunter_discovery / hunter_verification /
 *   hunter_request_failed: deliberately OMITTED from this $-estimate map,
 *   same conclusion Phase 2's own review reached for Hunter. Hunter sells
 *   access via tiered monthly-request-quota subscription plans rather than
 *   a single published $-per-call figure that applies uniformly regardless
 *   of plan — computing one flat per-call cents figure here would be a
 *   guess. Re-verified against master's richer scheme (migration 440):
 *   that richer scheme DOES give us something strictly better than a
 *   guess for Hunter — a REAL per-call credits-used figure straight from
 *   Hunter's own response headers, when Hunter sends them (see
 *   `realCreditsUsed` on ProviderCostRow) — so real counts AND, where
 *   available, real credit consumption are still reported; only the
 *   dollar-cost estimate is withheld, because no published credits-to-$
 *   conversion exists this review could confirm applies uniformly.
 */
export const PROVIDER_COST_CONFIG: Partial<Record<UsageEventType, ProviderCostConfigEntry>> = {
  google_search_call: {
    estimatedCostCentsPerCall: 0.5,
    source:
      "Google Custom Search JSON API published list pricing as of this writing: $5.00 per 1,000 queries " +
      "beyond the free daily quota. Not verified against a real invoice — update if Google's pricing changes.",
  },
};

export interface ProviderCostRow {
  eventType: UsageEventType;
  /** A REAL count — the number of usage_events rows of this type in the
   * requested window. Never estimated. */
  callCount: number;
  /** cents, or null when PROVIDER_COST_CONFIG has no entry for this event
   * type (see that constant's doc comment for why). */
  estimatedCostCentsPerCall: number | null;
  /** callCount * estimatedCostCentsPerCall, or null under the same
   * condition — never defaulted to 0, which would misrepresent "unknown
   * cost" as "free." */
  estimatedCostCents: number | null;
  /** REAL credits consumed, summed directly from Hunter's own
   * X-Credits-Used response header. Per hunterContactDiscovery.ts's actual
   * recordUsageEvent call sites (verified directly — see this file's
   * header comment), Hunter's real per-call credit cost is NOT a
   * `metadata.creditsUsed` field: it is recorded as the `quantity` of a
   * SEPARATE `hunter_api_request` usage_events row, one emitted only when
   * Hunter's response actually included a credits-used header, flagged by
   * that row's `metadata.creditsUnit` being non-null (ordinary
   * "a real API call happened" rows never set `creditsUnit`). This field
   * sums exactly those marker rows' `quantity` — null when this event type
   * isn't credit-metered (CREDIT_METERED_EVENT_TYPES) or when none of the
   * rows in this window happened to carry that marker (Hunter doesn't
   * always send the header — never guessed when absent). This is a REAL
   * figure, not an estimate, and is distinct from estimatedCostCents. */
  realCreditsUsed: number | null;
  /** The unit Hunter reported alongside realCreditsUsed (its own
   * X-Credits-Unit header value, e.g. "requests"), or null under the same
   * conditions as realCreditsUsed. If a window's rows disagreed on unit
   * (shouldn't happen in practice but never assumed), this is the first
   * non-null unit seen — never fabricated. */
  realCreditsUnit: string | null;
  /** Always present, even when an estimate was computed, so a caller never
   * has to guess why a number is null (or isn't). */
  note: string;
}

export interface ProviderCostReport {
  tenantId: string;
  projectId: string | null;
  windowDays: number;
  since: string;
  until: string;
  rows: ProviderCostRow[];
  /** Sum of every row's estimatedCostCents that isn't null. Null itself
   * only when every row is null (no estimate could be computed for
   * anything that was actually called). */
  totalEstimatedCostCents: number | null;
  /** Always null in this codebase — see this module's header doc comment
   * for why no provider integration here has a real "credits remaining"
   * figure to surface honestly. A dashboard should render this as
   * "not available", never as 0 or an invented number. */
  creditsRemaining: null;
  /** Providers with real outbound calls in this codebase that have NO
   * usage_events event type at all yet, so no real call count — let alone a
   * cost estimate — can be computed for them here. Distinct from a
   * configured-but-no-estimate row (above): this is "not tracked at all",
   * not "tracked but unpriced." */
  notTracked: { provider: string; reason: string }[];
}

/** Default lookback window — matches usage.ts's GET /overview endpoint's
 * own 30-day default for its `perDay` breakdown, so a provider-cost view
 * next to the existing usage view covers the same period unless a caller
 * asks otherwise. */
export const DEFAULT_PROVIDER_COST_WINDOW_DAYS = 30;

/**
 * Verified independently as part of this reconciliation pass (see
 * docs/PHASE_2_CREDENTIAL_AND_COST_REPORT.md): master's `integrations`
 * registry has real Apollo credential-resolution wiring
 * (providerCredentials.ts's resolveApolloApiKey, routes/integrations.ts's
 * REAL_PROVIDERS) as of this same reconciliation pass, but there is still
 * NO usage_events event type recording a real Apollo API call anywhere on
 * master. That is a genuine, currently-real gap — not invented here, and
 * not silently worked around by reusing a different event type or
 * guessing a cost. Once an `apollo_*` usage_events type exists (a decision
 * for whoever wires Apollo's actual People Search business logic —
 * apolloDecisionMakerProvider.ts, out of this module's scope), add it to
 * PROVIDER_CALL_EVENT_TYPES above and remove this entry. */
const NOT_TRACKED_PROVIDERS: { provider: string; reason: string }[] = [
  {
    provider: "apollo",
    reason:
      "Apollo has real credential resolution (providerCredentials.ts) and is in REAL_PROVIDERS, but no usage_events " +
      "event type exists yet for a real Apollo People Search call — so no real call count, let alone a cost estimate, " +
      "can be honestly computed for it here. Not invented.",
  },
];

/**
 * Pure math, no DB access — takes REAL counts and, where applicable, REAL
 * summed credits-used (as already aggregated from usage_events by
 * getProviderCostReport, or supplied directly by a test) and returns the
 * row-by-row estimate. Always includes one row per PROVIDER_CALL_EVENT_TYPES
 * entry (even a real, honest zero), never silently drops a type with zero
 * calls.
 */
export function computeProviderCostRows(
  countsByEventType: Partial<Record<UsageEventType, number>>,
  creditsByEventType: Partial<Record<UsageEventType, { used: number; unit: string | null }>> = {},
): ProviderCostRow[] {
  return PROVIDER_CALL_EVENT_TYPES.map((eventType) => {
    const callCount = countsByEventType[eventType] ?? 0;
    const config = PROVIDER_COST_CONFIG[eventType];
    const credits = CREDIT_METERED_EVENT_TYPES.has(eventType) ? creditsByEventType[eventType] : undefined;
    const realCreditsUsed = credits?.used ?? null;
    const realCreditsUnit = credits?.unit ?? null;

    if (!config) {
      const creditsNote =
        realCreditsUsed !== null
          ? ` ${realCreditsUsed} real credit(s)${realCreditsUnit ? ` (${realCreditsUnit})` : ""} were consumed per the provider's own response headers — see realCreditsUsed, not a guess.`
          : "";
      return {
        eventType,
        callCount,
        estimatedCostCentsPerCall: null,
        estimatedCostCents: null,
        realCreditsUsed,
        realCreditsUnit,
        note:
          `No $ cost estimate is configured for '${eventType}' — see PROVIDER_COST_CONFIG's doc comment. ` +
          `The real call count above is still honest; only the cost estimate is withheld.${creditsNote}`,
      };
    }

    return {
      eventType,
      callCount,
      estimatedCostCentsPerCall: config.estimatedCostCentsPerCall,
      estimatedCostCents: Math.round(callCount * config.estimatedCostCentsPerCall * 100) / 100,
      realCreditsUsed,
      realCreditsUnit,
      note: `Estimate only, not a real billed amount: ${config.source}`,
    };
  });
}

interface UsageEventCountRow {
  event_type: UsageEventType;
  count: string;
  credits_used_sum: string | null;
  credits_unit: string | null;
}

/**
 * Queries real usage_events rows for one tenant (optionally scoped to one
 * project), groups by event_type, and returns the honest cost estimate
 * built from those real counts — plus, for credit-metered event types, a
 * real summed credits-used figure.
 *
 * `count` (callCount) only counts rows whose `metadata.creditsUnit` is
 * null — i.e. an actual "a real provider call happened" row — explicitly
 * EXCLUDING the separate credits-used marker rows hunterContactDiscovery.ts
 * emits alongside them (see ProviderCostRow.realCreditsUsed's doc comment),
 * so a credits-used marker is never double-counted as a second call.
 * `credits_used_sum` sums exactly those marker rows' `quantity` column
 * (never `metadata.creditsUsed` — no such field exists in this codebase);
 * `FILTER (WHERE ...)` simply excludes non-marker rows from that sum rather
 * than treating a missing header as zero. `client` must already be inside
 * the caller's tenant-scoped transaction (req.tenantDb), same RLS
 * convention as recordUsageEvent/usage.ts's /overview.
 */
export async function getProviderCostReport(
  client: PoolClient,
  params: { tenantId: string; projectId?: string | null; windowDays?: number },
): Promise<ProviderCostReport> {
  const windowDays = params.windowDays ?? DEFAULT_PROVIDER_COST_WINDOW_DAYS;
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error("getProviderCostReport: windowDays must be a positive number");
  }

  const result = await client.query<UsageEventCountRow>(
    `SELECT
       event_type,
       count(*) FILTER (WHERE metadata->>'creditsUnit' IS NULL)::text AS count,
       sum(quantity) FILTER (WHERE metadata->>'creditsUnit' IS NOT NULL)::text AS credits_used_sum,
       (array_agg(metadata->>'creditsUnit') FILTER (WHERE metadata->>'creditsUnit' IS NOT NULL))[1] AS credits_unit
     FROM usage_events
     WHERE tenant_id = $1
       AND ($2::uuid IS NULL OR project_id = $2)
       AND event_type = ANY($3)
       AND created_at >= now() - ($4 || ' days')::interval
     GROUP BY event_type`,
    [params.tenantId, params.projectId ?? null, PROVIDER_CALL_EVENT_TYPES, String(windowDays)],
  );

  const countsByEventType: Partial<Record<UsageEventType, number>> = {};
  const creditsByEventType: Partial<Record<UsageEventType, { used: number; unit: string | null }>> = {};
  for (const row of result.rows) {
    countsByEventType[row.event_type] = Number(row.count);
    if (row.credits_used_sum !== null) {
      creditsByEventType[row.event_type] = { used: Number(row.credits_used_sum), unit: row.credits_unit ?? null };
    }
  }

  const rows = computeProviderCostRows(countsByEventType, creditsByEventType);
  const pricedRows = rows.filter((r): r is ProviderCostRow & { estimatedCostCents: number } => r.estimatedCostCents !== null);
  const totalEstimatedCostCents =
    pricedRows.length > 0 ? Math.round(pricedRows.reduce((sum, r) => sum + r.estimatedCostCents, 0) * 100) / 100 : null;

  const now = new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  return {
    tenantId: params.tenantId,
    projectId: params.projectId ?? null,
    windowDays,
    since: since.toISOString(),
    until: now.toISOString(),
    rows,
    totalEstimatedCostCents,
    creditsRemaining: null,
    notTracked: NOT_TRACKED_PROVIDERS,
  };
}
