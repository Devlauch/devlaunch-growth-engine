# @devlaunch/agent-sdk

Shared TypeScript contract between `apps/api` (which enqueues/polls agent
runs) and `apps/worker` (which registers and executes agents). Neither side
depends on a specific agent runtime (see the Mastra note below).

## Types (`src/types.ts`)

```ts
export interface AgentDefinition {
  id: string; version: string; name: string; description: string;
  inputSchema: unknown; outputSchema: unknown; requiredPermissions: string[]; tools: string[];
}

export interface AgentRunRequest {
  tenantId: string; projectId: string; agentId: string; input: unknown; idempotencyKey?: string;
}

export interface AgentRunResult<T = unknown> {
  executionId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "needs_approval";
  result?: T; error?: { code: string; message: string };
}

export interface EvidenceItem {
  source: string; timestamp: string; confidence: number; summary?: string; url?: string;
}
```

`inputSchema`/`outputSchema` are `unknown` here deliberately: this package
does not take a dependency on zod (or any specific schema library) so it
stays usable from any runtime. `apps/api` and `apps/worker` both use zod
internally and happen to store zod schemas (or their `.safeParse`-compatible
shape) in these fields.

## `AgentRegistry`

A tiny in-memory `Map<"id@version", AgentDefinition>`. It does **not**
execute anything — it is just a catalog. `apps/worker/src/agents/registry.ts`
registers the Phase 1 `market-research` agent into one of these and is the
single place that knows how to actually run an agent id.

## Why not `@mastra/core` yet (Phase 1 decision)

Phase 1 ships exactly one demo agent (`market-research`) behind this
package's own `AgentDefinition`/`AgentRunRequest`/`AgentRunResult` contract,
hand-rolled with no external agent-runtime dependency. We deliberately did
**not** take a live npm dependency on `@mastra/core` for Phase 1:

- The current published version is `1.86.0-alpha.3` — a pre-release, not a
  stable semver we want to pin a production dependency to.
- Its agent-runtime surface (multi-step graphs, tool-calling orchestration,
  memory, RAG, etc.) is far larger than what one stubbed demo agent needs.
- Some of its functionality lives under non-FOSS `ee/` paths, which we avoid
  entirely.

Once `@mastra/core` reaches a stable, non-alpha semver, the plan (tracked as
a TODO in `apps/worker/src/agents/registry.ts`) is to add a
`MastraAgentRuntime` adapter that implements agent execution by calling into
Mastra, while still exposing the exact same `AgentDefinition` /
`AgentRunRequest` / `AgentRunResult` contract from this package — so neither
the API nor the queued-execution model in `agent_executions` has to change.

## Build

```bash
npm install
npm run build   # emits dist/ (ESM + .d.ts) via tsc
```
