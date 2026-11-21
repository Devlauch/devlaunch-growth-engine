-- Up Migration
--
-- message_draft_variants holds the 2-3 per-channel copy variants for a
-- message_drafts row (052_create_message_drafts.sql) — roadmap item 9's
-- "produce 2-3 variants per lead: email, WhatsApp, a call script, and a
-- short LinkedIn note". This is also the stable contract the parallel
-- "multi-step sequences" work (roadmap item 10) is expected to reference
-- directly: column names here are final.
CREATE TABLE message_draft_variants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  message_draft_id    uuid NOT NULL REFERENCES message_drafts (id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'call_script', 'linkedin_note')),
  subject             text,
  body                text NOT NULL,
  recipient_display   text,
  sender_identity     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_message_draft_variants_tenant_id ON message_draft_variants (tenant_id);
CREATE INDEX idx_message_draft_variants_message_draft_id ON message_draft_variants (message_draft_id);
CREATE INDEX idx_message_draft_variants_draft_channel ON message_draft_variants (message_draft_id, channel);

-- Down Migration

DROP TABLE IF EXISTS message_draft_variants;
