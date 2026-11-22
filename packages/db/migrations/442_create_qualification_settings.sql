-- Up Migration
--
-- Ported from the isolated milestone3-phase2 branch's
-- 293_create_qualification_settings.sql (renumbered here — 293 was never
-- applied to any shared/production database). One row per project defining
-- the minimum lead_scores.total_score (0-100, see 032_create_lead_scores.sql)
-- at which a lead is considered qualified for CRM promotion.
--
-- This is genuinely additive to master's own qualification concept
-- (apps/api/src/lib/leadPromotion.ts's evaluateQualification(), which until
-- this migration only ever compared against a single hardcoded
-- QUALIFIED_SCORE_THRESHOLD constant shared by every project/tenant).
-- Deliberately NOT a trigger that auto-flips leads.status or auto-creates a
-- deal — this table is config only; evaluateQualification() still performs
-- the actual "does this lead cross the threshold" check at the API layer,
-- and promotion from a qualified lead to a CRM record (companies/contacts/
-- lead_assignments rows) still only ever happens via the one explicit
-- POST .../promote-to-crm action (see leadPromotion.ts's header comment) —
-- this migration does not change that invariant. A missing row for a
-- project means "use the default QUALIFIED_SCORE_THRESHOLD," never an
-- error and never left undefined.
CREATE TABLE qualification_settings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  min_score_to_qualify  integer NOT NULL CHECK (min_score_to_qualify >= 0 AND min_score_to_qualify <= 100),
  updated_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_qualification_settings_project UNIQUE (project_id)
);

CREATE TRIGGER trg_qualification_settings_set_updated_at
  BEFORE UPDATE ON qualification_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_qualification_settings_tenant_id ON qualification_settings (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS qualification_settings;
