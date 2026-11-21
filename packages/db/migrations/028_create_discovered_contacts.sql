-- Up Migration

-- discovered_contacts is a contact found at a discovered organization (see
-- 027_create_discovered_organizations.sql) — a role inbox, a named person,
-- a contact-form-only org, or a phone number, depending on what the source
-- exposed. verification_status/email_verification are populated by the
-- separate verification layer (not this migration's concern) once it runs
-- an email check against the row. tenant_id is denormalized from the
-- parent organization so RLS can filter this table directly.
CREATE TABLE discovered_contacts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  organization_id       uuid NOT NULL REFERENCES discovered_organizations (id) ON DELETE CASCADE,
  name                  text,
  role_title            text,
  email                 text,
  normalized_email      text,
  phone                 text,
  contact_channel       text NOT NULL CHECK (contact_channel IN ('role_based', 'named_person', 'contact_form', 'phone')),
  verification_status   text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('verified', 'unverified', 'role_based', 'risky', 'invalid')),
  email_verification    jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_url            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- A contact must carry at least one identifying handle to be useful.
  CONSTRAINT discovered_contacts_identity_present CHECK (email IS NOT NULL OR phone IS NOT NULL OR name IS NOT NULL)
);

CREATE TRIGGER trg_discovered_contacts_set_updated_at
  BEFORE UPDATE ON discovered_contacts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_discovered_contacts_tenant_id ON discovered_contacts (tenant_id);
CREATE INDEX idx_discovered_contacts_organization_id ON discovered_contacts (organization_id);
CREATE INDEX idx_discovered_contacts_normalized_email ON discovered_contacts (normalized_email);

-- Dedup guard: the same email shouldn't appear twice for one organization.
CREATE UNIQUE INDEX uq_discovered_contacts_organization_normalized_email
  ON discovered_contacts (organization_id, normalized_email)
  WHERE normalized_email IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS discovered_contacts;
