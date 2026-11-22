-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 022_enable_rls_campaigns.sql, applied to the three tables added in
-- 066/067/068 for Phase 2 item 1 ("Competitor Intelligence Agent").

ALTER TABLE competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitors FORCE ROW LEVEL SECURITY;

CREATE POLICY competitors_isolation ON competitors
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE competitor_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY competitor_snapshots_isolation ON competitor_snapshots
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE competitor_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_changes FORCE ROW LEVEL SECURITY;

CREATE POLICY competitor_changes_isolation ON competitor_changes
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS competitor_changes_isolation ON competitor_changes;
ALTER TABLE competitor_changes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE competitor_changes DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competitor_snapshots_isolation ON competitor_snapshots;
ALTER TABLE competitor_snapshots NO FORCE ROW LEVEL SECURITY;
ALTER TABLE competitor_snapshots DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competitors_isolation ON competitors;
ALTER TABLE competitors NO FORCE ROW LEVEL SECURITY;
ALTER TABLE competitors DISABLE ROW LEVEL SECURITY;
