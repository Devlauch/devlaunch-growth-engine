-- Up Migration
--
-- lead_score_feedback: a "good lead / bad lead" feedback button's recorded
-- votes (roadmap item 7). Append-only — a lead can be voted on more than
-- once (by the same or different users over time) and every vote is kept,
-- so this table is history, not a single current verdict. Intended to be
-- used later to tune scoring_rubrics weights, but that tuning job is not
-- part of this migration.
CREATE TABLE lead_score_feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  feedback        text NOT NULL CHECK (feedback IN ('good', 'bad')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_score_feedback_tenant_id ON lead_score_feedback (tenant_id);
CREATE INDEX idx_lead_score_feedback_lead_id ON lead_score_feedback (lead_id);
CREATE INDEX idx_lead_score_feedback_lead_created_at ON lead_score_feedback (lead_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS lead_score_feedback;
