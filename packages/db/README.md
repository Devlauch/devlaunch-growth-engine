# @devlaunch/db — Phase 1 schema

PostgreSQL schema and migrations for the DevLaunch Growth Engine (Phase 1):
tenants, users, memberships, projects, project profiles, ICP profiles,
agent templates/instances/executions, approvals, and audit events.

Migrations are plain numbered `.sql` files in `migrations/`, run through
[`node-pg-migrate`](https://github.com/salsita/node-pg-migrate) (configured
for its SQL migration mode, so no JS/TS migration runner code is needed).

## Prerequisites

- Node.js 18+
- A PostgreSQL 13+ database you can connect to (local, Docker, or hosted)

## Setup

```bash
cd packages/db
npm install
cp .env.example .env
# edit .env and set DATABASE_URL to point at your dev database
```

`node-pg-migrate` reads the connection string from the `DATABASE_URL`
environment variable. Export it, or use a tool like `dotenv-cli` /
`direnv` to load `.env` automatically. Quick inline option:

```bash
export DATABASE_URL=postgres://devlaunch:devlaunch@localhost:5432/devlaunch_dev
```

## Running migrations

```bash
npm run migrate:up      # apply all pending migrations
npm run migrate:down    # roll back the most recent migration
npm run migrate:redo    # down + up the most recent migration
npm run migrate:create -- a_new_migration_name   # scaffold a new migration file
```

Under the hood this runs:

```bash
node-pg-migrate -m migrations --migration-file-language sql up
```

Migrations are applied in filename order:

```
001_enable_extensions.sql
002_create_tenants.sql
003_create_users.sql
004_create_memberships.sql
005_create_projects.sql
006_create_project_profiles.sql
007_create_icp_profiles.sql
008_create_agent_templates.sql
009_create_agent_instances.sql
010_create_agent_executions.sql
011_create_approvals.sql
012_create_audit_events.sql
013_enable_rls_policies.sql
014_seed_dev_tenant.sql
015_create_leads.sql
016_add_project_public_key.sql
017_enable_rls_leads.sql
018_extend_memberships_rls_self_lookup.sql
019_public_project_lookup_rls.sql
```

`019_public_project_lookup_rls.sql` adds a third session variable,
`app.lookup_public_api_key`, so the public lead-capture endpoint can
resolve a project's `tenant_id` from its `public_api_key` alone (see
`packages/embed-widget`), without ever trusting a client-supplied tenant
id. It only ever reveals the single matching, widget-enabled project row,
and grants no additional write access.

`018_extend_memberships_rls_self_lookup.sql` extends the `memberships` and
`tenants` RLS policies with a second, narrower session variable,
`app.current_user_id`, so a request can look up "which tenants does *this*
user belong to" (used by `GET /api/v1/auth/me` and `GET /api/v1/tenants`)
without that query needing `app.current_tenant_id` set first. It only ever
widens visibility to the caller's *own* `user_id` (never an arbitrary one),
and never weakens the `WITH CHECK` clauses that gate writes.

Each file has an `-- Up Migration` section and a `-- Down Migration`
section, which is the format `node-pg-migrate` expects for plain SQL
migrations. `node-pg-migrate` tracks which migrations have run in a
`pgmigrations` table it creates automatically.

### Seeding example data

`014_seed_dev_tenant.sql` (part of the migration chain) and the standalone
`seed.sql` both insert the same example data: one tenant (`devlaunch`) and
one project (`devpilot-academy`), matching the spec's "DevPilot Academy"
example configuration, plus three example ICP segments. All of it is
synthetic/example data.

To seed without running it as a tracked migration (e.g. to reset/reseed a
dev database), run the standalone script directly:

```bash
psql "$DATABASE_URL" -f seed.sql
```

## Schema overview

| Table | Tenant-owned | Notes |
|---|---|---|
| `tenants` | — (root) | One row per customer organization. |
| `users` | No (global) | A person can belong to multiple tenants via `memberships`. |
| `memberships` | Yes | Links `users` to `tenants` with a `role`; the source of truth for "does this user belong to this tenant". |
| `projects` | Yes | Top-level unit of work inside a tenant. |
| `project_profiles` | Yes | 1:1 business context for a project (industry, value prop, goals). |
| `icp_profiles` | Yes | 1:many ideal-customer-profile / audience segments per project. |
| `agent_templates` | Partial | `tenant_id` is nullable: `NULL` rows are global/system templates visible to every tenant; non-null rows are a tenant's own customizations. |
| `agent_instances` | Yes | A configured agent attached to a project, instantiated from a template. |
| `agent_executions` | Yes | One run/invocation of an agent instance. |
| `approvals` | Yes | Human sign-off on an agent execution. |
| `audit_events` | Yes | Append-only action log. |
| `leads` | Yes | Contacts/leads captured for a project, from internal flows or the public embeddable widget (`source` column distinguishes them). |

All primary keys are `uuid` generated with `gen_random_uuid()` (from the
`pgcrypto` extension, enabled in `001_enable_extensions.sql`). Every table
has `created_at`; every table except the append-only `audit_events` also
has `updated_at`, kept current by a shared `set_updated_at()` trigger
function. Every tenant-owned table has a `tenant_id` column with a
supporting index, plus indexes on common lookup columns (status, foreign
keys, slugs, etc).

### Public lead-capture widget columns

`016_add_project_public_key.sql` adds `public_api_key` (random opaque
token, unique, NOT the tenant id or any DB credential), `allowed_origins`
(text[] origin allowlist) and `public_widget_enabled` to `projects`. These
back `POST /api/v1/public/projects/:projectPublicKey/leads` in `apps/api`,
which lets an external website submit leads without any user session —
see `packages/embed-widget` for the paste-in `<script>` snippet.

## Tenant isolation approach

Tenant isolation is enforced at the database layer with PostgreSQL **Row
Level Security (RLS)**, set up in `013_enable_rls_policies.sql`:

1. Every tenant-owned table gets `ENABLE ROW LEVEL SECURITY` **and**
   `FORCE ROW LEVEL SECURITY` (so RLS also applies to the table owner —
   only a superuser or a role with `BYPASSRLS` would skip it, so the
   application's database role must **not** be a superuser or have
   `BYPASSRLS`).
2. Each table gets a policy that requires
   `tenant_id = current_setting('app.current_tenant_id', true)::uuid`
   for both reads and writes (`USING` and `WITH CHECK`).
3. `agent_templates` additionally allows `tenant_id IS NULL` (global,
   shared system templates) in addition to the caller's own tenant.
4. `tenants` itself is restricted by matching the row's own `id` against
   `app.current_tenant_id`, since it has no separate `tenant_id` column.

**The API layer owns setting the session variable.** On every
request (or at the start of every DB transaction), after it has verified
— via the `memberships` table — that the authenticated user actually
belongs to the tenant they are requesting, it must run:

```sql
SELECT set_config('app.current_tenant_id', $1::text, true); -- true = transaction-local
```

or, with a literal value (e.g. in a migration/seed script):

```sql
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
```

If this is never set, `current_setting('app.current_tenant_id', true)`
returns `NULL`, and every policy evaluates to `false` — the connection
sees **zero rows** rather than leaking data from another tenant. This is
a fail-closed default: a bug that forgets to set the tenant context
results in "no rows", not "wrong tenant's rows".

Because `app.current_tenant_id` is set with the transaction-local flag
(`true` to `set_config`, or `SET LOCAL`), it is automatically cleared at
the end of each transaction, so a pooled connection can never leak one
request's tenant context into the next request that reuses it.

This RLS layer is a defense-in-depth measure, not a replacement for
proper authorization checks in the application code — the API must still
verify membership/role before deciding which `tenant_id` to set.
