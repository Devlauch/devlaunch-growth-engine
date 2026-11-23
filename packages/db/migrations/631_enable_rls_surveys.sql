-- Up Migration
--
-- Same tenant-isolation pattern as 552_enable_rls_seo_campaigns.sql, PLUS a
-- narrowly-scoped public-lookup carve-out mirroring
-- 560_custom_domain_public_lookup_rls.sql's exact shape: a public,
-- unauthenticated caller (the embeddable widget,
-- packages/embed-widget/surveys.js, via
-- apps/api/src/routes/publicSurveys.ts) may SELECT exactly one survey row
-- by its own id, and only when status = 'active' — it can never browse or
-- enumerate other tenants' surveys, and this grants no write access
-- (WITH CHECK is unchanged, so every INSERT/UPDATE still requires a real
-- app.current_tenant_id matching the row). The survey's own uuid `id` is
-- already an unguessable 128-bit token, so (unlike the custom-domain case)
-- no extra public-token column is needed — the lookup key is just the
-- primary key, scoped via `app.lookup_survey_id` the same way
-- `app.lookup_public_api_key` and `app.lookup_custom_domain` scope theirs.

ALTER TABLE surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE surveys FORCE ROW LEVEL SECURITY;

CREATE POLICY surveys_isolation ON surveys
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    OR (
      status = 'active'
      AND id = current_setting('app.lookup_survey_id', true)::uuid
    )
  )
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS surveys_isolation ON surveys;
ALTER TABLE surveys NO FORCE ROW LEVEL SECURITY;
ALTER TABLE surveys DISABLE ROW LEVEL SECURITY;
