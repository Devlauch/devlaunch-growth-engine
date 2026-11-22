-- Up Migration
--
-- Phase 2 item 5, "Conversion Optimization Agent": experiment_results holds
-- real, user-recorded visitor/conversion counts for one variant of one
-- experiment at a point in time (a running tally, not auto-tracked — this
-- codebase has no analytics/visitor-tracking pipeline wired up yet, so a
-- human or an upstream integration reports these numbers). tenant_id is
-- denormalized from experiments for RLS (same pattern as campaign_members
-- denormalizing tenant_id from campaigns).

CREATE TABLE experiment_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  experiment_id   uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  variant         text NOT NULL CHECK (variant IN ('a', 'b')),
  visitors        integer NOT NULL DEFAULT 0 CHECK (visitors >= 0),
  conversions     integer NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT experiment_results_conversions_le_visitors CHECK (conversions <= visitors)
);

CREATE INDEX idx_experiment_results_tenant_id ON experiment_results (tenant_id);
CREATE INDEX idx_experiment_results_experiment_id ON experiment_results (experiment_id);
CREATE INDEX idx_experiment_results_experiment_variant_recorded_at ON experiment_results (experiment_id, variant, recorded_at DESC);

-- Down Migration

DROP TABLE IF EXISTS experiment_results;
