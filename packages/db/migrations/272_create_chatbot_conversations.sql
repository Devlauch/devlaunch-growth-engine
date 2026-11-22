-- Up Migration
--
-- Phase roadmap item 4, "Website AI Lead Capture Agent". One row per
-- visitor browser session talking to the embeddable chatbot widget
-- (packages/embed-widget/chatbot.js). Unauthenticated-by-design, same
-- project-public-key + origin-allowlist trust model as `leads` (see
-- 016_add_project_public_key.sql / 019_public_project_lookup_rls.sql) --
-- apps/api/src/routes/publicChatbot.ts resolves tenant_id/project_id from
-- the project's public_api_key before ever writing a row here.
--
-- `status` is the conversation-flow state machine driven by
-- apps/api/src/lib/chatbotEngine.ts / apps/api/src/routes/publicChatbot.ts:
--   active            -- bot answering from approved knowledge, or honest
--                         fallback, no PII captured yet.
--   awaiting_consent  -- qualifying trigger reached (N exchanges or explicit
--                         enquiry intent); bot asked the consent notice and
--                         is waiting for a yes/no.
--   qualifying        -- consent accepted; bot is asking the project's
--                         configured qualifying question(s)
--                         (chatbot_configs.qualifying_questions).
--   awaiting_contact   -- qualifying questions answered; bot asked for
--                         name/email so it can capture the lead.
--   captured          -- a `leads` row (lead_id) and a `consent_records` row
--                         (consent_record_id) were created through the
--                         existing ingestion/consent paths.
--   ended             -- visitor declined consent, or conversation closed
--                         without ever capturing contact info.
CREATE TABLE chatbot_conversations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id               uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'awaiting_consent', 'qualifying', 'awaiting_contact', 'captured', 'ended')),
  consent_given            boolean NOT NULL DEFAULT false,
  consent_record_id        uuid REFERENCES consent_records (id) ON DELETE SET NULL,
  lead_id                  uuid REFERENCES leads (id) ON DELETE SET NULL,
  qualifying_question_index int NOT NULL DEFAULT 0,
  -- Ordered array of the visitor's literal answers collected while in the
  -- 'qualifying' stage (one appended per qualifying question answered).
  -- Stored directly here (rather than reconstructed from chatbot_messages)
  -- because ambiguous consent retries can add extra visitor messages before
  -- 'qualifying' even starts, which would otherwise make a message-order
  -- reconstruction fragile. The first entry becomes leads.qualifying_answer
  -- (see routes/publicChatbot.ts) -- same column the inbound lead-capture
  -- widget already writes to (065_add_widget_config_to_projects.sql /
  -- src/lib/leadIngestion.ts), never a parallel field.
  qualifying_answers       jsonb NOT NULL DEFAULT '[]'::jsonb,
  visitor_exchange_count   int NOT NULL DEFAULT 0,
  origin                   text,
  started_at               timestamptz NOT NULL DEFAULT now(),
  last_message_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chatbot_conversations_tenant_id ON chatbot_conversations (tenant_id);
CREATE INDEX idx_chatbot_conversations_project_id ON chatbot_conversations (project_id);
CREATE INDEX idx_chatbot_conversations_project_started_at ON chatbot_conversations (project_id, started_at DESC);

-- Down Migration

DROP TABLE IF EXISTS chatbot_conversations;
