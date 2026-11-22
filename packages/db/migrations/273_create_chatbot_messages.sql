-- Up Migration
--
-- Phase roadmap item 4, "Website AI Lead Capture Agent". One row per
-- message in a chatbot_conversations thread, for full auditability of what
-- the bot said and why. `matched_knowledge_source_id` + `confidence_score`
-- are set on bot messages that answered from a knowledge entry (see
-- apps/api/src/lib/chatbotEngine.ts's matchKnowledge) -- both NULL means
-- either a visitor message, or a bot message that was NOT a knowledge
-- match (a flow prompt like the consent notice, a qualifying question, or
-- the honest "I don't have an answer for that" fallback).
CREATE TABLE chatbot_messages (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id             uuid NOT NULL REFERENCES chatbot_conversations (id) ON DELETE CASCADE,
  role                        text NOT NULL CHECK (role IN ('visitor', 'bot')),
  content                     text NOT NULL,
  matched_knowledge_source_id uuid REFERENCES chatbot_knowledge_sources (id) ON DELETE SET NULL,
  confidence_score            numeric(5, 4),
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chatbot_messages_tenant_id ON chatbot_messages (tenant_id);
CREATE INDEX idx_chatbot_messages_conversation_id ON chatbot_messages (conversation_id);
CREATE INDEX idx_chatbot_messages_conversation_created_at ON chatbot_messages (conversation_id, created_at ASC);

-- Down Migration

DROP TABLE IF EXISTS chatbot_messages;
