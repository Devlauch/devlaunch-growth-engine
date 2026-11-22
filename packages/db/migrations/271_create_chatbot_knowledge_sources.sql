-- Up Migration
--
-- Phase roadmap item 4, "Website AI Lead Capture Agent" (chatbot). One row
-- per client-approved Q&A/FAQ entry the chatbot is allowed to answer from.
--
-- Honesty contract: the chatbot engine (apps/api/src/lib/chatbotEngine.ts)
-- only ever matches against rows where status = 'approved' AND
-- is_active = true. Two ways a row gets here:
--   1. origin = 'manual'         -- the client/tenant typed it in directly
--      via apps/api/src/routes/chatbotAdmin.ts. Trusted immediately
--      (status defaults to 'approved') -- this is the client's own
--      authored content, not scraped/third-party text.
--   2. origin = 'website_import' -- extracted from the client's own site by
--      crawling it (see apps/api/src/lib/crawl4aiClient.ts, reused from the
--      competitor-intelligence feature) and heuristically splitting it into
--      candidate FAQ-like snippets (apps/api/src/lib/chatbotEngine.ts's
--      extractFaqSnippets). These ALWAYS land with
--      status = 'pending_review' and is_active = false -- never
--      auto-published -- until a human approves them via
--      PATCH .../knowledge-sources/:id/approve. The chatbot engine's query
--      filter (status = 'approved') makes it structurally impossible for an
--      un-reviewed scraped snippet to ever be used as a live bot answer.
CREATE TABLE chatbot_knowledge_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  question    text NOT NULL,
  answer      text NOT NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  origin      text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'website_import')),
  status      text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending_review', 'approved', 'rejected')),
  source_url  text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A website_import row is created with status='pending_review' and
-- is_active=false by application code (chatbotAdmin.ts) -- enforced there,
-- not by a CHECK constraint (a human approving it is exactly what's allowed
-- to flip those columns). The real guarantee against unapproved content
-- ever answering a visitor lives in chatbotEngine.ts's query filter, always
-- `WHERE status = 'approved' AND is_active = true`.

CREATE TRIGGER trg_chatbot_knowledge_sources_set_updated_at
  BEFORE UPDATE ON chatbot_knowledge_sources
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_chatbot_knowledge_sources_tenant_id ON chatbot_knowledge_sources (tenant_id);
CREATE INDEX idx_chatbot_knowledge_sources_project_id ON chatbot_knowledge_sources (project_id);
CREATE INDEX idx_chatbot_knowledge_sources_project_status ON chatbot_knowledge_sources (project_id, status, is_active);

-- Down Migration

DROP TABLE IF EXISTS chatbot_knowledge_sources;
