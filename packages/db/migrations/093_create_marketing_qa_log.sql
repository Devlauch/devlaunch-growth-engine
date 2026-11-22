-- Up Migration
--
-- Phase 2 item 6 ("Marketing Intelligence Agent"): "Ask questions in
-- natural language." apps/api/src/lib/marketingQa.ts is a deterministic
-- intent classifier (NOT an LLM — no LLM API key is wired up in this
-- environment), same ordered-rules convention as
-- apps/api/src/lib/classifyReply.ts. marketing_qa_log is the honest audit
-- trail of every question asked through it: `matched_intent` is NULL when
-- the question didn't match any supported pattern (logged honestly as
-- unmatched, never silently dropped), and `answer_summary` always holds the
-- real text returned to the user (including the "I can't answer that yet"
-- fallback on a miss).
CREATE TABLE marketing_qa_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  question        text NOT NULL,
  matched_intent  text,
  answer_summary  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_marketing_qa_log_tenant_id ON marketing_qa_log (tenant_id);
CREATE INDEX idx_marketing_qa_log_project_id ON marketing_qa_log (project_id);
CREATE INDEX idx_marketing_qa_log_project_created_at ON marketing_qa_log (project_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS marketing_qa_log;
