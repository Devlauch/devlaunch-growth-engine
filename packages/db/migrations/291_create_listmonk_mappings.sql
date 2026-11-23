-- Up Migration
--
-- Milestone 2, Agent B (Listmonk). Tenant/workspace mapping tables for the
-- "one shared Listmonk instance, platform tags lists per tenant" pattern
-- documented in docs/INTEGRATION_STATUS.md's Agent B row (option (b) from
-- docs/OPEN_SOURCE_INTEGRATION_AUDIT.md's listmonk section) — listmonk has
-- no native tenant concept at all, so every remote list/subscriber/campaign
-- id listmonk hands back is meaningless on its own without a row here
-- mapping it back to a tenant-scoped platform entity. Platform's own
-- Postgres (these three tables, RLS-protected like everything else) is the
-- source of truth for "which tenant owns this remote id"; listmonk itself
-- is treated as an untrusted-ish remote API, never queried as the
-- authority on tenant ownership.
--
-- listmonk_lists: one row per (project, listmonk list). A project's
-- subscribers get synced into this list, which is tagged
-- 'platform-tenant:<tenant_id>' remotely (see listmonkSync.ts) so a human
-- browsing the shared listmonk admin UI can still tell lists apart even
-- though listmonk's own schema doesn't know about tenants.
CREATE TABLE listmonk_lists (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  integration_id     uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  listmonk_list_id   integer NOT NULL,
  listmonk_uuid      text,
  tenant_tag         text NOT NULL,
  name               text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listmonk_lists_project_key UNIQUE (project_id),
  CONSTRAINT listmonk_lists_remote_id_key UNIQUE (integration_id, listmonk_list_id)
);

CREATE TRIGGER trg_listmonk_lists_set_updated_at
  BEFORE UPDATE ON listmonk_lists
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_listmonk_lists_tenant_id ON listmonk_lists (tenant_id);

-- listmonk_subscribers: find-or-create upsert mapping from a platform
-- `leads` row to a listmonk subscriber id, by email. One row per
-- (project, lead) — a lead re-synced is an UPDATE to this row, never a
-- second remote subscriber. `sync_status`/`last_error` make failed syncs
-- (e.g. listmonk unreachable) visible to a tenant admin rather than silently
-- dropped.
CREATE TABLE listmonk_subscribers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id             uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  integration_id         uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  lead_id                uuid REFERENCES leads (id) ON DELETE CASCADE,
  email                  text NOT NULL,
  listmonk_subscriber_id integer,
  sync_status            text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed', 'skipped_suppressed')),
  last_error             text,
  last_synced_at         timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listmonk_subscribers_project_email_key UNIQUE (project_id, email)
);

CREATE TRIGGER trg_listmonk_subscribers_set_updated_at
  BEFORE UPDATE ON listmonk_subscribers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_listmonk_subscribers_tenant_id ON listmonk_subscribers (tenant_id);
CREATE INDEX idx_listmonk_subscribers_project_id ON listmonk_subscribers (project_id);
CREATE INDEX idx_listmonk_subscribers_lead_id ON listmonk_subscribers (lead_id);

-- listmonk_campaigns: one row per platform `campaigns` row that has a
-- corresponding listmonk campaign. The platform `campaigns.status` lifecycle
-- (draft -> pending_approval -> approved/rejected, via the EXISTING
-- approvals table/gate) is the only thing allowed to authorize an actual
-- send; this table only ever records the resulting remote state, it never
-- drives the approval decision itself.
CREATE TABLE listmonk_campaigns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id           uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  integration_id       uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  campaign_id          uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  listmonk_campaign_id integer NOT NULL,
  listmonk_status      text NOT NULL DEFAULT 'draft',
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listmonk_campaigns_campaign_key UNIQUE (campaign_id)
);

CREATE TRIGGER trg_listmonk_campaigns_set_updated_at
  BEFORE UPDATE ON listmonk_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_listmonk_campaigns_tenant_id ON listmonk_campaigns (tenant_id);
CREATE INDEX idx_listmonk_campaigns_project_id ON listmonk_campaigns (project_id);

-- Down Migration

DROP TABLE IF EXISTS listmonk_campaigns;
DROP TABLE IF EXISTS listmonk_subscribers;
DROP TABLE IF EXISTS listmonk_lists;
