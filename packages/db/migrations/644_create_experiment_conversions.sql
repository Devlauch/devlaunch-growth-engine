-- Up Migration
--
-- Records a real conversion event (the experiment's primary_metric_event
-- actually firing for a given visitor) for a growth_experiments row.
-- metric_value is optional (e.g. a revenue amount for a purchase-style
-- metric; null for a plain binary conversion event like a form submit).
-- Not unique-constrained on (experiment_id, visitor_id): a visitor can
-- convert more than once (e.g. repeat purchases) — evaluateExperiment()
-- in experimentEngine.ts counts DISTINCT visitor_id per variant for the
-- conversion-rate significance test, so a double-recorded conversion for
-- the same visitor never inflates that rate.
CREATE TABLE experiment_conversions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES growth_experiments (id) ON DELETE CASCADE,
  visitor_id    text NOT NULL,
  converted_at  timestamptz NOT NULL DEFAULT now(),
  metric_value  numeric
);

CREATE INDEX idx_experiment_conversions_tenant_id ON experiment_conversions (tenant_id);
CREATE INDEX idx_experiment_conversions_experiment_id ON experiment_conversions (experiment_id);
CREATE INDEX idx_experiment_conversions_experiment_visitor ON experiment_conversions (experiment_id, visitor_id);

-- Down Migration

DROP TABLE IF EXISTS experiment_conversions;
