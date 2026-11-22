-- Up Migration
--
-- contact_provenance_events: an APPEND-ONLY provenance ledger for every
-- Hunter-backed discovery and verification operation against a
-- discovered_contacts row (see 028_create_discovered_contacts.sql). This is
-- deliberately NOT a single mutable row that gets overwritten on
-- re-verification (unlike decision_maker_cache's one-row-per-organization
-- upsert in 269_create_decision_maker_cache.sql, or company_enrichment's
-- one-row-per-lead upsert) — every discovery and every (re-)verification
-- inserts a NEW row here, so prior evidence is never silently lost. There is
-- no UPDATE trigger and no "set_updated_at" trigger on this table at all —
-- rows are immutable once written.
--
-- One row = one real operation against Hunter's API:
--   - event_type = 'discovery': a Domain Search (or similar) call that
--     surfaced/confirmed this contact. `confidence` is Hunter's own
--     confidence score for the record (0-100) when the response included
--     one; NULL if Hunter didn't report one — never guessed.
--   - event_type = 'verification': an Email Verifier call for this
--     contact's email. `verification_result` is this codebase's own mapped
--     status (see apps/api/src/lib/hunterEmailVerification.ts) and
--     `verification_evidence` preserves Hunter's raw response fields
--     relevant to that result (status/score/smtp_check/accept_all/etc, NOT
--     the whole raw HTTP body, but enough to re-derive the mapping) for
--     audit/debugging per this repo's existing data-retention approach
--     (no separate retention-policy doc exists elsewhere in this
--     repository as of this migration, so this follows the same
--     "retain the real evidence next to the real result" idiom already
--     used by discovered_contacts.email_verification/decision_maker_cache).
--
-- `operation_id` groups every row produced by one single logical API
-- call/job run (e.g. one Domain Search response can yield provenance rows
-- for several different contacts; all of those rows share one
-- operation_id) — this is also the idempotency key a retried background
-- job re-uses (see hunterProvider.ts/hunterContactDiscovery.ts), so a retry
-- of the same logical operation never creates duplicate rows (enforced
-- below by uq_contact_provenance_events_operation_contact_type).
CREATE TABLE contact_provenance_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  contact_id            uuid REFERENCES discovered_contacts (id) ON DELETE CASCADE,
  organization_id       uuid REFERENCES discovered_organizations (id) ON DELETE CASCADE,
  operation_id          uuid NOT NULL,
  event_type            text NOT NULL CHECK (event_type IN ('discovery', 'verification')),
  provider               text NOT NULL,
  provider_record_id     text,
  source                 text NOT NULL,
  confidence             integer CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  discovered_at           timestamptz,
  verified_at             timestamptz,
  verification_result     text CHECK (
    verification_result IS NULL OR verification_result IN (
      'valid', 'invalid', 'risky', 'accept_all', 'unknown', 'not_verified', 'provider_error'
    )
  ),
  discovery_payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_evidence   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- A discovery row must actually have a discovery timestamp; a
  -- verification row must actually have a verification timestamp and
  -- result. Keeps the two event shapes honest at the DB layer, not just by
  -- application-code convention.
  CONSTRAINT contact_provenance_events_discovery_shape CHECK (
    event_type <> 'discovery' OR discovered_at IS NOT NULL
  ),
  CONSTRAINT contact_provenance_events_verification_shape CHECK (
    event_type <> 'verification' OR (verified_at IS NOT NULL AND verification_result IS NOT NULL)
  )
);

CREATE INDEX idx_contact_provenance_events_tenant_id ON contact_provenance_events (tenant_id);
CREATE INDEX idx_contact_provenance_events_project_id ON contact_provenance_events (project_id);
CREATE INDEX idx_contact_provenance_events_contact_id ON contact_provenance_events (contact_id);
CREATE INDEX idx_contact_provenance_events_organization_id ON contact_provenance_events (organization_id);
CREATE INDEX idx_contact_provenance_events_operation_id ON contact_provenance_events (operation_id);
-- Supports "most recent verification for this contact" without a table scan.
CREATE INDEX idx_contact_provenance_events_contact_verified_at
  ON contact_provenance_events (contact_id, verified_at DESC)
  WHERE event_type = 'verification';

-- Idempotency guard for retried background jobs: the same logical operation
-- retried (e.g. a worker job re-delivered after a crash) must not create a
-- second provenance row for the same contact+event_type+source under one
-- operation_id.
CREATE UNIQUE INDEX uq_contact_provenance_events_operation_contact_type
  ON contact_provenance_events (operation_id, contact_id, event_type, source)
  WHERE contact_id IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS contact_provenance_events;
