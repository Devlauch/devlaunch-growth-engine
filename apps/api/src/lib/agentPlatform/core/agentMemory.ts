import type { PoolClient } from "pg";

/**
 * agentMemory.ts: Workstream A1 minimal per-run memory store ("execution
 * history"). Backed by the new agent_runs table (see
 * packages/db/migrations/600_create_agent_runs.sql) — one row per
 * runAgent() invocation, real tenant-scoped data only (actual input/output
 * JSON + actual status + actual real token counts, never a fabricated/
 * estimated row). This is deliberately NOT a conversational "memory" (no
 * embeddings, no vector search, no cross-run summarization) — mastra's
 * memory module does much more than this; this is sized to exactly what
 * this milestone asks for: "this doubles as execution history".
 */

export interface RecordAgentRunParams {
  tenantId: string;
  projectId: string | null;
  agentKey: string;
  input: unknown;
  output: unknown;
  status: string;
  tokensUsed: number;
}

export interface AgentRunRecord {
  id: string;
  tenantId: string;
  projectId: string | null;
  agentKey: string;
  input: unknown;
  output: unknown;
  status: string;
  tokensUsed: number;
  createdAt: string;
}

interface AgentRunRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  agent_key: string;
  input: unknown;
  output: unknown;
  status: string;
  tokens_used: number;
  created_at: string;
}

function toRecord(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    agentKey: row.agent_key,
    input: row.input,
    output: row.output,
    status: row.status,
    tokensUsed: row.tokens_used,
    createdAt: row.created_at,
  };
}

/** Inserts one real agent_runs row. `client` must already be inside the caller's tenant-scoped transaction/connection (same contract as llmBudget.ts's recordLlmUsage). */
export async function recordAgentRun(client: PoolClient, params: RecordAgentRunParams): Promise<AgentRunRecord> {
  const result = await client.query<AgentRunRow>(
    `INSERT INTO agent_runs (tenant_id, project_id, agent_key, input, output, status, tokens_used)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     RETURNING id, tenant_id, project_id, agent_key, input, output, status, tokens_used, created_at`,
    [
      params.tenantId,
      params.projectId,
      params.agentKey,
      JSON.stringify(params.input ?? null),
      JSON.stringify(params.output ?? null),
      params.status,
      params.tokensUsed,
    ],
  );
  return toRecord(result.rows[0]);
}

/** Returns the most recent agent_runs rows for one agent key in this tenant, newest first — the "execution history" view. Always scoped to tenant_id (+ project_id when given), same explicit-WHERE-as-defense-in-depth convention as activityTimeline.ts. */
export async function getRecentAgentRuns(
  client: PoolClient,
  tenantId: string,
  agentKey: string,
  limit = 20,
  projectId?: string | null,
): Promise<AgentRunRecord[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const result = projectId
    ? await client.query<AgentRunRow>(
        `SELECT id, tenant_id, project_id, agent_key, input, output, status, tokens_used, created_at
         FROM agent_runs WHERE tenant_id = $1 AND agent_key = $2 AND project_id = $3
         ORDER BY created_at DESC LIMIT $4`,
        [tenantId, agentKey, projectId, safeLimit],
      )
    : await client.query<AgentRunRow>(
        `SELECT id, tenant_id, project_id, agent_key, input, output, status, tokens_used, created_at
         FROM agent_runs WHERE tenant_id = $1 AND agent_key = $2
         ORDER BY created_at DESC LIMIT $3`,
        [tenantId, agentKey, safeLimit],
      );
  return result.rows.map(toRecord);
}
