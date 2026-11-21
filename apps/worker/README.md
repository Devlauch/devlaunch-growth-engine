# @devlaunch/worker

Minimal Redis/BullMQ worker process for Phase 1. Consumes the `agent-runs`
queue (jobs enqueued by `apps/api`'s `POST /api/v1/.../agent-runs` route),
runs the requested agent, and writes `queued -> running -> succeeded|failed`
back onto the `agent_executions` row — through the same tenant-scoped RLS
path as the API (see `src/db.ts`'s `withTenantContext`).

## Agents

Phase 1 ships one demo agent, `market-research` (`src/agents/marketResearch.ts`),
registered in `src/agents/registry.ts`. It is a hand-rolled stub behind
`@devlaunch/agent-sdk`'s `AgentDefinition` contract — see that package's
README for why this does **not** take a live dependency on `@mastra/core`
yet, and `src/agents/registry.ts` for the `MastraAgentRuntime` migration TODO.

Research is itself behind a `ResearchAdapter` interface
(`src/agents/researchAdapter.ts`): Phase 1 only implements
`MockResearchAdapter`, which returns fixture `EvidenceItem[]` with no
network calls. `Crawl4AIResearchAdapter` (calling a separate crawl4ai
Docker service over HTTP) is explicit later-phase work and currently just
throws if constructed.

## Running

```bash
npm install
cp ../../.env.example .env   # or export REDIS_URL / DATABASE_URL directly
npm run dev     # tsx watch
npm run build && npm start   # compiled
```

Requires a reachable Redis (`REDIS_URL`, default `redis://localhost:6379`)
and Postgres (`DATABASE_URL`) with `packages/db` migrations applied.

## Tests

```bash
npm test
```
