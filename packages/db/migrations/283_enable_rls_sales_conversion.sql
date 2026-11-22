-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql / 029_enable_rls_discovery.sql, applied to the
-- four tables added in 278_create_deals.sql, 279_create_lead_assignments.sql,
-- 280_create_meetings.sql and 281_create_follow_up_tasks.sql.
--
-- The `customers` view (defined in 278_create_deals.sql) has no RLS policy
-- of its own — views aren't tables and can't carry one — but every row it
-- can ever produce still passes through the real RLS policies on the
-- underlying `leads` and `deals` tables below, so it is never a tenant-
-- isolation bypass.

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE ROW LEVEL SECURITY;

CREATE POLICY deals_isolation ON deals
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE lead_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_assignments_isolation ON lead_assignments
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings FORCE ROW LEVEL SECURITY;

CREATE POLICY meetings_isolation ON meetings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE follow_up_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY follow_up_tasks_isolation ON follow_up_tasks
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS follow_up_tasks_isolation ON follow_up_tasks;
ALTER TABLE follow_up_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE follow_up_tasks DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meetings_isolation ON meetings;
ALTER TABLE meetings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE meetings DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_assignments_isolation ON lead_assignments;
ALTER TABLE lead_assignments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_assignments DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deals_isolation ON deals;
ALTER TABLE deals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE deals DISABLE ROW LEVEL SECURITY;
