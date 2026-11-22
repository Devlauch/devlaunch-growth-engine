-- Up Migration
--
-- Phase 2 item 5, "Conversion Optimization Agent": experiments is a
-- tenant/project-owned A/B test record (a suggestion, until a human
-- promotes it to 'running' and starts recording results in
-- experiment_results — see 089_create_experiment_results.sql).
--
-- Status lifecycle (enforced at the API layer, not just this CHECK):
--   suggested -> running -> completed | abandoned
-- started_at is set when a run begins (suggested -> running);
-- ended_at is set when it stops (running -> completed | abandoned).

CREATE TABLE experiments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id               uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name                     text NOT NULL,
  hypothesis               text NOT NULL,
  variant_a_description    text NOT NULL,
  variant_b_description    text NOT NULL,
  status                   text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'running', 'completed', 'abandoned')),
  started_at               timestamptz,
  ended_at                 timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_experiments_set_updated_at
  BEFORE UPDATE ON experiments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_experiments_tenant_id ON experiments (tenant_id);
CREATE INDEX idx_experiments_project_id ON experiments (project_id);
CREATE INDEX idx_experiments_project_status ON experiments (project_id, status);

-- Down Migration

DROP TABLE IF EXISTS experiments;
