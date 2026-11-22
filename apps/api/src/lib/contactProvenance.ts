import type { PoolClient } from "pg";

/**
 * Append-only provenance ledger writer/reader for
 * `contact_provenance_events` (see
 * packages/db/migrations/285_create_contact_provenance_events.sql for the
 * full schema rationale). This is the ONE place that writes to that table —
 * every discovery/verification event, for every contact, goes through
 * `recordDiscoveryEvent`/`recordVerificationEvent` so the append-only
 * guarantee (never UPDATE, always INSERT) is enforced in one spot rather
 * than trusted to every call site individually.
 *
 * Idempotency: a retried operation (same `operationId`, same `contactId`,
 * same `event_type`, same `source`) hits
 * `uq_contact_provenance_events_operation_contact_type` and is silently
 * absorbed (`ON CONFLICT DO NOTHING`) rather than creating a duplicate row
 * — a worker job retried after a crash produces exactly the same provenance
 * as a single successful run, never double-counted evidence.
 */

export interface ContactProvenanceRow {
  id: string;
  tenant_id: string;
  project_id: string;
  contact_id: string | null;
  organization_id: string | null;
  operation_id: string;
  event_type: "discovery" | "verification";
  provider: string;
  provider_record_id: string | null;
  source: string;
  confidence: number | null;
  discovered_at: string | null;
  verified_at: string | null;
  verification_result: string | null;
  discovery_payload: Record<string, unknown>;
  verification_evidence: Record<string, unknown>;
  created_at: string;
}

export interface RecordDiscoveryEventInput {
  tenantId: string;
  projectId: string;
  contactId: string;
  organizationId: string | null;
  operationId: string;
  source: string;
  providerRecordId: string | null;
  confidence: number | null;
  payload: object;
  provider?: string;
}

export async function recordDiscoveryEvent(
  tenantDb: Pick<PoolClient, "query">,
  input: RecordDiscoveryEventInput,
): Promise<ContactProvenanceRow | null> {
  const result = await tenantDb.query(
    `INSERT INTO contact_provenance_events
       (tenant_id, project_id, contact_id, organization_id, operation_id, event_type, provider,
        provider_record_id, source, confidence, discovered_at, discovery_payload)
     VALUES ($1, $2, $3, $4, $5, 'discovery', $6, $7, $8, $9, now(), $10::jsonb)
     ON CONFLICT (operation_id, contact_id, event_type, source) WHERE contact_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      input.projectId,
      input.contactId,
      input.organizationId,
      input.operationId,
      input.provider ?? "hunter",
      input.providerRecordId,
      input.source,
      input.confidence,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return (result.rows[0] as ContactProvenanceRow | undefined) ?? null;
}

export interface RecordVerificationEventInput {
  tenantId: string;
  projectId: string;
  contactId: string;
  organizationId: string | null;
  operationId: string;
  source: string;
  verificationResult: string;
  evidence: object;
  providerRecordId?: string | null;
  confidence?: number | null;
  provider?: string;
}

export async function recordVerificationEvent(
  tenantDb: Pick<PoolClient, "query">,
  input: RecordVerificationEventInput,
): Promise<ContactProvenanceRow | null> {
  const result = await tenantDb.query(
    `INSERT INTO contact_provenance_events
       (tenant_id, project_id, contact_id, organization_id, operation_id, event_type, provider,
        provider_record_id, source, confidence, verified_at, verification_result, verification_evidence)
     VALUES ($1, $2, $3, $4, $5, 'verification', $6, $7, $8, $9, now(), $10, $11::jsonb)
     ON CONFLICT (operation_id, contact_id, event_type, source) WHERE contact_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      input.projectId,
      input.contactId,
      input.organizationId,
      input.operationId,
      input.provider ?? "hunter",
      input.providerRecordId ?? null,
      input.source,
      input.confidence ?? null,
      input.verificationResult,
      JSON.stringify(input.evidence ?? {}),
    ],
  );
  return (result.rows[0] as ContactProvenanceRow | undefined) ?? null;
}

/** Full, time-ordered provenance history for one contact (both discovery
 * and verification events) — nothing is ever hidden or collapsed; this is
 * the append-only history itself. */
export async function listProvenanceForContact(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  contactId: string,
): Promise<ContactProvenanceRow[]> {
  const result = await tenantDb.query(
    `SELECT * FROM contact_provenance_events
     WHERE tenant_id = $1 AND contact_id = $2
     ORDER BY created_at ASC`,
    [tenantId, contactId],
  );
  return result.rows as ContactProvenanceRow[];
}

/** Returns the most recent verification event for `contactId` if it is
 * younger than `freshnessMs`, else null. Used to decide whether a
 * re-verification request can be skipped (not configured here to ever skip
 * an EXPLICIT force-reverify request — that's the caller's job). */
export async function getFreshVerificationEvent(
  tenantDb: Pick<PoolClient, "query">,
  contactId: string,
  freshnessMs: number,
): Promise<ContactProvenanceRow | null> {
  const result = await tenantDb.query(
    `SELECT * FROM contact_provenance_events
     WHERE contact_id = $1 AND event_type = 'verification'
       AND verified_at > now() - ($2 || ' milliseconds')::interval
     ORDER BY verified_at DESC
     LIMIT 1`,
    [contactId, freshnessMs],
  );
  return (result.rows[0] as ContactProvenanceRow | undefined) ?? null;
}
