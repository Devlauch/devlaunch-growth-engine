-- seed.sql
--
-- Standalone, idempotent example data for local development: ONE example
-- tenant/project matching the spec's "DevPilot Academy" example config.
-- All data below is synthetic/example data only.
--
-- Usage:
--   psql "$DATABASE_URL" -f seed.sql
--
-- This assumes migrations (packages/db/migrations) have already been run.
--
-- Note on RLS: every tenant-owned table has FORCE ROW LEVEL SECURITY
-- (see migrations/013_enable_rls_policies.sql), so we set
-- app.current_tenant_id to this seed's own tenant id before inserting,
-- exactly as the API layer must do per request/transaction after
-- verifying membership.

DO $$
DECLARE
  v_tenant_id   uuid := '00000000-0000-0000-0000-000000000001';
  v_project_id  uuid := '00000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);

  INSERT INTO tenants (id, slug, name, industry, status, settings)
  VALUES (
    v_tenant_id,
    'devlaunch',
    'DevLaunch',
    'education',
    'active',
    '{"plan": "growth", "example": true}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE SET
    slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    industry = EXCLUDED.industry;

  INSERT INTO projects (id, tenant_id, name, slug, description, status)
  VALUES (
    v_project_id,
    v_tenant_id,
    'DevPilot Academy',
    'devpilot-academy',
    'Example project: an online academy teaching practical software/DevOps skills.',
    'active'
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    description = EXCLUDED.description;

  -- Example public_api_key for exercising the public lead-capture widget
  -- in dev (see packages/embed-widget). Synthetic value, not a secret.
  UPDATE projects
  SET
    public_api_key = COALESCE(public_api_key, 'devkey_devpilot_academy_example_only'),
    allowed_origins = ARRAY['http://localhost:3000', 'http://localhost:5173'],
    public_widget_enabled = true
  WHERE id = v_project_id;

  INSERT INTO project_profiles (
    tenant_id, project_id, company_name, industry, website_url,
    value_proposition, target_markets, goals
  )
  VALUES (
    v_tenant_id,
    v_project_id,
    'DevPilot Academy',
    'education',
    'https://devpilot.academy',
    'Hands-on, project-based courses that take learners from fundamentals to job-ready DevOps/engineering skills.',
    ARRAY['United States', 'India', 'United Kingdom'],
    '{"primary_goal": "increase qualified enrollment leads", "target_monthly_leads": 500}'::jsonb
  )
  ON CONFLICT (project_id) DO UPDATE SET
    value_proposition = EXCLUDED.value_proposition,
    target_markets = EXCLUDED.target_markets,
    goals = EXCLUDED.goals;

  -- Global agent template catalog entry for the Phase 1 demo agent. NULL
  -- tenant_id = visible to every tenant (see agent_templates_isolation RLS
  -- policy). Matches packages/agent-sdk's market-research AgentDefinition.
  INSERT INTO agent_templates (tenant_id, key, name, description, category, version, default_config)
  VALUES (
    NULL,
    'market-research',
    'Market Research (stub)',
    'Phase 1 demo agent. Accepts {industry, geography, segment, question} and returns a mocked-but-schema-valid structured research result. Real Crawl4AI-backed research is later-phase work.',
    'growth',
    1,
    '{}'::jsonb
  )
  ON CONFLICT (tenant_id, key, version) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description;

  -- icp_profiles has no natural unique key, so make this idempotent by
  -- clearing this project's segments first, then re-inserting them.
  DELETE FROM icp_profiles WHERE project_id = v_project_id;

  INSERT INTO icp_profiles (
    tenant_id, project_id, name, segment, description, pain_points, channels, is_primary
  )
  VALUES
  (
    v_tenant_id, v_project_id,
    'Career Switchers', 'career_switchers',
    'Working adults (25-40) looking to move into tech/DevOps roles from an unrelated field.',
    ARRAY['lack of a clear learning path', 'no portfolio to show employers', 'limited time to study'],
    ARRAY['linkedin', 'google_search', 'referral'],
    true
  ),
  (
    v_tenant_id, v_project_id,
    'Recent CS Graduates', 'recent_grads',
    'Recent computer science / bootcamp graduates who need practical, production-style experience.',
    ARRAY['degree does not equal job-ready skills', 'no real-world project experience', 'competitive entry-level market'],
    ARRAY['instagram', 'youtube', 'campus_partnerships'],
    false
  ),
  (
    v_tenant_id, v_project_id,
    'Upskilling Professionals', 'upskillers',
    'Current junior developers/sysadmins upskilling into DevOps/cloud roles for a promotion or raise.',
    ARRAY['employer not sponsoring training', 'unsure which certs/skills matter', 'needs flexible evening/weekend pace'],
    ARRAY['linkedin', 'email_newsletter', 'webinars'],
    false
  );
END $$;
