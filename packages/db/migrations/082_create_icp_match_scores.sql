-- Up Migration
--
-- icp_match_scores: how well a given lead matches a given named ICP persona
-- (icp_profiles, see 007_create_icp_profiles.sql). This is a distinct,
-- complementary signal from the existing rubric-based scoring
-- (lead_scores, 032_create_lead_scores.sql) — ICP-fit is about which named
-- persona this lead resembles, not a generic qualification score. A lead
-- is scored against every ICP profile in its project, one row per
-- (lead, icp_profile) pair, re-upserted whenever matching is re-run.
CREATE TABLE icp_match_scores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  icp_profile_id    uuid NOT NULL REFERENCES icp_profiles (id) ON DELETE CASCADE,
  match_score       numeric NOT NULL CHECK (match_score >= 0 AND match_score <= 100),
  -- Array of real strings naming which signal matched, e.g. "custom_fields.role
  -- mentions a pain point keyword from this ICP" — never padded with invented detail.
  match_reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_icp_match_scores_lead_icp UNIQUE (lead_id, icp_profile_id)
);

CREATE INDEX idx_icp_match_scores_tenant_id ON icp_match_scores (tenant_id);
CREATE INDEX idx_icp_match_scores_project_id ON icp_match_scores (project_id);
CREATE INDEX idx_icp_match_scores_lead_id ON icp_match_scores (lead_id);
CREATE INDEX idx_icp_match_scores_project_match_score ON icp_match_scores (project_id, match_score DESC);

-- Down Migration

DROP TABLE IF EXISTS icp_match_scores;
