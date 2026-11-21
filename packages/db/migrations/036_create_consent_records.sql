-- Up Migration
--
-- consent_records: per-channel consent evidence for a lead/email/phone
-- (roadmap item 18, "Suppression and consent"). Distinct from
-- suppression_list: suppression is a hard "never contact" block, while
-- consent_records track whether affirmative permission was ever captured
-- for a given channel — used by
-- apps/api/src/lib/suppression.ts's hasConsent()/checkSendEligibility() for
-- countries/channels that require explicit opt-in
-- (see 037_create_country_send_settings.sql).
CREATE TABLE consent_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  lead_id           uuid REFERENCES leads (id) ON DELETE CASCADE,
  email             text,
  phone             text,
  channel           text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'phone', 'linkedin', 'sms')),
  consent_given     boolean NOT NULL,
  consent_source    text NOT NULL CHECK (consent_source IN ('explicit_optin', 'public_widget_submission', 'business_card', 'referral', 'imported_list', 'other')),
  country_code      text,
  legal_basis_note  text,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_records_identity_present CHECK (lead_id IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX idx_consent_records_tenant_id ON consent_records (tenant_id);
CREATE INDEX idx_consent_records_lead_id ON consent_records (lead_id);
CREATE INDEX idx_consent_records_tenant_email ON consent_records (tenant_id, lower(email));
CREATE INDEX idx_consent_records_tenant_phone ON consent_records (tenant_id, phone);

-- Down Migration

DROP TABLE IF EXISTS consent_records;
