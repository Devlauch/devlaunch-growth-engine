-- Up Migration
--
-- AI Growth Advisor (distinct from, and NOT to be confused with, the
-- existing `growth_recommendations` table created by
-- 261_create_growth_recommendations.sql, which holds per-run suggestions
-- from the one-shot website Growth Analyzer/crawler in
-- apps/api/src/lib/growthAnalyzer.ts — this is a different feature. Named
-- growth_advisor_recommendations throughout to avoid any naming collision
-- with that pre-existing table.)
--
-- growth_advisor_recommendations is one row per real, rule-detected growth
-- problem for a tenant/project (e.g. "this prospecting campaign's invalid-
-- email rate is too high", "N leads have never been assigned to a rep").
-- Every row here is produced by a real SQL aggregation against existing
-- tables (apps/api/src/lib/growthAdvisor.ts) — never an LLM-narrated or
-- invented "fact", same honesty convention as every other "AI agent" in
-- this codebase (see growthAnalyzer.ts, contentGeneration.ts,
-- marketingQa.ts).
--
-- rule_key identifies which rule produced this row. For a rule that can
-- fire more than once per project (e.g. once per prospecting campaign, or
-- once per landing page), the specific entity's id is encoded into
-- rule_key itself (e.g. 'high_invalid_email_rate:<campaignId>') so each
-- instance upserts independently — see runGrowthAdvisor's "update the open
-- row for this rule_key, else insert" logic. Project-level, singleton
-- rules (e.g. 'too_many_unassigned_leads') use a bare rule_key.
--
-- evidence is the real query result(s) the rule based its decision on
-- (counts, rates, ids) — always re-derivable from live data, never cached
-- beyond "last computed at updated_at". suggested_action is nullable and
-- only populated for the one rule that has a real, approval-gated action
-- wired up (see 434_create_growth_advisor_actions.sql); it records what
-- that action WOULD do, not a performed side effect.
CREATE TABLE growth_advisor_recommendations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  rule_key          text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  title             text NOT NULL,
  description       text NOT NULL,
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'dismissed', 'actioned')),
  suggested_action  jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_growth_advisor_recommendations_set_updated_at
  BEFORE UPDATE ON growth_advisor_recommendations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_growth_advisor_recommendations_tenant_id ON growth_advisor_recommendations (tenant_id);
CREATE INDEX idx_growth_advisor_recommendations_project_id ON growth_advisor_recommendations (project_id);
CREATE INDEX idx_growth_advisor_recommendations_status ON growth_advisor_recommendations (tenant_id, status);
CREATE INDEX idx_growth_advisor_recommendations_rule_key ON growth_advisor_recommendations (tenant_id, project_id, rule_key);

-- Down Migration

DROP TABLE IF EXISTS growth_advisor_recommendations;
