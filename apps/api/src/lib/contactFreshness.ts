import type { PoolClient } from "pg";

/**
 * Phase 2 port (rebuilt against master's schema): surfaces "last verified at
 * X (N days ago), by which provider, and whether that's stale" as a reusable,
 * display-ready readout for a `discovered_contacts` row.
 *
 * Phase 2's original version of this module read a separate
 * `email_verification_results` ledger (migration `287`) that does not exist
 * on master — master's independently-built Hunter contact-discovery track
 * (see hunterContactDiscovery.ts/contactProvenance.ts, migrations `438`-`440`)
 * instead records every verification as an append-only row in
 * `contact_provenance_events` (event_type = 'verification'), and
 * `hunterContactDiscovery.ts`'s own `verifyContactEmail` already uses
 * `contactProvenance.ts`'s `getFreshVerificationEvent` internally as a
 * boolean skip-check ("is this fresh enough to skip re-verifying"). That
 * internal skip-check is NOT the same thing this module provides: there was
 * no reusable, display-oriented readout (days-since-verified, a stale flag,
 * which provider/status) that a route could call for e.g. a dashboard badge
 * — this module fills exactly that gap, rebuilt to read
 * `contact_provenance_events` instead of phase2's `email_verification_results`.
 *
 * Only `contactId` is supported (not `leadId`): `contact_provenance_events`
 * has a `contact_id` column (referencing `discovered_contacts`) but no
 * `lead_id` column at all — master's promoted-lead verification history, if
 * any exists post-promotion, is out of this module's scope and out of this
 * port's file ownership (leadPromotion.ts/leads routes belong to a different
 * agent). A `leadId`-keyed freshness lookup can be added later once/if a
 * lead-level verification ledger exists on master; fabricating one here
 * would mean guessing a schema this port does not own.
 *
 * This module never writes to the database itself — same read-only
 * separation of concerns as contactProvenance.ts's own readers
 * (`listProvenanceForContact`, `getFreshVerificationEvent`), which this
 * reuses the underlying table of, without duplicating write logic.
 */

/** How many days without a re-check before a verification is considered
 * "stale" and should prompt a re-verify. 30 is a deliberate, documented
 * choice — not an invisible magic number — matching the general industry
 * rule-of-thumb that an inbox's deliverability status (catch-all behavior,
 * a bounced/decommissioned address, role changes) can meaningfully drift
 * within a month; it is NOT sourced from any provider's own documented
 * cache-validity window (neither Hunter nor the regex/DNS baseline
 * documents one). Override via `staleThresholdDays` when a caller has a
 * better-informed value for their own use case. Matches
 * hunterContactDiscovery.ts's own `DEFAULT_VERIFICATION_FRESHNESS_MS`
 * (24h) only in spirit, not in value — that constant gates whether a
 * re-verify CALL is skipped; this one gates whether an already-fetched
 * result should be flagged stale for display, a materially longer window
 * since it's advisory, not cost-avoidance. */
export const DEFAULT_STALE_VERIFICATION_THRESHOLD_DAYS = 30;

export interface ContactFreshness {
  /** False only when no verification row exists at all for this contact —
   * never fabricated as "unverified recently" when it's really "never
   * checked." */
  everVerified: boolean;
  lastVerifiedAt: string | null;
  /** Null only when `everVerified` is false. */
  daysSinceVerified: number | null;
  /** The provider that performed the most recent check (e.g. "hunter",
   * "free-tier:dns-mx" — see hunterContactDiscovery.ts's
   * `verifyContactEmail`, which records `result.hunterTier.ran ?
   * "hunter:email-verifier" : "free-tier:dns-mx"` as `source`, not
   * `provider`; this reads `contact_provenance_events.provider`, which
   * `recordVerificationEvent` defaults to "hunter" unless the caller
   * overrides it), straight from the ledger row, never inferred. Null only
   * when `everVerified` is false. */
  provider: string | null;
  /** The combined verification status recorded at that check (one of
   * `contact_provenance_events.verification_result`'s documented values:
   * valid/invalid/risky/accept_all/unknown/not_verified/provider_error —
   * see hunterEmailVerification.ts's `CombinedVerificationStatus`). Null
   * only when `everVerified` is false. */
  status: string | null;
  /** True when never verified (the most conservative/honest default — "no
   * data" is treated as "needs attention", not "fine") OR when
   * daysSinceVerified >= staleThresholdDays. */
  isStale: boolean;
  staleThresholdDays: number;
}

/**
 * Pure function (no DB access) — given the most recent verification row's
 * `verifiedAt` (or null, meaning "never verified"), the clock to measure
 * against, and the configured staleness threshold, computes the freshness
 * verdict. Exported directly so the day-math/staleness-boundary logic is
 * unit-testable without a database. Unchanged from phase2's original
 * version — this part of the module was never DB-shape-dependent.
 */
export function computeContactFreshness(
  lastVerifiedAt: Date | null,
  provider: string | null,
  status: string | null,
  now: Date,
  staleThresholdDays: number = DEFAULT_STALE_VERIFICATION_THRESHOLD_DAYS,
): ContactFreshness {
  if (!lastVerifiedAt) {
    return {
      everVerified: false,
      lastVerifiedAt: null,
      daysSinceVerified: null,
      provider: null,
      status: null,
      isStale: true,
      staleThresholdDays,
    };
  }

  const diffMs = now.getTime() - lastVerifiedAt.getTime();
  const daysSinceVerified = Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));

  return {
    everVerified: true,
    lastVerifiedAt: lastVerifiedAt.toISOString(),
    daysSinceVerified,
    provider,
    status,
    isStale: daysSinceVerified >= staleThresholdDays,
    staleThresholdDays,
  };
}

interface LatestVerificationRow {
  provider: string;
  verification_result: string;
  verified_at: Date | string;
}

/**
 * Reads the single most recent `contact_provenance_events` verification row
 * for a discovered contact (`contactId`) and returns the computed freshness
 * verdict. `client` must already be inside the caller's tenant-scoped
 * transaction (req.tenantDb), same RLS convention as every other
 * tenant-scoped read in this codebase (matches contactProvenance.ts's own
 * functions, which take the same `Pick<PoolClient, "query">` shape).
 */
export async function getContactVerificationFreshness(
  client: Pick<PoolClient, "query">,
  params: {
    tenantId: string;
    contactId: string;
    staleThresholdDays?: number;
    now?: Date;
  },
): Promise<ContactFreshness> {
  if (!params.contactId) {
    throw new Error("getContactVerificationFreshness requires contactId");
  }

  const result = await client.query<LatestVerificationRow>(
    `SELECT provider, verification_result, verified_at
     FROM contact_provenance_events
     WHERE tenant_id = $1 AND contact_id = $2 AND event_type = 'verification'
     ORDER BY verified_at DESC
     LIMIT 1`,
    [params.tenantId, params.contactId],
  );

  const row = result.rows[0];
  const now = params.now ?? new Date();
  if (!row) {
    return computeContactFreshness(null, null, null, now, params.staleThresholdDays);
  }
  return computeContactFreshness(
    new Date(row.verified_at),
    row.provider,
    row.verification_result,
    now,
    params.staleThresholdDays,
  );
}
