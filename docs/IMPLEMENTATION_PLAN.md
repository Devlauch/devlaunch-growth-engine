# DevLaunch Growth Engine — Phase 1 Implementation Plan

Status: Phase 1 (do not build later phases)
Tenant 0: DevLaunch / DevPilot Academy

## 1. Package manager

**pnpm workspaces.** Rationale is in `DECISIONS.md`. Node.js 22+, TypeScript throughout.

Root files:
- `pnpm-workspace.yaml`
- `package.json` (root, private, workspaces scripts: build/dev/test/lint/migrate)
- `tsconfig.base.json`
- `.env.example` (no real secrets, ever committed)
- `.gitignore` (must exclude `.env`, `*.env.local`, `node_modules`, `dist`, `coverage`)
- `docker-compose.yml` (postgres:16, redis, api, worker, dashboard)
- `docker-compose.override.yml.example`
- `turbo.json` or `pnpm -r` scripts (no extra build-orchestration dependency required for Phase 1; plain pnpm recursive scripts are sufficient — see DECISIONS.md)
- `README.md`

## 2. Monorepo folder layout (flat list of paths)

```
pnpm-workspace.yaml
package.json
tsconfig.base.json
.env.example
.gitignore
docker-compose.yml
README.md

apps/api/package.json
apps/api/tsconfig.json
apps/api/Dockerfile
apps/api/src/index.ts
apps/api/src/app.ts
apps/api/src/config/env.ts
apps/api/src/config/logger.ts
apps/api/src/db/pool.ts
apps/api/src/db/withTenantContext.ts
apps/api/src/queue/connection.ts
apps/api/src/queue/producers/agentRunProducer.ts
apps/api/src/middleware/auth.ts
apps/api/src/middleware/tenantContext.ts
apps/api/src/middleware/requireRole.ts
apps/api/src/middleware/errorHandler.ts
apps/api/src/middleware/requestLogger.ts
apps/api/src/routes/index.ts
apps/api/src/routes/v1/auth.routes.ts
apps/api/src/routes/v1/tenants.routes.ts
apps/api/src/routes/v1/memberships.routes.ts
apps/api/src/routes/v1/projects.routes.ts
apps/api/src/routes/v1/projectProfiles.routes.ts
apps/api/src/routes/v1/icpProfiles.routes.ts
apps/api/src/routes/v1/agentTemplates.routes.ts
apps/api/src/routes/v1/agentInstances.routes.ts
apps/api/src/routes/v1/agentExecutions.routes.ts
apps/api/src/routes/v1/approvals.routes.ts
apps/api/src/routes/v1/auditEvents.routes.ts
apps/api/src/routes/v1/health.routes.ts
apps/api/src/controllers/auth.controller.ts
apps/api/src/controllers/tenants.controller.ts
apps/api/src/controllers/memberships.controller.ts
apps/api/src/controllers/projects.controller.ts
apps/api/src/controllers/projectProfiles.controller.ts
apps/api/src/controllers/icpProfiles.controller.ts
apps/api/src/controllers/agentTemplates.controller.ts
apps/api/src/controllers/agentInstances.controller.ts
apps/api/src/controllers/agentExecutions.controller.ts
apps/api/src/controllers/approvals.controller.ts
apps/api/src/controllers/auditEvents.controller.ts
apps/api/src/services/authService.ts
apps/api/src/services/tenantService.ts
apps/api/src/services/membershipService.ts
apps/api/src/services/projectService.ts
apps/api/src/services/agentRegistryService.ts
apps/api/src/services/agentExecutionService.ts
apps/api/src/services/approvalService.ts
apps/api/src/services/auditService.ts
apps/api/src/schemas/auth.schema.ts
apps/api/src/schemas/tenants.schema.ts
apps/api/src/schemas/projects.schema.ts
apps/api/src/schemas/agentRun.schema.ts
apps/api/test/health.test.ts
apps/api/test/tenantIsolation.test.ts
apps/api/test/agentRun.e2e.test.ts

apps/worker/package.json
apps/worker/tsconfig.json
apps/worker/Dockerfile
apps/worker/src/index.ts
apps/worker/src/config/env.ts
apps/worker/src/config/logger.ts
apps/worker/src/db/pool.ts
apps/worker/src/queue/connection.ts
apps/worker/src/queue/consumers/agentRunConsumer.ts
apps/worker/src/agents/registry.ts
apps/worker/src/agents/types.ts
apps/worker/src/agents/marketResearch/marketResearchAgent.ts
apps/worker/src/agents/marketResearch/schema.ts
apps/worker/src/agents/marketResearch/researchAdapter.ts
apps/worker/src/agents/marketResearch/mockResearchAdapter.ts
apps/worker/src/agents/marketResearch/fixtures/sampleEvidence.json
apps/worker/src/lib/idempotency.ts
apps/worker/src/lib/auditLogger.ts
apps/worker/test/marketResearchAgent.test.ts

apps/dashboard/package.json
apps/dashboard/tsconfig.json
apps/dashboard/Dockerfile
apps/dashboard/index.html
apps/dashboard/vite.config.ts
apps/dashboard/src/main.tsx
apps/dashboard/src/App.tsx
apps/dashboard/src/api/client.ts
apps/dashboard/src/api/tenants.ts
apps/dashboard/src/api/projects.ts
apps/dashboard/src/api/agentExecutions.ts
apps/dashboard/src/auth/AuthContext.tsx
apps/dashboard/src/auth/ProtectedRoute.tsx
apps/dashboard/src/pages/LoginPage.tsx
apps/dashboard/src/pages/TenantDashboardPage.tsx
apps/dashboard/src/pages/ProjectsPage.tsx
apps/dashboard/src/pages/ProjectDetailPage.tsx
apps/dashboard/src/pages/AgentExecutionsPage.tsx
apps/dashboard/src/pages/AgentExecutionDetailPage.tsx
apps/dashboard/src/components/TenantSwitcher.tsx
apps/dashboard/src/components/ExecutionStatusBadge.tsx
apps/dashboard/src/components/RunAgentForm.tsx
apps/dashboard/src/components/EvidenceList.tsx
apps/dashboard/src/components/Layout.tsx

packages/db/package.json
packages/db/tsconfig.json
packages/db/src/index.ts
packages/db/src/pool.ts
packages/db/src/types.ts
packages/db/migrations/001_enable_extensions.sql
packages/db/migrations/002_create_tenants.sql
packages/db/migrations/003_create_users.sql
packages/db/migrations/004_create_memberships.sql
packages/db/migrations/005_create_projects.sql
packages/db/migrations/006_create_project_profiles.sql
packages/db/migrations/007_create_icp_profiles.sql
packages/db/migrations/008_create_agent_templates.sql
packages/db/migrations/009_create_agent_instances.sql
packages/db/migrations/010_create_agent_executions.sql
packages/db/migrations/011_create_approvals.sql
packages/db/migrations/012_create_audit_events.sql
packages/db/migrations/013_enable_rls_policies.sql
packages/db/migrations/014_seed_dev_tenant.sql
packages/db/README.md

packages/agent-sdk/package.json
packages/agent-sdk/tsconfig.json
packages/agent-sdk/src/index.ts
packages/agent-sdk/src/types.ts
packages/agent-sdk/src/AgentDefinition.ts
packages/agent-sdk/src/AgentRunRequest.ts
packages/agent-sdk/src/AgentRunResult.ts
packages/agent-sdk/src/validation.ts
packages/agent-sdk/test/types.test.ts
```

## 3. Migration file list (packages/db/migrations, in order)

1. `001_enable_extensions.sql` — `pgcrypto`/`uuid-ossp` for UUID generation
2. `002_create_tenants.sql` — `tenants` table (UUID PK, name, slug, status, timestamps)
3. `003_create_users.sql` — `users` table (UUID PK, email unique, password_hash, platform role flag, timestamps)
4. `004_create_memberships.sql` — `memberships` (tenant_id FK, user_id FK, role enum: Platform Super Admin, Tenant Owner, Tenant Admin, Marketer, Sales User, Analyst, Viewer; unique(tenant_id,user_id); indexes)
5. `005_create_projects.sql` — `projects` (tenant_id FK, name, status, timestamps, index on tenant_id)
6. `006_create_project_profiles.sql` — `project_profiles` (project_id FK, tenant_id FK, config JSONB, timestamps)
7. `007_create_icp_profiles.sql` — `icp_profiles` (project_id FK, tenant_id FK, criteria JSONB, timestamps)
8. `008_create_agent_templates.sql` — `agent_templates` (tenant_id FK nullable for platform-global templates, id/version/name/description, input_schema JSONB, output_schema JSONB, required_permissions JSONB, tools JSONB)
9. `009_create_agent_instances.sql` — `agent_instances` (tenant_id FK, project_id FK, agent_template_id FK, config JSONB, timestamps)
10. `010_create_agent_executions.sql` — `agent_executions` (tenant_id FK, project_id FK, agent_instance_id FK, status enum: queued|running|succeeded|failed|needs_approval, input JSONB, result JSONB, error JSONB, idempotency_key, timestamps, index on tenant_id+status)
11. `011_create_approvals.sql` — `approvals` (tenant_id FK, agent_execution_id FK nullable, action_type, payload JSONB, status enum: pending|approved|rejected, requested_by FK users, decided_by FK users, timestamps)
12. `012_create_audit_events.sql` — `audit_events` (tenant_id FK, actor_user_id FK nullable, event_type, entity_type, entity_id, payload JSONB, created_at, index on tenant_id+created_at)
13. `013_enable_rls_policies.sql` — `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` per tenant-owned table, keyed on `current_setting('app.current_tenant_id')`
14. `014_seed_dev_tenant.sql` — local-dev-only seed (DevLaunch tenant, one admin user, one project) — guarded to run only outside production

All tables: UUID PKs (`gen_random_uuid()`), `created_at`/`updated_at` timestamptz, `tenant_id` FK + btree index where applicable.

## 4. API routes, Phase 1 (`/api/v1`)

Auth
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `GET  /api/v1/auth/me`

Tenants
- `POST /api/v1/tenants`
- `GET  /api/v1/tenants`
- `GET  /api/v1/tenants/:tenantId`

Memberships
- `POST /api/v1/tenants/:tenantId/memberships`
- `GET  /api/v1/tenants/:tenantId/memberships`
- `PATCH /api/v1/tenants/:tenantId/memberships/:membershipId`

Projects
- `POST /api/v1/tenants/:tenantId/projects`
- `GET  /api/v1/tenants/:tenantId/projects`
- `GET  /api/v1/tenants/:tenantId/projects/:projectId`
- `PATCH /api/v1/tenants/:tenantId/projects/:projectId` (accepts `name`/`description`/`status`, and optionally `publicWidgetEnabled`/`allowedOrigins` to enable and configure the public lead-capture widget for that project)

Project profiles / ICP profiles
- `GET  /api/v1/tenants/:tenantId/projects/:projectId/profile`
- `PUT  /api/v1/tenants/:tenantId/projects/:projectId/profile`
- `GET  /api/v1/tenants/:tenantId/projects/:projectId/icp-profiles`
- `POST /api/v1/tenants/:tenantId/projects/:projectId/icp-profiles`

Agent registry / instances
- `GET  /api/v1/agent-templates`
- `GET  /api/v1/tenants/:tenantId/projects/:projectId/agent-instances`
- `POST /api/v1/tenants/:tenantId/projects/:projectId/agent-instances`

Agent executions (core demo flow)
- `POST /api/v1/tenants/:tenantId/projects/:projectId/agent-runs` (body: `agentInstanceId`, `input`, `idempotencyKey`?) → AgentRunResult
- `GET  /api/v1/tenants/:tenantId/projects/:projectId/agent-executions`
- `GET  /api/v1/tenants/:tenantId/agent-executions/:executionId`

These two routes are a deliberate, tenant-scoped reshaping of the original spec's
`POST /api/v1/agents/:agentInstanceId/runs` / `GET /api/v1/executions/:executionId` — see
`docs/API_DEVIATIONS.md` for why.

Approvals
- `GET  /api/v1/tenants/:tenantId/approvals`
- `POST /api/v1/tenants/:tenantId/approvals/:approvalId/decision`

Audit
- `GET  /api/v1/tenants/:tenantId/audit-events`

Health
- `GET  /api/v1/health`

All non-auth, non-health routes require a valid session and pass through `tenantContext` middleware that re-derives `tenantId` server-side from the authenticated membership — the client-supplied `:tenantId` path param is only validated against it, never trusted on its own.

## 5. Build order (suggested milestones within Phase 1)

1. Root workspace scaffold + Docker Compose (postgres, redis) boots.
2. `packages/db` migrations 001–013 run clean against local Postgres; RLS verified with a psql smoke test.
3. `packages/agent-sdk` contract types shipped and unit-tested.
4. `apps/api` auth + tenants + memberships + projects CRUD, with tenant isolation tests.
5. `apps/worker` consumes `agent-runs` queue, runs the stubbed `market-research` agent, writes `agent_executions` + `audit_events`.
6. `apps/api` agent-run endpoint wired to Redis queue (BullMQ or equivalent), execution status endpoint.
7. `apps/dashboard` shell: login, tenant/project pages, run-agent form, execution list/detail with status polling.
8. End-to-end smoke test against acceptance criteria; `docker-compose up` from clean clone.
