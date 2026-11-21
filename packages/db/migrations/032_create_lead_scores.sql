-- Up Migration
--
-- lead_scores: the current computed score for a lead (roadmap item 7). One
-- row per lead (UNIQUE (lead_id)) — recomputing a lead's score is an UPDATE,
-- not a new INSERT, so this table always reflects the lead's current
-- standing. `criteria_evidence` is a jsonb map of criterion key ->
-- `{score, maxScore, hasEvidence, evidenceSummary?, evidenceSource?}`,
-- produced by the lead-scoring agent (apps/worker/src/agents/leadScoring.ts)
-- against a scoring_rubrics row. The (project_id, total_score DESC) index
-- exists specifically for the priority-queue feature (roadmap item 8),
-- which sorts leads within a project by score.
CREATE TABLE lead_scores (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id               uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  rubric_id             uuid REFERENCES scoring_rubrics (id) ON DELETE SET NULL,
  total_score           numeric NOT NULL CHECK (total_score >= 0 AND total_score <= 100),
  criteria_evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  why_summary           text NOT NULL,
  next_research_note    text,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_lead_scores_lead_id UNIQUE (lead_id)
);

CREATE TRIGGER trg_lead_scores_set_updated_at
  BEFORE UPDATE ON lead_scores
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_lead_scores_tenant_id ON lead_scores (tenant_id);
CREATE INDEX idx_lead_scores_project_id ON lead_scores (project_id);
CREATE INDEX idx_lead_scores_project_total_score ON lead_scores (project_id, total_score DESC);
CREATE INDEX idx_lead_scores_lead_id ON lead_scores (lead_id);

-- Down Migration

DROP TABLE IF EXISTS lead_scores;
