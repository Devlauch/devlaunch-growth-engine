-- Up Migration
--
-- NOTE ON NUMBERING: the task range handed to this feature reserved
-- 271-273 for knowledge_sources/conversations/messages and 274 for
-- "enable_rls_chatbot". While building the real qualifying-question +
-- consent flow it became clear a small per-project settings row (enabled
-- flag, welcome/fallback copy, the 1-3 configurable qualifying questions,
-- the exchange count before qualifying, the match confidence threshold) is
-- needed, and that it belongs in its own table rather than overloading
-- chatbot_knowledge_sources (a content table) or ALTERing the heavily
-- shared `projects` table (several other in-flight features already ALTER
-- it -- see 210/220_*.sql -- so a new, narrowly-scoped table is lower risk
-- than adding more columns there). So this migration was inserted as 274
-- and "enable_rls_chatbot" was pushed to 275 -- the only renumbering done
-- in this feature's reserved range.
--
-- Phase roadmap item 4, "Website AI Lead Capture Agent". One row per
-- project (created lazily on first GET/PATCH by
-- apps/api/src/routes/chatbotAdmin.ts). `qualifying_questions` holds at
-- most 3 entries (enforced in the route's zod schema, not here) -- this is
-- the SAME "ask a qualifying question before/while capturing a lead"
-- concept already shipped for the inbound lead-capture widget
-- (projects.widget_qualifying_question / leads.qualifying_answer -- see
-- 065_add_widget_config_to_projects.sql and
-- apps/api/src/lib/leadIngestion.ts), just generalized here to up to 3
-- questions and scoped to the chatbot specifically; the chatbot's capture
-- step still writes into the exact same `leads.qualifying_answer` column
-- (the first configured question's answer) rather than a parallel field.
CREATE TABLE chatbot_configs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id                uuid NOT NULL UNIQUE REFERENCES projects (id) ON DELETE CASCADE,
  enabled                   boolean NOT NULL DEFAULT false,
  welcome_message           text NOT NULL DEFAULT 'Hi! Ask me anything and I''ll do my best to help.',
  fallback_message          text NOT NULL DEFAULT 'I don''t have an answer for that yet -- want to leave your details so our team can follow up?',
  consent_notice            text NOT NULL DEFAULT 'Before I take your details, do you consent to us storing them to follow up with you? (yes/no)',
  qualifying_questions      text[] NOT NULL DEFAULT '{}',
  exchanges_before_qualifying int NOT NULL DEFAULT 3 CHECK (exchanges_before_qualifying >= 1),
  confidence_threshold      numeric(4, 3) NOT NULL DEFAULT 0.200 CHECK (confidence_threshold >= 0 AND confidence_threshold <= 1),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_chatbot_configs_set_updated_at
  BEFORE UPDATE ON chatbot_configs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_chatbot_configs_tenant_id ON chatbot_configs (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS chatbot_configs;
