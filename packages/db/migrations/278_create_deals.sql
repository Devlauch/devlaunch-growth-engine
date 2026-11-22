-- Up Migration
--
-- deals: the real sales pipeline (Phase 2/3 "Sales Conversion Agent",
-- roadmap items 6/7). A deal is tenant/project-scoped and always tied back
-- to the lead it came from (deals.lead_id -> leads.id), the same
-- lead-centric shape every other table in this schema uses (crm_tasks,
-- lead_replies, message_drafts, sequence_enrollments all key off lead_id).
--
-- stage is the pipeline column: new -> contacted -> qualified -> proposal
-- -> won | lost. Enforced at the DB layer via CHECK (same convention as
-- leads.status / campaigns.status), with the actual lifecycle transitions
-- validated at the API layer (see apps/api/src/lib/salesPipeline.ts),
-- exactly like campaigns.status is documented as "enforced at the API
-- layer, not just this CHECK" in 020_create_campaigns.sql.
--
-- value_amount is the deal's expected/closed value. owner_user_id is the
-- sales rep responsible for this deal — a real FK into `users` (via
-- `memberships`, see apps/api/src/routes/memberships.ts for how a user
-- becomes a valid assignee of a given tenant), not a free-text name.
--
-- stage_changed_at tracks the most recent stage transition (defaults to
-- created_at on insert) and is the real signal
-- apps/api/src/lib/salesPipeline.ts uses to detect a deal that has sat in
-- a non-terminal stage too long and needs an automatic follow-up task
-- (roadmap item: "Follow-up task automation"). It is maintained by the API
-- layer (UPDATE ... SET stage = $x, stage_changed_at = now() whenever
-- stage actually changes), not by a DB trigger, so the "did the stage
-- actually change" decision stays in one place (salesPipeline.ts) instead
-- of being duplicated in SQL.
CREATE TABLE deals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  stage             text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost')),
  value_amount      numeric(12, 2),
  expected_close_date date,
  owner_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  stage_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_deals_set_updated_at
  BEFORE UPDATE ON deals
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_deals_tenant_id ON deals (tenant_id);
CREATE INDEX idx_deals_project_id ON deals (project_id);
CREATE INDEX idx_deals_lead_id ON deals (lead_id);
CREATE INDEX idx_deals_tenant_stage ON deals (tenant_id, stage);
CREATE INDEX idx_deals_owner_user_id ON deals (owner_user_id);
-- The stalled-deal detection query (salesPipeline.ts) filters on
-- tenant_id + stage NOT IN ('won','lost') + stage_changed_at, so index the
-- pair it actually scans.
CREATE INDEX idx_deals_tenant_stage_changed_at ON deals (tenant_id, stage_changed_at);

-- customers: a thin, read-only VIEW over leads won via a real deal —
-- deliberately NOT a duplicate leads table/column (leads.status's CHECK
-- constraint is owned by 015_create_leads.sql / apps/api/src/routes/
-- leads.ts and is out of scope here; widening it would risk an unrelated,
-- concurrently-edited file). A lead becomes a "customer" the instant one of
-- its deals reaches stage = 'won' — this view is the single source of
-- truth for that, computed fresh every query, never a cached/duplicated
-- flag that could drift from the real deals data.
--
-- Callers MUST still filter by tenant_id/project_id explicitly when
-- querying this view (see apps/api/src/lib/growthRevenueAnalytics.ts) —
-- Postgres views do not themselves re-derive the session's
-- app.current_tenant_id filter; the real tenant-isolation boundary remains
-- the RLS policies on the underlying `leads` and `deals` tables (see
-- 283_enable_rls_sales_conversion.sql), which a query through this view
-- still goes through.
CREATE VIEW customers AS
  SELECT DISTINCT ON (l.id)
    l.id AS lead_id,
    l.tenant_id,
    l.project_id,
    l.name,
    l.email,
    l.company,
    d.id AS won_deal_id,
    d.value_amount AS won_deal_value,
    d.stage_changed_at AS won_at
  FROM leads l
  JOIN deals d ON d.lead_id = l.id AND d.tenant_id = l.tenant_id AND d.stage = 'won'
  ORDER BY l.id, d.stage_changed_at DESC;

-- Down Migration

DROP VIEW IF EXISTS customers;
DROP TABLE IF EXISTS deals;
