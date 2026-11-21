# DevLaunch Growth Engine — Decisions Log (Phase 1)

Each entry: Decision / Context / Alternatives considered / Rationale / Revisit trigger.

## D1. Mastra: do not take a live dependency in Phase 1

- **Decision:** Do not depend on `mastra/` or `@mastra/core` as an npm dependency in Phase 1. Implement the `market-research` agent as a hand-rolled stub behind our own `packages/agent-sdk` contract (`AgentDefinition`/`AgentRunRequest`/`AgentRunResult`).
- **Context (research findings):** The cloned repo is `mastra-turbo` v0.1.11, a large, fast-moving monorepo (`packages/core` alone has 20+ subsystems: durable agents, workflows, tool-loop agents, MCP server/registry, agent-builder, playground, auth, deployers, etc.). The installable package `@mastra/core` is currently `1.86.0-alpha.3` — a pre-release tag — licensed Apache-2.0, except that anything under any `ee/` directory (including `@mastra/core/auth/ee`) is under a separate non-FOSS commercial license and must never be imported.
- **Alternatives considered:**
  1. Pin `@mastra/core@1.86.0-alpha.3` now and build directly on its Agent API. Rejected: alpha tags are not safe to pin for a production Phase 1 dependency, and the surface area (durable/goal/subagent/tool-loop agents) is far larger than one stubbed demo agent needs.
  2. Vendor a subset of the Mastra source. Rejected: increases maintenance burden, license-boundary risk (`ee/` paths), and couples Phase 1 to an unstable upstream API.
  3. (Chosen) Define our own minimal versioned contract exactly as the spec specifies, ship the stub behind it, defer Mastra entirely.
- **Rationale:** Phase 1 only needs one stubbed demo agent runnable end-to-end; a 20+ subsystem alpha dependency is disproportionate risk for that scope. An adapter-pattern internal interface lets us swap in real Mastra execution later without changing the contract or any calling code.
- **Revisit trigger:** Re-evaluate once `@mastra/core` reaches a stable (non-alpha) semver. At that point, implement a `MastraAgentRuntime` adapter behind the same `AgentDefinition`/`AgentRunRequest`/`AgentRunResult` contract — documented as a `// TODO` in `apps/worker/src/agents/registry.ts`.

## D2. Crawl4AI: do not invoke as a live dependency in Phase 1

- **Decision:** Implement the `market-research` agent's research step behind a `ResearchAdapter` TS interface (`search(query) -> EvidenceItem[]`), with a `MockResearchAdapter` returning fixture data (each item carrying `source`, `timestamp`, `confidence` per the spec's evidence-based-output rule). Do not call crawl4ai, and do not perform any real external scraping, in Phase 1.
- **Context (research findings):** `crawl4ai` is a Python package (`Crawl4AI`, v0.9.6, Apache-2.0, requires Python >=3.10) built on aiohttp/playwright/patchright plus an LLM-extraction layer (litellm). It is a separate-language, async, browser-based crawler — integration means calling it as its own microservice/Docker container over HTTP, not an in-process Node/TS import. The spec also explicitly requires Phase 1's demo agent to be stubbed/mocked with no real external scraping or paid API calls.
- **Alternatives considered:** Stand up the crawl4ai Docker service now and call it from the worker. Rejected for Phase 1: out of scope per the spec, adds a Python runtime + browser-automation dependency to local dev before it's needed, and contradicts the "stub this phase" rule.
- **Rationale:** Keeping a clean `ResearchAdapter` seam means swapping in a real adapter later is additive, not a rewrite.
- **Revisit trigger:** Later phase: add `Crawl4AIResearchAdapter` calling a separately-deployed crawl4ai Docker service (it ships its own `docker-compose.yml`/`Dockerfile`), pinned to `0.9.6` or whatever stable release is current at that time.

## D3. Package manager: pnpm workspaces

- **Decision:** Use pnpm workspaces for the TS monorepo (`apps/*`, `packages/*`).
- **Alternatives considered:** npm workspaces (weaker hoisting control, slower installs at this scale), Yarn Berry/PnP (extra tooling-compatibility friction for Express/Vite ecosystem), Turborepo/Nx on top (adds a build-orchestration layer not needed at Phase 1's size — four packages, no complex build graph yet).
- **Rationale:** pnpm gives strict, disk-efficient dependency isolation between `apps/api`, `apps/worker`, `apps/dashboard`, and the shared `packages/db`/`packages/agent-sdk`, with first-class workspace protocol (`workspace:*`) for internal package references, and is a common, low-friction default for TS monorepos of this size.
- **Revisit trigger:** If the build graph grows complex enough to need task caching/parallelization (many packages, slow CI), add Turborepo on top without changing the package manager.

## D4. Database access: node-postgres + node-pg-migrate, not a heavier ORM

- **Decision:** Use `pg` (node-postgres) as the query layer and `node-pg-migrate` as the SQL migration tool for `packages/db`, rather than a heavier ORM (Prisma, TypeORM, Drizzle, Sequelize).
- **Alternatives considered:**
  - **Prisma:** strong DX and type generation, but its own migration engine and schema DSL make hand-written RLS policies and `SET LOCAL app.current_tenant_id` session-scoped transactions awkward to express and reason about; its generated client also obscures the exact SQL running inside a transaction, which matters when tenant isolation depends on statement ordering within that transaction.
  - **TypeORM:** mature but heavier runtime, weaker TS type-safety by default, decorator-based entities add indirection for a schema this still-small.
  - **Drizzle:** lightweight and SQL-like, a reasonable second choice, but introduces its own migration/schema-definition format; Phase 1 has no need for its query-builder abstraction yet over plain parameterized SQL.
  - **(Chosen) node-postgres + node-pg-migrate:** plain, well-pinned, minimal-dependency combination.
- **Rationale:** Phase 1's query surface is small and CRUD-shaped (a handful of tables, mostly simple selects/inserts/updates). Writing raw parameterized SQL in each service keeps full, explicit control over transactions (`SET LOCAL app.current_tenant_id` must run first, in the same transaction, before any other statement — an ORM's connection pooling/query batching can make this subtle to guarantee correctly). `node-pg-migrate` migrations are plain `.sql`/`.js` files that map directly to the numbered migration list in `IMPLEMENTATION_PLAN.md`, are easy to review for RLS correctness, and avoid tying the schema to a second DSL that must stay in sync with hand-written RLS policies. A heavier ORM can be introduced later if the query surface grows enough to justify it, without blocking Phase 1.
- **Revisit trigger:** If the number of distinct query shapes grows large enough that hand-written SQL becomes a maintenance burden, or if multiple teams need generated types across many more tables.

## D5. Other Phase 1 assumptions

- **Queue library:** BullMQ (Redis-backed) for the `agent-runs` queue/producer/consumer, given it is the de facto standard for Node/TS job queues on Redis and supports idempotency-friendly job IDs out of the box. Pinned exact version in `apps/api` and `apps/worker` `package.json`.
- **Auth:** JWT-based session (access + refresh token), stored by the dashboard and sent as `Authorization: Bearer`. No third-party IdP integration in Phase 1; password hashing via a well-pinned `bcrypt`/`argon2` library.
- **Frontend tooling:** Vite + React + TS for `apps/dashboard` (fast local dev loop, minimal config, no SSR requirement in Phase 1).
- **Structured logging:** `pino` (or equivalent well-pinned structured logger) in both `apps/api` and `apps/worker`, with request-id correlation.
- **Validation:** `zod` (or equivalent) for both HTTP request/response schemas and the `agent-sdk` `inputSchema`/`outputSchema` validation, kept as plain JSON-schema-compatible definitions where the spec's `AgentDefinition` contract calls for schemas.
- **Docker Compose:** services `postgres`, `redis`, `api`, `worker`, `dashboard`; migrations run as a one-shot init step (`packages/db`'s migrate script) before `api`/`worker` start, via a Compose `depends_on` + healthcheck, not baked into image startup silently.
- **Out of scope confirmation:** the other inspected/listed repos (aaron-marketing-skills, leadhub, OpenOutreach, twenty, mautic, postiz-app, n8n, listmonk, chatwoot, posthog, formbricks) are confirmed out of scope for Phase 1 per the spec's "do not attempt later phases" rule (CRM/campaign/social/survey/support/analytics integrations are later-phase); this is a scope confirmation, not a new evaluation.
