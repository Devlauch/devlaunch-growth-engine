-- Up Migration
--
-- Widens leads.source (015_create_leads.sql) so a lead promoted from
-- discovered_organizations/discovered_contacts (see
-- 026/027/028_create_discovery_*.sql and apps/api/src/routes/discovery.ts's
-- promote-to-lead endpoint) can be honestly tagged 'discovery' instead of
-- being misfiled under 'agent' or 'import'.
ALTER TABLE leads DROP CONSTRAINT leads_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_source_check
  CHECK (source IN ('internal', 'public_widget', 'agent', 'import', 'discovery'));

-- Down Migration

ALTER TABLE leads DROP CONSTRAINT leads_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_source_check
  CHECK (source IN ('internal', 'public_widget', 'agent', 'import'));
