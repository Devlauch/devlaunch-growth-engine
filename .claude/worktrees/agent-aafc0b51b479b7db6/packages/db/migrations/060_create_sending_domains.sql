-- Up Migration
--
-- Roadmap item 14 ("Sending setup per tenant"): a tenant-owned record of a
-- domain they intend to send outbound email from, plus the real,
-- independently-checkable DNS authentication state for it (SPF, DKIM,
-- DMARC). Verification here is genuinely real DNS lookups (see
-- apps/api/src/lib/dnsVerification.ts) — no paid provider account is
-- needed to check whether SPF/DKIM/DMARC records exist and are
-- well-formed. This table says nothing about whether mail can actually be
-- sent yet (see integrations.ts / campaigns.ts's honest "sending
-- integration not yet connected" — no real send pipeline exists in this
-- phase); it only tracks deliverability *readiness*.

CREATE TABLE sending_domains (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  domain          text NOT NULL,
  spf_status      text NOT NULL DEFAULT 'unchecked' CHECK (spf_status IN ('unchecked', 'pass', 'fail', 'not_found')),
  spf_record      text,
  dkim_selector   text,
  dkim_status     text NOT NULL DEFAULT 'unchecked' CHECK (dkim_status IN ('unchecked', 'pass', 'fail', 'not_found')),
  dkim_record     text,
  dmarc_status    text NOT NULL DEFAULT 'unchecked' CHECK (dmarc_status IN ('unchecked', 'pass', 'fail', 'not_found')),
  dmarc_record    text,
  dmarc_policy    text,
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sending_domains_tenant_domain_key UNIQUE (tenant_id, domain)
);

CREATE TRIGGER trg_sending_domains_set_updated_at
  BEFORE UPDATE ON sending_domains
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_sending_domains_tenant_id ON sending_domains (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS sending_domains;
