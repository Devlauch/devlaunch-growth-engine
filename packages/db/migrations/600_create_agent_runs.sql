-- Up Migration
--
-- Workstream A1: native, tenant-aware AI agent platform core. One row per
-- real agentRunner.ts runAgent() invocation — the minimal per-run memory
-- store (apps/api/src/lib/agentPlatform/core/agentMemory.ts) that also
-- doubles as "execution history" for GET .../agents/:agentKey/runs. Same
-- tenant+project scoping and RLS pattern as every other tenant-owned table
-- in this schema (see e.g. 551_create_seo_campaigns.sql /
-- 552_enable_rls_seo_campaigns.sql); project_id is nullable since an agent
-- run's context.projectId can itself be null (platform-level invocation),
-- same nullable convention as deals.deal_id on meetings
-- (280_create_meetings.sql).
--
-- input/output are stored as real jsonb snapshots of exactly what was sent
-- to/received from the agent for that run — never a fabricated or
-- estimated summary. tokens_used is the real
-- (inputTokens + outputTokens) sum reported by the provider for that run
-- (0 when status is 'not_configured' or 'budget_exceeded', since no real
-- call was made).
CREATE TABLE agent_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects (id) ON DELETE CASCADE,
  agent_key   text NOT NULL,
  input       jsonb NOT NULL DEFAULT '{}'::jsonb,
  output      jsonb,
  status      text NOT NULL CHECK (status IN ('ok', 'not_configured', 'budget_exceeded', 'error')),
  tokens_used integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_runs_tenant_id ON agent_runs (tenant_id);
CREATE INDEX idx_agent_runs_tenant_agent_created_at ON agent_runs (tenant_id, agent_key, created_at DESC);
CREATE INDEX idx_agent_runs_project_id ON agent_runs (project_id);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_runs_isolation ON agent_runs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS agent_runs_isolation ON agent_runs;
DROP TABLE IF EXISTS agent_runs;
