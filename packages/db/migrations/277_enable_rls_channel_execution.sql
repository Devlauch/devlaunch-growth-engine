-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration
-- (e.g. 059_enable_rls_lead_replies.sql, 063_enable_rls_sending.sql),
-- applied to 275_create_channel_provider_configs.sql.
--
-- campaign_attribution (276_create_campaign_attribution.sql) is a VIEW, not
-- a table — Postgres has no ALTER TABLE ... ENABLE ROW LEVEL SECURITY for
-- views, so there is nothing to enable here for it. It needs nothing of its
-- own because every table it reads from (campaigns, campaign_members,
-- sequence_enrollments, lead_replies) already has FORCE ROW LEVEL SECURITY
-- applied, and a plain (non-SECURITY DEFINER, no special owner privileges
-- beyond the single shared app role every migration in this codebase runs
-- as) view executes those policies against the querying session's own
-- app.current_tenant_id exactly as a direct query against those tables
-- would — see 013_enable_rls_policies.sql's "FORCE ROW LEVEL SECURITY is
-- applied ... so that RLS also applies to the table owner" note, which is
-- exactly the property that makes this safe: the view's owner is the same
-- migration-running role that owns the underlying tables, so FORCE ROW
-- LEVEL SECURITY means even that owner (and therefore the view querying
-- through it) cannot bypass the policies.
ALTER TABLE channel_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_provider_configs FORCE ROW LEVEL SECURITY;

CREATE POLICY channel_provider_configs_isolation ON channel_provider_configs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS channel_provider_configs_isolation ON channel_provider_configs;
ALTER TABLE channel_provider_configs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_provider_configs DISABLE ROW LEVEL SECURITY;
