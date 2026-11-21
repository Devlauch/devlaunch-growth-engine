-- Up Migration
--
-- message_drafts is roadmap item 9 ("Personalized message drafting"):
-- the Marketing agent drafts messages using only approved claims plus
-- evidence found for a lead, and flags any claim with no source for
-- human review (unsourced_claims below). This table holds the draft
-- itself (the "why"/evidence behind it); the actual per-channel copy
-- lives in message_draft_variants (053_create_message_draft_variants.sql).
--
-- Reuses the existing approvals table/state-machine exactly like
-- campaigns does (020_create_campaigns.sql /
-- 023_add_campaign_id_to_approvals.sql) rather than inventing a parallel
-- approval mechanism: approval_id is set once a draft is submitted for
-- approval, and status here mirrors (but does not replace) the
-- approvals row's own status.
CREATE TABLE message_drafts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id             uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected')),
  approval_id         uuid REFERENCES approvals (id) ON DELETE SET NULL,
  evidence_summary    text NOT NULL,
  unsourced_claims    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_message_drafts_set_updated_at
  BEFORE UPDATE ON message_drafts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_message_drafts_tenant_id ON message_drafts (tenant_id);
CREATE INDEX idx_message_drafts_project_id ON message_drafts (project_id);
CREATE INDEX idx_message_drafts_lead_id ON message_drafts (lead_id);
CREATE INDEX idx_message_drafts_tenant_status ON message_drafts (tenant_id, status);

-- Down Migration

DROP TABLE IF EXISTS message_drafts;
