# DevLaunch Growth Engine — Architecture (Phase 1)

## 1. Component diagram (text)

```
                           +-------------------------+
                           |     apps/dashboard       |
                           |  React + TS (Vite)       |
                           |  - login / session       |
                           |  - tenant/project views   |
                           |  - run-agent form         |
                           |  - execution status view  |
                           +------------+-------------+
                                        | HTTPS (JWT in Authorization header)
                                        v
                           +-------------------------+
                           |        apps/api          |
                           |  Node 22 + TS + Express   |
                           |  /api/v1/*                |
                           |                           |
                           |  middleware chain:        |
                           |   requestLogger           |
                           |   auth (verify JWT)       |
                           |   tenantContext (derive   |
                           |     tenantId from         |
                           |     membership, NOT from  |
                           |     client input)         |
                           |   requireRole             |
                           |   route handler           |
                           |   errorHandler            |
                           +----+-----------------+----+
                                |                   |
                      sync CRUD |                   | enqueue AgentRunRequest
                     (tenant_id |                   | (tenantId, projectId,
                      set via   |                   |  agentId, input,
                      SET LOCAL |                   |  idempotencyKey)
                      app.current_tenant_id)         |
                                v                   v
                  +-------------------+   +-------------------+
                  |   PostgreSQL 16    |   |   Redis (queue)    |
                  |  packages/db       |   |   "agent-runs"     |
                  |  - tenants         |   |   stream/list      |
                  |  - users           |   +---------+---------+
                  |  - memberships     |             |
                  |  - projects        |             | BLPOP / consumer group
                  |  - project_profiles|             v
                  |  - icp_profiles    |   +-------------------+
                  |  - agent_templates |   |    apps/worker     |
                  |  - agent_instances |   |  Node 22 + TS      |
                  |  - agent_executions|   |                    |
                  |  - approvals       |<--+  1. pop job        |
                  |  - audit_events    |   |  2. SET LOCAL       |
                  |  RLS policy per    |   |     app.current_   |
                  |  tenant-owned      |   |     tenant_id       |
                  |  table             |   |  3. load agent_sdk  |
                  +-------------------+   |     registry entry  |
                                           |  4. run agent        |
                                           |     (stub/mock exec) |
                                           |  5. write result to  |
                                           |     agent_executions |
                                           |  6. write audit_event|
                                           |  7. if consequential |
                                           |     action -> create |
                                           |     approvals row,   |
                                           |     status=          |
                                           |     needs_approval   |
                                           +----------+-----------+
                                                      |
                                                      v
                                     +-----------------------------+
                                     |   packages/agent-sdk         |
                                     |  AgentDefinition              |
                                     |  AgentRunRequest               |
                                     |  AgentRunResult                 |
                                     |  (versioned contract, shared     |
                                     |   by api + worker + dashboard     |
                                     |   types)                           |
                                     +---------------+---------------------+
                                                     |
                                                     v
                                     +-----------------------------+
                                     |  market-research agent        |
                                     |  (apps/worker/src/agents/      |
                                     |   marketResearch)               |
                                     |  - ResearchAdapter interface      |
                                     |  - MockResearchAdapter (Phase 1,   |
                                     |    returns fixture EvidenceItem[]   |
                                     |    with source+timestamp+confidence)|
                                     |  - [TODO later phase] MastraAgent   |
                                     |    adapter once @mastra/core is     |
                                     |    stable (non-alpha); [TODO later  |
                                     |    phase] Crawl4AIResearchAdapter   |
                                     |    calling a separate crawl4ai      |
                                     |    Docker service over HTTP          |
                                     +-----------------------------+
```

## 2. Tenant context flow: API -> queue -> worker -> agent stub

1. **Dashboard -> API.** User authenticates; dashboard stores a JWT. Every subsequent request carries `Authorization: Bearer <jwt>`. The dashboard never sends a raw `tenantId` that the API trusts as-is — it may include a `tenantId` in the URL for routing/readability only.
2. **API: auth middleware.** Verifies the JWT, loads the `users` row, attaches `req.user`.
3. **API: tenantContext middleware.** Looks up `req.user`'s `memberships` for the `tenantId` in the path, confirms an active membership exists, and sets `req.tenantId` (and the membership's `role`) from that server-side lookup — the path param is only ever used as a lookup key, never written straight into `req.tenantId` without that membership check.
4. **API: DB access.** Every DB call for that request runs inside a transaction that issues `SET LOCAL app.current_tenant_id = '<req.tenantId>'` before any query, so Postgres RLS policies (see SECURITY.md) enforce isolation even if application code has a bug.
5. **API: agent run endpoint.** Builds an `AgentRunRequest { tenantId: req.tenantId (server-derived), projectId, agentId, input, idempotencyKey }`, validates it against `packages/agent-sdk` schemas, inserts a `queued` row into `agent_executions`, and pushes the same payload (plus the new `executionId`) onto the Redis `agent-runs` queue. Returns an `AgentRunResult { executionId, status: "queued" }` immediately (never blocks on execution).
6. **Queue.** Redis holds the job; `idempotencyKey` (if supplied) is checked against existing executions to avoid duplicate runs.
7. **Worker: consumer.** Pops the job, re-establishes a DB connection, and immediately issues `SET LOCAL app.current_tenant_id = '<job.tenantId>'` for that job's transaction — tenant context is carried through the queue payload, not re-derived from any client input at this stage, since by now it was already server-derived once by the API.
8. **Worker: agent registry lookup.** Resolves `agentId` -> `AgentDefinition` from `agent_templates`/the in-process registry (`apps/worker/src/agents/registry.ts`), validates `input` against the definition's `inputSchema`.
9. **Worker: execution.** Marks `agent_executions.status = running`, invokes the agent's stub implementation. For `market-research`, this calls `MockResearchAdapter.search(query)`, which returns fixture `EvidenceItem[]` (no real network calls in Phase 1) with `source`, `timestamp`, `confidence` on every item. The agent assembles these into a result validated against `outputSchema`.
10. **Worker: consequential-action check.** If the agent's output implies any external action (email send, publish, CRM mutation, export) — none exist for `market-research` in Phase 1, but the gate is in place for future agents — the worker instead writes `status = needs_approval` and creates an `approvals` row, and stops; it never performs the external action itself.
11. **Worker: completion.** Writes `agent_executions.status = succeeded|failed`, `result`/`error`, and an `audit_events` row (actor = system/agent, tenant_id, entity_id = executionId).
12. **Dashboard: polling.** The execution list/detail pages poll `GET /api/v1/tenants/:tenantId/agent-executions/:executionId` (same tenantContext middleware applies), rendering status transitions `queued -> running -> succeeded|failed|needs_approval` and the evidence list once populated.

## 3. Mastra placement (explicit, per research findings)

`@mastra/core` is **not** an npm dependency in Phase 1 (current version is a `1.86.0-alpha.3` pre-release; avoid pinning an alpha for a production path, and its full agent-runtime surface is far larger than the one stubbed demo agent Phase 1 needs). The `apps/worker/src/agents/*` layer is written entirely behind `packages/agent-sdk`'s own `AgentDefinition`/`AgentRunRequest`/`AgentRunResult` contract. The diagram's "Mastra stub" box is literally the hand-rolled `market-research` agent module — there is no live Mastra process, client, or import anywhere in Phase 1. A later phase swaps `MockResearchAdapter` (and, separately, the execution engine) behind these same interfaces once `@mastra/core` reaches a stable semver; see `DECISIONS.md`.
