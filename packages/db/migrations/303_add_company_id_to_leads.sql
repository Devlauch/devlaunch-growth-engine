-- Up Migration
--
-- Additive link from leads to the new first-class `companies` table
-- (302_create_companies.sql). leads.company (free text, 015_create_leads.sql)
-- is intentionally left untouched: it is the original string a lead typed
-- into a form (internal entry or the public widget), it is NOT owned by
-- this migration, and widening/removing it would touch
-- apps/api/src/routes/leads.ts and apps/api/src/lib/leadIngestion.ts, both
-- out of scope here and plausibly being edited concurrently.
--
-- company_id is nullable and ON DELETE SET NULL — linking a lead to a real
-- company is an explicit, optional, API-layer action (never inferred by
-- this migration), and deleting a company must never cascade-delete the
-- leads that reference it; it should just unlink them.
--
-- The two columns are expected to coexist during a transition period:
-- leads.company (free text, always present if typed) and leads.company_id
-- (set once a tenant has consolidated/linked that lead to a real company
-- record). Nothing in this migration backfills company_id from
-- leads.company — that would require fuzzy name matching, which belongs in
-- an API-layer tool, not a migration.
ALTER TABLE leads ADD COLUMN company_id uuid REFERENCES companies (id) ON DELETE SET NULL;

CREATE INDEX idx_leads_company_id ON leads (company_id);

-- Down Migration

DROP INDEX IF EXISTS idx_leads_company_id;
ALTER TABLE leads DROP COLUMN IF EXISTS company_id;
