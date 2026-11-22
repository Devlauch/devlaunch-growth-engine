# DevLaunch Growth Engine — Security (Phase 1)

## 1. Tenant isolation approach

Defense in depth, two independent layers — either one failing should not break isolation on its own.

### 1a. Server-side membership checks (application layer)

- The client never supplies a trusted `tenantId`. Every authenticated request carries a JWT identifying a `userId`; the `tenantContext` middleware (`apps/api/src/middleware/tenantContext.ts`) looks up that user's `memberships` row for the `tenantId` named in the URL path and rejects the request (`403`) if no active membership exists.
- `req.tenantId` and `req.membershipRole` are set only from that DB-verified membership lookup, never copied directly from `req.params.tenantId`, a header, or the request body.
- `requireRole(...)` middleware gates mutating/sensitive routes by the roles allowed for that action (e.g. only Tenant Owner/Tenant Admin can manage memberships; only Platform Super Admin can create tenants outright in Phase 1's bootstrap flow).
- Every service function takes `tenantId` as an explicit parameter sourced from `req.tenantId` and includes it in every `WHERE` clause as defense-in-depth, even though RLS (below) would also block a cross-tenant row.
- The worker receives `tenantId` only via the job payload that the API already validated server-side; the worker does not re-trust any tenant value from agent `input` JSON.

### 1b. Row-Level Security (database layer)

- Every tenant-owned table (`projects`, `project_profiles`, `icp_profiles`, `agent_instances`, `agent_executions`, `approvals`, `audit_events`, `memberships`) has `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` plus a `CREATE POLICY` restricting rows to `tenant_id = current_setting('app.current_tenant_id')::uuid` (migration `013_enable_rls_policies.sql`).
- Both `apps/api` and `apps/worker` open each unit of work in a transaction that runs `SET LOCAL app.current_tenant_id = $1` as its first statement, using the server-derived `tenantId`, before any other query on that connection/transaction.
- The database role used by the application is a non-superuser role so RLS cannot be bypassed by `BYPASSRLS`; migrations run under a separate privileged role.
- `agent_templates` may hold tenant-null (platform-global) rows; its policy allows `tenant_id IS NULL OR tenant_id = current_setting(...)`.
- Testability: `apps/api/test/tenantIsolation.test.ts` asserts that (a) a request scoped to tenant A cannot read/write tenant B's rows via the API, and (b) a direct SQL query run with `app.current_tenant_id` set to tenant A returns zero rows for tenant B's data even bypassing the API layer, proving RLS — not just application code — enforces the boundary.

## 2. Secrets handling

- No API keys, DB passwords, JWT signing secrets, or other credentials are invented, hardcoded, or committed. `.env.example` lists required variable **names** only, with placeholder/empty values.
- `.env` (and any `*.env.local`) is listed in `.gitignore` at the repo root; this is verified, not assumed.
- Local dev secrets are supplied via `.env` (Docker Compose `env_file`) and never logged. Structured logger (`apps/api/src/config/logger.ts`, `apps/worker/src/config/logger.ts`) redacts known secret-shaped fields (`password`, `token`, `secret`, `authorization`) before writing log lines.
- JWT signing secret, DB connection string, and Redis URL are read from `process.env` only, validated at boot via `src/config/env.ts` (fails fast if a required var is missing), never given inline defaults that look like real secrets.
- No outbound email, social, or CRM credentials are needed or configured in Phase 1 — those integrations are explicitly out of scope (see Hard Rules below).

## 3. Approval-gating rules (from the spec)

- **Any consequential external action requires human approval before it executes.** Consequential = sending email, publishing content, mutating an external CRM, or exporting data. Phase 1 ships no agent that performs any of these (the only agent, `market-research`, is read-side and stubbed), but the gate is implemented now so later agents plug into it without a redesign:
  - An agent implementation that would need to perform a consequential action instead returns a result tagged as requiring approval; the worker sets `agent_executions.status = needs_approval` and inserts a row into `approvals` (`status = pending`) describing the proposed action — it does not perform the action.
  - Only a human with sufficient role (Tenant Owner/Tenant Admin, or Platform Super Admin) can resolve an approval via `POST /api/v1/tenants/:tenantId/approvals/:approvalId/decision`, which records `decided_by`, `status`, and writes an `audit_events` row. Approving an action is a decision record in Phase 1; Phase 1 does not itself go on to perform the now-approved external action (no real send/publish/CRM-mutation/export code exists yet) — that execution path is later-phase work.
  - Every approval decision (approve or reject) is itself audited.
- All state-changing operations (tenant/project create, membership change, agent run, approval decision) write an `audit_events` row: `tenant_id`, `actor_user_id` (or null for system), `event_type`, `entity_type`, `entity_id`, `payload`, `created_at`. Audit events are append-only from the application's perspective (no update/delete route exists for them in Phase 1).

## 4. Hard rules carried into Phase 1 implementation

- Do not invent or hardcode API keys/credentials anywhere in code, migrations, fixtures, or Docker Compose defaults.
- Do not implement real outbound email or social-posting integrations; any such code path is a clearly-marked `// TODO (later phase)` stub only.
- Do not skip tenant isolation on any route or worker job, including the demo agent path.
- Do not implement CRM sync, campaign execution, or real web crawling — `market-research`'s `ResearchAdapter` is mocked with fixture data only in Phase 1.
- Pin all dependency versions exactly (no `^`/`~` ranges) in every `package.json` across the workspace.
- Never commit `.env` or any file containing a real secret; this is enforced by `.gitignore` and should additionally be checked in review before any commit/PR.
