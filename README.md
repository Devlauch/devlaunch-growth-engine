# DevLaunch Growth Engine — Phase 1

A pnpm-workspace monorepo:

```
apps/
  api/        Express API (TypeScript, Node 22) — see apps/api/README.md
  worker/     Redis/BullMQ worker that executes queued agent runs — see apps/worker/README.md
  dashboard/  Placeholder static page (Phase 2+ builds the real UI here)
packages/
  db/              Postgres schema, migrations, RLS policies — see packages/db/README.md
  agent-sdk/       Shared AgentDefinition/AgentRunRequest/AgentRunResult contract + AgentRegistry
  embed-widget/    Paste-in vanilla-JS lead-capture widget — see packages/embed-widget/README.md
docs/              Architecture/decisions/security/plan docs (pre-existing)
```

## Quickstart

```bash
cp .env.example .env    # edit DATABASE_URL etc if not using docker-compose
docker compose up -d postgres redis
npm install
npm run migrate:up --workspace=@devlaunch/db
npm run db:seed --workspace=@devlaunch/db
npm run build
npm run dev:api        # terminal 1
npm run dev:worker     # terminal 2
curl http://localhost:4000/api/v1/health
```

Or build/run everything (api, worker, dashboard placeholder, postgres,
redis) via `docker compose up --build`.

> **Package manager note:** `pnpm-workspace.yaml` is provided as requested
> (pnpm workspaces), and the root `package.json` also declares npm/yarn
> -compatible `workspaces`, so either works. In the sandbox this was built
> in, the only `pnpm` binary on `PATH` was a Windows-side shim that
> crashes under WSL path interop unrelated to this project — verification
> here was done with `npm`, which honors the identical workspace layout.

## What Phase 1 ships

- **apps/api**: all 26 routes from the spec (auth, tenants, memberships,
  projects, project profile, ICP profiles, agent templates/instances/runs/
  executions, approvals, audit events, health), plus the additional public
  lead-capture endpoint below. Zod-validated JSON, pino structured logs,
  server-enforced tenant/membership middleware backed by Postgres RLS
  (see `apps/api/README.md` and `packages/db/README.md`).
- **apps/worker**: minimal BullMQ/ioredis worker; one demo agent,
  `market-research` v1, hand-rolled behind `@devlaunch/agent-sdk`'s
  contract (no live `@mastra/core` dependency yet — see that package's
  README for why, and `apps/worker/src/agents/registry.ts` for the
  migration TODO once a stable release exists). Research itself is behind
  a `ResearchAdapter` interface; only `MockResearchAdapter` (fixture data)
  is implemented — `Crawl4AIResearchAdapter` is explicit later-phase work.
- **Public, embeddable lead capture** (additional requirement beyond the
  base spec): `POST /api/v1/public/projects/:projectPublicKey/leads` lets
  any external website submit leads, protected by a per-project public
  API key + origin allowlist + per-IP/per-key rate limiting, writing
  through the exact same tenant-isolated `leads` table (tagged
  `source=public_widget`) as any internal lead. `packages/embed-widget`
  ships the paste-in `<script>` + `<form>` snippet. This endpoint never
  sends outreach itself — captured leads still go through the existing
  agent + approval flow.
- **packages/db**: adds migrations 015–019 on top of the existing schema —
  a `leads` table, `projects.public_api_key`/`allowed_origins`/
  `public_widget_enabled`, and RLS policy extensions needed for the public
  lookup and for a user to list their own tenant memberships. See that
  package's README for the full migration list and the RLS design.

## Tests

```bash
npm test
```

Runs `apps/worker`'s `market-research` schema-validity test and
`apps/api`'s tenant-middleware and public-lead-capture tests (all unit
tests; Postgres/Redis are mocked, so no live services are required to run
them — see each package's README for exact file names).

## Known TODOs / Phase 2+

- Dashboard UI (currently a static placeholder).
- Replace `X-Dev-User-Id` dev auth with real OIDC (the JWT
  register/login/refresh/me routes already exist and work; only the dev
  bypass needs removing/gating in a real deployment).
- `MastraAgentRuntime` adapter once `@mastra/core` reaches a stable semver.
- `Crawl4AIResearchAdapter` for real market-research results.
- Swap the in-process rate limiter (`apps/api/src/middleware/rateLimit.ts`)
  for a Redis-backed one before running more than one API instance.
- The spec's prose also mentions polling via `GET /api/v1/executions/:id`;
  the exact route list it provides uses
  `GET /api/v1/tenants/:tenantId/agent-executions/:executionId` instead —
  implemented as given in the route list.
