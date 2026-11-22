-- Up Migration
--
-- Individual, actionable suggestions produced by one growth_analyses run
-- (260_create_growth_analyses.sql) — one row per suggestion so each can be
-- accepted/tracked independently (today only the 'icp' type has an
-- acceptance action: POST .../growth-analyses/:id/accept-icp in
-- apps/api/src/routes/growthAnalyzer.ts, which copies `detail` into a new
-- row in the EXISTING icp_profiles table, 007_create_icp_profiles.sql —
-- deliberately not a new ICP table/column, to avoid touching
-- icpProfiles.ts's schema while it's being edited elsewhere this round).

CREATE TABLE growth_recommendations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id              uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  growth_analysis_id      uuid NOT NULL REFERENCES growth_analyses (id) ON DELETE CASCADE,
  recommendation_type     text NOT NULL
                            CHECK (recommendation_type IN ('icp', 'content_gap', 'conversion_opportunity', 'competitor_opportunity')),
  title                   text NOT NULL,
  detail                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted                boolean NOT NULL DEFAULT false,
  accepted_at             timestamptz,
  accepted_icp_profile_id uuid REFERENCES icp_profiles (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_growth_recommendations_tenant_id ON growth_recommendations (tenant_id);
CREATE INDEX idx_growth_recommendations_project_id ON growth_recommendations (project_id);
CREATE INDEX idx_growth_recommendations_analysis_id ON growth_recommendations (growth_analysis_id);

-- Down Migration

DROP TABLE IF EXISTS growth_recommendations;
