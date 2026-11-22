-- Up Migration
--
-- NOTE ON NUMBERING: originally written as 275_enable_rls_chatbot.sql, but
-- by the time this was ready, other in-flight features had already taken
-- 275 (channel_provider_configs) through 283 (sales_conversion RLS) in
-- this shared migrations directory. Renumbered up to 284 (the next free
-- slot at the time of this check) to avoid colliding with those files --
-- see this feature's report for the full numbering history
-- (271-274 content tables, this file for RLS).
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 099_enable_rls_competitors.sql, applied to the four tables added in
-- 271-274 for Phase roadmap item 4 ("Website AI Lead Capture Agent").
--
-- No special public-lookup policy (like 019_public_project_lookup_rls.sql's
-- projects policy) is needed here: the public chatbot endpoints
-- (apps/api/src/routes/publicChatbot.ts) always resolve the project via its
-- public_api_key FIRST (against the `projects` table's own existing
-- lookup policy), then call
-- `SELECT set_config('app.current_tenant_id', $1, true)` with that
-- project's real tenant_id before touching any of these four tables --
-- exactly the same sequence publicLeads.ts already uses for `leads`. Plain
-- tenant-isolation RLS is therefore sufficient and correct for all four.

ALTER TABLE chatbot_knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_knowledge_sources FORCE ROW LEVEL SECURITY;

CREATE POLICY chatbot_knowledge_sources_isolation ON chatbot_knowledge_sources
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE chatbot_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_conversations FORCE ROW LEVEL SECURITY;

CREATE POLICY chatbot_conversations_isolation ON chatbot_conversations
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE chatbot_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY chatbot_messages_isolation ON chatbot_messages
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE chatbot_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_configs FORCE ROW LEVEL SECURITY;

CREATE POLICY chatbot_configs_isolation ON chatbot_configs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS chatbot_configs_isolation ON chatbot_configs;
ALTER TABLE chatbot_configs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE chatbot_configs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chatbot_messages_isolation ON chatbot_messages;
ALTER TABLE chatbot_messages NO FORCE ROW LEVEL SECURITY;
ALTER TABLE chatbot_messages DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chatbot_conversations_isolation ON chatbot_conversations;
ALTER TABLE chatbot_conversations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE chatbot_conversations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chatbot_knowledge_sources_isolation ON chatbot_knowledge_sources;
ALTER TABLE chatbot_knowledge_sources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE chatbot_knowledge_sources DISABLE ROW LEVEL SECURITY;
