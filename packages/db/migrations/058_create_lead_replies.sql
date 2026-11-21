-- Up Migration
--
-- lead_replies: roadmap item 13, "Reply handling" — read replies, classify
-- them (interested, not now, wrong person, unsubscribe), and draft a
-- response for approval; create a CRM task for every positive reply.
--
-- No live inbox integration exists yet in this codebase (deliberate, see
-- src/lib/integrations.ts's not-connected registry): this table is fed by
-- a manual/webhook ingestion endpoint (POST .../leads/:leadId/replies, see
-- src/routes/replies.ts) where a human pastes in a reply today, and a real
-- inbox integration can post to the exact same endpoint later without any
-- schema change. The classification itself (apps/api/src/lib/classifyReply.ts)
-- and its downstream effects (CRM task creation, draft skeleton, suppression
-- + sequence-stop on unsubscribe) are real; only the inbound trigger is
-- manual for now.
--
-- draft_response_id / crm_task_id point at the message_drafts /
-- crm_tasks rows this reply caused to be created, when applicable (e.g. an
-- 'unclassified' reply creates neither, so both stay null).
CREATE TABLE lead_replies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id                uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id                   uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  channel                   text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'linkedin', 'phone', 'other')),
  raw_content               text NOT NULL,
  classification            text NOT NULL CHECK (classification IN ('interested', 'not_now', 'wrong_person', 'unsubscribe', 'unclassified')),
  classification_confidence text NOT NULL CHECK (classification_confidence IN ('high', 'medium', 'low')),
  draft_response_id         uuid REFERENCES message_drafts (id) ON DELETE SET NULL,
  crm_task_id               uuid REFERENCES crm_tasks (id) ON DELETE SET NULL,
  received_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_replies_tenant_id ON lead_replies (tenant_id);
CREATE INDEX idx_lead_replies_project_id ON lead_replies (project_id);
CREATE INDEX idx_lead_replies_lead_id ON lead_replies (lead_id);
CREATE INDEX idx_lead_replies_tenant_classification ON lead_replies (tenant_id, classification);

-- Down Migration

DROP TABLE IF EXISTS lead_replies;
