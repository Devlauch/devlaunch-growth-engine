-- Up Migration
--
-- Records which variant a given visitor was deterministically assigned to
-- for a growth_experiments row (see experimentEngine.ts's assignVariant()).
-- The UNIQUE (experiment_id, visitor_id) constraint is what makes
-- assignment stable/idempotent: the SAME visitor always gets back the SAME
-- variant_key on every subsequent call, because assignVariant() always
-- checks for an existing row here first (an INSERT ... ON CONFLICT DO
-- NOTHING) before computing a fresh hash-based assignment, so a repeat
-- visitor is never reassigned to a different variant mid-experiment.
CREATE TABLE experiment_exposures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES growth_experiments (id) ON DELETE CASCADE,
  visitor_id    text NOT NULL,
  variant_key   text NOT NULL,
  exposed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT experiment_exposures_experiment_visitor_key UNIQUE (experiment_id, visitor_id)
);

CREATE INDEX idx_experiment_exposures_tenant_id ON experiment_exposures (tenant_id);
CREATE INDEX idx_experiment_exposures_experiment_id ON experiment_exposures (experiment_id);
CREATE INDEX idx_experiment_exposures_experiment_variant ON experiment_exposures (experiment_id, variant_key);

-- Down Migration

DROP TABLE IF EXISTS experiment_exposures;
