-- Up Migration
--
-- Seeds one example tenant/project for local development, matching the
-- spec's "DevPilot Academy" example configuration. All data here is
-- synthetic/example data, safe to run against any dev database.
--
-- Because every tenant-owned table has FORCE ROW LEVEL SECURITY, we set
-- app.current_tenant_id (tx-local, via set_config(..., true)) to this
-- seed's own tenant id before inserting, so the RLS WITH CHECK clauses
-- are satisfied. This mirrors exactly what the API layer must do per
-- request/transaction.

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
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO projects (id, tenant_id, name, slug, description, status)
  VALUES (
    v_project_id,
    v_tenant_id,
    'DevPilot Academy',
    'devpilot-academy',
    'Example project: an online academy teaching practical software/DevOps skills.',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

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
  ON CONFLICT (project_id) DO NOTHING;

  -- Global agent template catalog entry for the Phase 1 demo agent (NULL
  -- tenant_id = visible to every tenant).
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
  ON CONFLICT (tenant_id, key, version) DO NOTHING;

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
  )
  ON CONFLICT DO NOTHING;
END $$;

-- Down Migration

DELETE FROM agent_templates WHERE tenant_id IS NULL AND key = 'market-research' AND version = 1;
DELETE FROM icp_profiles WHERE project_id = '00000000-0000-0000-0000-000000000002';
DELETE FROM project_profiles WHERE project_id = '00000000-0000-0000-0000-000000000002';
DELETE FROM projects WHERE id = '00000000-0000-0000-0000-000000000002';
DELETE FROM tenants WHERE id = '00000000-0000-0000-0000-000000000001';
