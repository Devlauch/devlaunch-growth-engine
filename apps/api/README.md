# @devlaunch/api

Phase 1 Express API for the DevLaunch Growth Engine. TypeScript, Node 22,
Express 4, zod validation, pino structured logging.

## Running locally

```bash
npm install            # from the monorepo root (workspaces)
cp ../../.env.example ../../.env   # then export vars, or use a tool like dotenv-cli
npm run dev --workspace=@devlaunch/api
```

Requires:
- Postgres with `packages/db` migrations applied (`npm run migrate:up --workspace=@devlaunch/db`), ideally seeded (`npm run db:seed --workspace=@devlaunch/db`).
- Redis reachable at `REDIS_URL` (for enqueuing agent runs; `apps/worker` must be running to actually process them).

## Auth (Phase 1)

Two paths, both producing `req.userId`:

1. **Real JWT auth** — `POST /api/v1/auth/register` / `/login` return an
   access + refresh token pair (bcrypt-hashed passwords, `jsonwebtoken`).
   Send `Authorization: Bearer <accessToken>` on subsequent requests;
   `POST /api/v1/auth/refresh` rotates them.
2. **`X-Dev-User-Id` header — DEV ONLY.** If `ALLOW_DEV_AUTH=true` (the
   Phase 1 default) and no bearer token is given, this header is trusted
   as the caller's user id with zero verification. It is clearly marked in
   `src/middleware/auth.ts` and must be disabled before any
   shared/production deployment.

**Either way, a user id alone never grants tenant access.** Every
tenant-scoped route (`/api/v1/tenants/:tenantId/...`) additionally runs
`src/middleware/tenant.ts`'s `requireTenantMembership`, which:

1. Opens a dedicated Postgres transaction for the request.
2. Sets `app.current_tenant_id` (transaction-local) to the requested
   `:tenantId` — the session variable `packages/db`'s RLS policies check.
3. Queries `memberships` for an **active** row for `(tenantId, userId)`.
   Because RLS is already scoped to `tenantId`, this can only ever see
   that tenant's own membership rows.
4. If none is found, rolls back, releases the connection, and responds
   `403` — the client-supplied `:tenantId` is never trusted without this
   passing.
5. On success, attaches `req.tenantDb` (the same already-tenant-scoped
   client) for the route handler to use, and commits/rolls back when the
   response finishes.

This is real enforcement, not just a stub — only the *identity* half
(`X-Dev-User-Id`) is a development shortcut.

## Routes

All under `/api/v1`. See `src/app.ts` for the exact mount points; routes
are grouped as auth, tenants/memberships, projects/profile/ICP profiles,
agent templates/instances/runs/executions, approvals, audit events,
health, and the public lead-capture surface (`/api/v1/public/...` — see
`packages/embed-widget`).

Agent runs: `POST .../agent-runs` creates an `agent_executions` row
(`queued`), enqueues a BullMQ job for `apps/worker`, and returns an
`AgentRunResult`. Poll `GET .../agent-executions` (project-scoped list) or
`GET /api/v1/tenants/:tenantId/agent-executions/:executionId` to see it
move to `running` → `succeeded`/`failed`.

## Tests

```bash
npm test --workspace=@devlaunch/api
```

Unit tests (vitest; DB/Redis are mocked, no live services required):
- `test/tenantMiddleware.test.ts` — denies cross-tenant access, grants
  access on an active membership, rejects malformed tenant ids.
- `test/publicLeads.test.ts` — rejects an unknown/disabled project public
  key, rejects a non-allowlisted `Origin`, accepts a valid request through
  the shared lead-ingestion path (and tags its audit event
  `source=public_widget`), and enforces the rate limiter.

(The `market-research` agent's schema-valid-output test lives in
`apps/worker/test/marketResearch.test.ts`, next to the agent itself.)
