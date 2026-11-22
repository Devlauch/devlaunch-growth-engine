-- Up Migration
--
-- country_send_settings: per-tenant, per-country, per-channel sending
-- policy (roadmap item 18, "Suppression and consent" — "Add per-country
-- settings"). A tenant opts INTO restrictions by adding a row for a
-- country+channel; with no row configured, sending defaults to allowed with
-- no explicit-consent requirement (see
-- apps/api/src/lib/suppression.ts's isCountrySendAllowed(), which documents
-- this default-open behavior) — tenants don't need to enumerate every
-- country up front to use this feature.
CREATE TABLE country_send_settings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  country_code              text NOT NULL, -- ISO 3166-1 alpha-2
  channel                   text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'phone', 'sms')),
  sending_allowed           boolean NOT NULL DEFAULT true,
  requires_explicit_consent boolean NOT NULL DEFAULT false,
  note                      text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT country_send_settings_tenant_country_channel_key UNIQUE (tenant_id, country_code, channel)
);

CREATE TRIGGER trg_country_send_settings_set_updated_at
  BEFORE UPDATE ON country_send_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_country_send_settings_tenant_id ON country_send_settings (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS country_send_settings;
