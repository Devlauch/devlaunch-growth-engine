-- Up Migration
--
-- companies: a real first-class entity for the CRM, distinct from
-- leads.company (a free-text string captured at lead-ingestion time — see
-- 015_create_leads.sql). Today a "company" is just whatever string a lead
-- typed into a form; this table lets a tenant consolidate those into one
-- real, editable record (domain, industry, size_range, notes) that
-- multiple leads/contacts/deals can eventually point back to.
--
-- Deliberately NOT populated automatically from leads.company on insert —
-- that would require fuzzy name-matching/dedup logic this migration has no
-- business doing. Linking an existing lead to a company (leads.company_id,
-- see 303_add_company_id_to_leads.sql) is an explicit, API-layer action.
-- (Renumbered from an initial 300/301/302 draft to 302/303/304 to avoid
-- colliding with Agent D's reserved 299-301 migration range — see
-- docs/INTEGRATION_STATUS.md.)
--
-- size_range is a loose bucket (e.g. "1-10", "11-50", "51-200", "201-1000",
-- "1000+"), intentionally a free-text column rather than a CHECK-enforced
-- enum — this is CRM metadata a sales rep fills in by hand, not a value
-- the API layer drives state off of (unlike deals.stage/leads.status).
CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name        text NOT NULL,
  domain      text,
  industry    text,
  size_range  text,
  notes       text,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_companies_set_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_companies_tenant_id ON companies (tenant_id);
CREATE INDEX idx_companies_project_id ON companies (project_id);
-- Primary list/search access pattern: "companies for this project, by
-- name" (dashboard CompaniesPage) and "does a company with this domain
-- already exist" (future dedup-on-create check at the API layer).
CREATE INDEX idx_companies_tenant_project_name ON companies (tenant_id, project_id, name);
CREATE INDEX idx_companies_domain ON companies (domain);

-- Down Migration

DROP TABLE IF EXISTS companies;
