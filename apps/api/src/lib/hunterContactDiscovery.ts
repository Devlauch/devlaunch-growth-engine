import type { PoolClient } from "pg";
import crypto from "node:crypto";
import { findDuplicateContact, normalizeEmail } from "./dedup.js";
import { isRoleBasedLocalPart, getLocalPartAndDomain, type VerifyEmailOptions } from "./emailVerification.js";
import { recordUsageEvent } from "./usageEvents.js";
import {
  HunterApiError,
  HunterNetworkError,
  HunterNotConfiguredError,
  HunterTimeoutError,
  resolveHunterApiKey,
  searchDomainAllPages,
  type HunterContactRecord,
} from "./hunterProvider.js";
import { verifyEmailCombined } from "./hunterEmailVerification.js";
import { recordDiscoveryEvent, recordVerificationEvent, getFreshVerificationEvent } from "./contactProvenance.js";

/**
 * Orchestrates one real Hunter Domain Search "discovery operation" against
 * an EXISTING `discovered_organizations` row (never a parallel domain-input
 * path — the domain always comes from that table, per this task's
 * instruction to reuse discovery.ts's existing organization data).
 *
 * Responsibilities, all composed from existing building blocks rather than
 * reimplemented:
 *   - credential resolution (hunterProvider.ts's resolveHunterApiKey)
 *   - pagination (hunterProvider.ts's searchDomainAllPages)
 *   - dedup against discovered_contacts (dedup.ts's findDuplicateContact —
 *     keyed on normalized email first, falling back to exact name within
 *     the SAME organization only — never merges two different people just
 *     because they share a company domain; a second contact at the same
 *     org with a different email/name is always a NEW row)
 *   - provenance (contactProvenance.ts's recordDiscoveryEvent, one row per
 *     newly-persisted contact, all sharing one operationId)
 *   - usage tracking (usageEvents.ts's recordUsageEvent)
 *   - freshness guard: an organization re-run within `freshnessMs` of its
 *     last successful discovery operation is skipped (status
 *     'skipped_fresh') unless `forceRefresh` is passed — avoids
 *     re-enriching (and re-billing Hunter credits for) the same org on
 *     every retry/poll.
 */

const DEFAULT_DISCOVERY_FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_VERIFICATION_FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24h

export interface DiscoverContactsInput {
  tenantId: string;
  projectId: string;
  organizationId: string;
  organizationName: string;
  domain: string;
  /** Caller-supplied id groups every provenance row this one call produces,
   * and doubles as the idempotency key for a retried worker job (see
   * uq_contact_provenance_events_operation_contact_type). Defaults to a
   * fresh uuid per call if omitted. */
  operationId?: string;
  forceRefresh?: boolean;
  freshnessMs?: number;
}

export type DiscoverContactsStatus = "found" | "not_configured" | "no_result" | "skipped_fresh" | "provider_error";

export interface DiscoverContactsOutcome {
  status: DiscoverContactsStatus;
  operationId: string;
  newContactIds: string[];
  duplicateCount: number;
  totalHunterContacts: number;
  truncated: boolean;
  error?: string;
}

/** True if this organization already had a successful Hunter discovery
 * event within `freshnessMs`. */
async function hasFreshDiscovery(
  tenantDb: Pick<PoolClient, "query">,
  organizationId: string,
  freshnessMs: number,
): Promise<boolean> {
  const r = await tenantDb.query(
    `SELECT 1 FROM contact_provenance_events
     WHERE organization_id = $1 AND event_type = 'discovery' AND provider = 'hunter'
       AND discovered_at > now() - ($2 || ' milliseconds')::interval
     LIMIT 1`,
    [organizationId, freshnessMs],
  );
  return (r.rowCount ?? 0) > 0;
}

function contactChannelFor(record: HunterContactRecord): "role_based" | "named_person" {
  if (record.firstName || record.lastName) return "named_person";
  const parts = record.email ? getLocalPartAndDomain(record.email) : null;
  if (parts && isRoleBasedLocalPart(parts.localPart)) return "role_based";
  return "named_person";
}

export async function discoverContactsForOrganization(
  tenantDb: Pick<PoolClient, "query">,
  input: DiscoverContactsInput,
): Promise<DiscoverContactsOutcome> {
  const operationId = input.operationId ?? crypto.randomUUID();
  const freshnessMs = input.freshnessMs ?? DEFAULT_DISCOVERY_FRESHNESS_MS;

  if (!input.forceRefresh && (await hasFreshDiscovery(tenantDb, input.organizationId, freshnessMs))) {
    return {
      status: "skipped_fresh",
      operationId,
      newContactIds: [],
      duplicateCount: 0,
      totalHunterContacts: 0,
      truncated: false,
    };
  }

  const apiKey = await resolveHunterApiKey(tenantDb, input.tenantId, input.projectId);
  if (!apiKey) {
    return {
      status: "not_configured",
      operationId,
      newContactIds: [],
      duplicateCount: 0,
      totalHunterContacts: 0,
      truncated: false,
      error: new HunterNotConfiguredError().message,
    };
  }

  let searchResult: Awaited<ReturnType<typeof searchDomainAllPages>>;
  try {
    searchResult = await searchDomainAllPages(input.domain, apiKey);
  } catch (err) {
    await recordUsageEvent({
      client: tenantDb as PoolClient,
      tenantId: input.tenantId,
      projectId: input.projectId,
      eventType: "hunter_request_failed",
      metadata: {
        endpoint: "domain-search",
        errorKind: err instanceof HunterApiError ? "HunterApiError" : err instanceof HunterTimeoutError ? "HunterTimeoutError" : err instanceof HunterNetworkError ? "HunterNetworkError" : "unknown",
        ...(err instanceof HunterApiError ? { statusCode: err.status } : {}),
      },
    });
    return {
      status: "provider_error",
      operationId,
      newContactIds: [],
      duplicateCount: 0,
      totalHunterContacts: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await recordUsageEvent({
    client: tenantDb as PoolClient,
    tenantId: input.tenantId,
    projectId: input.projectId,
    eventType: "hunter_api_request",
    metadata: { endpoint: "domain-search", domain: input.domain, pageCount: searchResult.pages.length },
  });
  for (const page of searchResult.pages) {
    if (page.credits.used !== null) {
      await recordUsageEvent({
        client: tenantDb as PoolClient,
        tenantId: input.tenantId,
        projectId: input.projectId,
        eventType: "hunter_api_request",
        quantity: page.credits.used,
        metadata: { endpoint: "domain-search", creditsUnit: page.credits.unit, domain: input.domain },
      });
    }
  }

  const newContactIds: string[] = [];
  let duplicateCount = 0;

  for (const record of searchResult.contacts) {
    if (!record.email) continue; // never fabricate/persist a contact with no real email Hunter actually returned.
    const normalizedEmail = normalizeEmail(record.email);

    // Dedup keyed on (organization, normalized email) first — this is the
    // real per-person identifying key. A second, different contact at the
    // SAME organization with a different email/name is always inserted as
    // a NEW row (never collapsed just because the domain matches) — see
    // findDuplicateContact's own email-first/name-fallback logic, which
    // this reuses unmodified.
    const duplicate = await findDuplicateContact(tenantDb, input.organizationId, {
      email: record.email,
      name: record.firstName || record.lastName ? [record.firstName, record.lastName].filter(Boolean).join(" ") : null,
    });
    if (duplicate) {
      duplicateCount += 1;
      // Still record a discovery provenance event against the existing
      // contact — Hunter re-confirming a contact it already found is real,
      // honest evidence worth keeping, even though no new row is inserted.
      await recordDiscoveryEvent(tenantDb, {
        tenantId: input.tenantId,
        projectId: input.projectId,
        contactId: duplicate.id,
        organizationId: input.organizationId,
        operationId,
        source: "hunter:domain-search:emails[]",
        providerRecordId: record.providerRecordId,
        confidence: record.confidence,
        payload: record,
      });
      continue;
    }

    const name = record.firstName || record.lastName ? [record.firstName, record.lastName].filter(Boolean).join(" ") : null;
    const inserted = await tenantDb.query(
      `INSERT INTO discovered_contacts
         (tenant_id, organization_id, name, role_title, email, normalized_email, phone, contact_channel, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (organization_id, normalized_email) DO NOTHING
       RETURNING id`,
      [
        input.tenantId,
        input.organizationId,
        name,
        record.position,
        record.email,
        normalizedEmail,
        record.phoneNumber,
        contactChannelFor(record),
        record.sources[0]?.uri ?? null,
      ],
    );

    if (inserted.rowCount === 0) {
      // Lost a race against another concurrent insert (or the DB-level
      // unique index caught something findDuplicateContact's SELECT
      // missed) — treat it the same as an application-level duplicate.
      duplicateCount += 1;
      continue;
    }

    const contactId = (inserted.rows[0] as { id: string }).id;
    newContactIds.push(contactId);

    await recordDiscoveryEvent(tenantDb, {
      tenantId: input.tenantId,
      projectId: input.projectId,
      contactId,
      organizationId: input.organizationId,
      operationId,
      source: "hunter:domain-search:emails[]",
      providerRecordId: record.providerRecordId,
      confidence: record.confidence,
      payload: record,
    });
  }

  if (newContactIds.length > 0) {
    await recordUsageEvent({
      client: tenantDb as PoolClient,
      tenantId: input.tenantId,
      projectId: input.projectId,
      eventType: "hunter_discovery",
      quantity: newContactIds.length,
      metadata: { organizationId: input.organizationId, domain: input.domain },
    });
  }

  return {
    status: newContactIds.length > 0 || duplicateCount > 0 ? "found" : "no_result",
    operationId,
    newContactIds,
    duplicateCount,
    totalHunterContacts: searchResult.contacts.length,
    truncated: searchResult.truncated,
  };
}

// ---------------------------------------------------------------------------
// Verification orchestration
// ---------------------------------------------------------------------------

export interface VerifyContactEmailInput {
  tenantId: string;
  projectId: string;
  contactId: string;
  email: string;
  organizationId?: string | null;
  operationId?: string;
  forceReverify?: boolean;
  freshnessMs?: number;
  /** Injectable for tests (same convention as emailVerification.ts's
   * `VerifyEmailOptions.resolver`) — defaults to node's real DNS resolver. */
  resolver?: VerifyEmailOptions["resolver"];
}

export type VerifyContactEmailStatus = "verified" | "skipped_fresh" | "not_configured";

export interface VerifyContactEmailOutcome {
  status: VerifyContactEmailStatus;
  operationId: string;
  combinedStatus?: string;
}

/**
 * Runs the combined (free DNS tier + optional Hunter tier) verification for
 * one contact's email, honoring a freshness window so an unchanged retry
 * doesn't re-call Hunter (and re-spend a real verification credit) on every
 * attempt. `forceReverify: true` always bypasses the freshness check — an
 * explicit, intentional re-verification request must never be silently
 * skipped.
 */
export async function verifyContactEmail(
  tenantDb: Pick<PoolClient, "query">,
  input: VerifyContactEmailInput,
): Promise<VerifyContactEmailOutcome> {
  const operationId = input.operationId ?? crypto.randomUUID();
  const freshnessMs = input.freshnessMs ?? DEFAULT_VERIFICATION_FRESHNESS_MS;

  if (!input.forceReverify) {
    const fresh = await getFreshVerificationEvent(tenantDb, input.contactId, freshnessMs);
    if (fresh) {
      return { status: "skipped_fresh", operationId, combinedStatus: fresh.verification_result ?? undefined };
    }
  }

  const apiKey = await resolveHunterApiKey(tenantDb, input.tenantId, input.projectId);

  const result = await verifyEmailCombined(input.email, { hunterApiKey: apiKey, resolver: input.resolver });

  await recordUsageEvent({
    client: tenantDb as PoolClient,
    tenantId: input.tenantId,
    projectId: input.projectId,
    eventType: "hunter_verification",
    metadata: { combinedStatus: result.combinedStatus, hunterRan: result.hunterTier.ran },
  });
  if (result.hunterTier.error) {
    await recordUsageEvent({
      client: tenantDb as PoolClient,
      tenantId: input.tenantId,
      projectId: input.projectId,
      eventType: "hunter_request_failed",
      metadata: { endpoint: "email-verifier", ...result.hunterTier.error },
    });
  }
  if (result.hunterTier.result?.credits.used !== null && result.hunterTier.result) {
    await recordUsageEvent({
      client: tenantDb as PoolClient,
      tenantId: input.tenantId,
      projectId: input.projectId,
      eventType: "hunter_api_request",
      quantity: result.hunterTier.result.credits.used ?? 1,
      metadata: { endpoint: "email-verifier", creditsUnit: result.hunterTier.result.credits.unit },
    });
  }

  await recordVerificationEvent(tenantDb, {
    tenantId: input.tenantId,
    projectId: input.projectId,
    contactId: input.contactId,
    organizationId: input.organizationId ?? null,
    operationId,
    source: result.hunterTier.ran ? "hunter:email-verifier" : "free-tier:dns-mx",
    verificationResult: result.combinedStatus,
    evidence: result,
  });

  return {
    status: apiKey ? "verified" : "not_configured",
    operationId,
    combinedStatus: result.combinedStatus,
  };
}
