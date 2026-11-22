-- Up Migration
--
-- Downloadable lead magnets attached to a landing page (e.g. a whitepaper
-- or checklist offered in exchange for filling the page's enquiry form).
-- `file_url` is a STUB: this codebase has no file-upload/object-storage
-- infra, so the client supplies/hosts the file themselves and pastes its
-- URL (or path) here — no upload endpoint, no storage bucket wiring.
CREATE TABLE lead_magnets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  landing_page_id  uuid NOT NULL REFERENCES landing_pages (id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  file_url         text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_lead_magnets_set_updated_at
  BEFORE UPDATE ON lead_magnets
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_lead_magnets_tenant_id ON lead_magnets (tenant_id);
CREATE INDEX idx_lead_magnets_project_id ON lead_magnets (project_id);
CREATE INDEX idx_lead_magnets_landing_page_id ON lead_magnets (landing_page_id);

-- Down Migration

DROP TRIGGER IF EXISTS trg_lead_magnets_set_updated_at ON lead_magnets;
DROP TABLE IF EXISTS lead_magnets;
