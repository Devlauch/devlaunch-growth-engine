-- Up Migration
--
-- channel_provider_configs: real, tenant-scoped status tracking for every
-- outbound-channel provider roadmap item "Multi-channel customer
-- acquisition" wires an interface for (SMTP email, Postiz social
-- scheduling, Google Ads, Meta Ads, WhatsApp Business). No live
-- credentials/OAuth exist for any of these in this environment yet (see
-- apps/api/src/lib/emailProvider.ts and apps/api/src/lib/channelProviders.ts
-- for the honest NotConfigured* stubs this table backs) — this table exists
-- so the real connection status per tenant/channel is a genuine DB fact a
-- UI can read, rather than something guessed from process env at request
-- time alone. A row's status only ever becomes 'configured' once a real
-- integration actually sets it (e.g. a future OAuth callback); nothing in
-- this phase ever does that for google_ads/meta_ads/whatsapp_business/
-- postiz_social, and smtp_email's status is kept in sync with whether
-- SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM are all set (see
-- emailProvider.ts's getEmailProvider()).
CREATE TABLE channel_provider_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('smtp_email', 'postiz_social', 'google_ads', 'meta_ads', 'whatsapp_business')),
  status          text NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured', 'configured')),
  detail          text,
  external_account_id text,
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_provider_configs_tenant_channel_key UNIQUE (tenant_id, channel)
);

CREATE TRIGGER trg_channel_provider_configs_set_updated_at
  BEFORE UPDATE ON channel_provider_configs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_channel_provider_configs_tenant_id ON channel_provider_configs (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS channel_provider_configs;
