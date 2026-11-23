-- Up Migration
--
-- acquisition_costs: real, staff-entered marketing/channel spend for
-- DevLaunch's own internal acquisition workspace (see
-- 421_create_devlaunch_internal_workspace.sql), the numerator for the real
-- CAC computation at GET .../internal-growth/cac
-- (apps/api/src/routes/internalGrowth.ts) — amount_cents is always a real
-- number a real staff member typed in, never an estimate or a pulled-in ad
-- spend API figure (no ad-platform billing integration exists in this
-- codebase).
CREATE TABLE acquisition_costs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  channel      text NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  notes        text,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acquisition_costs_period_valid CHECK (period_end >= period_start)
);

CREATE TRIGGER trg_acquisition_costs_set_updated_at
  BEFORE UPDATE ON acquisition_costs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_acquisition_costs_tenant_id ON acquisition_costs (tenant_id);
CREATE INDEX idx_acquisition_costs_project_id ON acquisition_costs (project_id);
CREATE INDEX idx_acquisition_costs_tenant_period ON acquisition_costs (tenant_id, period_start, period_end);

-- Down Migration

DROP TABLE IF EXISTS acquisition_costs;
