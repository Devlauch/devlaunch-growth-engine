-- Up Migration
--
-- contacts: a real person at a company, distinct from `leads` (an inbound/
-- discovery-sourced row — see 015_create_leads.sql's header comment: "any
-- source: internal agent, manual entry, or the public embeddable widget").
-- A contact is CRM data a sales rep maintains directly (title, direct
-- phone/email), not something captured passively from an inbound form.
--
-- company_id links a contact to the first-class companies table
-- (302_create_companies.sql) — nullable, because a contact can exist
-- before any company record has been created for them (ON DELETE SET
-- NULL: deleting a company must never delete the people associated with
-- it, just unlink them).
--
-- lead_id is the optional "this contact originated as this lead" pointer
-- — set when a sales rep promotes/converts a lead into a tracked contact.
-- Deliberately nullable + ON DELETE SET NULL (same reasoning as
-- deals.lead_id being NOT NULL doesn't apply here: a contact is allowed to
-- exist with no lead history at all, e.g. one added by hand from a
-- conference). Unlike deals (which REQUIRE a lead_id, since a deal only
-- ever exists because a lead became qualified), a contact is a standalone
-- person record first.
CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  company_id  uuid REFERENCES companies (id) ON DELETE SET NULL,
  lead_id     uuid REFERENCES leads (id) ON DELETE SET NULL,
  name        text NOT NULL,
  email       text,
  phone       text,
  title       text,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_contacts_set_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_contacts_tenant_id ON contacts (tenant_id);
CREATE INDEX idx_contacts_project_id ON contacts (project_id);
-- Primary access pattern: "contacts at this company" (dashboard company
-- detail view, GET /contacts?companyId=...).
CREATE INDEX idx_contacts_tenant_project_company_id ON contacts (tenant_id, project_id, company_id);
CREATE INDEX idx_contacts_lead_id ON contacts (lead_id);
CREATE INDEX idx_contacts_email ON contacts (email);

-- Down Migration

DROP TABLE IF EXISTS contacts;
