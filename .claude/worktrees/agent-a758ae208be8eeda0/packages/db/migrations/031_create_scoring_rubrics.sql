-- Up Migration
--
-- scoring_rubrics: a per-project, per-tenant set of weighted scoring
-- criteria (roadmap item 7, "Configurable scoring"). `criteria` is a jsonb
-- array of `{key, label, weight, description?}` objects; weights need not
-- sum to exactly 100 — the scoring agent (apps/worker/src/agents/leadScoring.ts)
-- normalizes against the sum of weights at scoring time. A project can have
-- more than one rubric (e.g. drafts/history); `is_active` marks the one
-- currently in use.
CREATE TABLE scoring_rubrics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name            text NOT NULL,
  criteria        jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_scoring_rubrics_set_updated_at
  BEFORE UPDATE ON scoring_rubrics
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_scoring_rubrics_tenant_id ON scoring_rubrics (tenant_id);
CREATE INDEX idx_scoring_rubrics_project_id ON scoring_rubrics (project_id);
CREATE INDEX idx_scoring_rubrics_project_active ON scoring_rubrics (project_id, is_active);

-- Down Migration

DROP TABLE IF EXISTS scoring_rubrics;
