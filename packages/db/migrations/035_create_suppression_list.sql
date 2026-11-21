-- Up Migration
--
-- suppression_list: tenant-wide "never send to this address/number again"
-- registry (roadmap item 18, "Suppression and consent"). This is
-- foundational, standalone compliance infrastructure — no real outbound
-- sending exists yet in this codebase (by design; see docs/PHASE1_REPORT.md
-- for the "hold off on heavy optional services" direction). Future
-- messaging/sequence send code MUST call
-- apps/api/src/lib/suppression.ts's checkSendEligibility() (which in turn
-- queries this table) before ever dispatching a message.
--
-- Deliberately tenant-wide (not project-scoped): a person who unsubscribes
-- from one project's emails should not quietly remain suppressible only
-- there — the suppression check is keyed by tenant_id + email/phone +
-- channel, matching how real-world suppression/do-not-contact lists work
-- (one list per sending organization, not per campaign).
CREATE TABLE suppression_list (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email       text,
  phone       text,
  reason      text NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'manual', 'legal_request')),
  channel     text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'phone', 'all')),
  source_note text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppression_list_identity_present CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX idx_suppression_list_tenant_id ON suppression_list (tenant_id);

-- Partial unique indexes: these are the real enforcement mechanism the
-- suppression-check in suppression.ts relies on (not just application-level
-- de-duplication) — Postgres itself refuses a duplicate suppression entry
-- for the same tenant+identifier+channel.
CREATE UNIQUE INDEX uq_suppression_list_tenant_email_channel
  ON suppression_list (tenant_id, lower(email), channel)
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX uq_suppression_list_tenant_phone_channel
  ON suppression_list (tenant_id, phone, channel)
  WHERE phone IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS suppression_list;
