# DevLaunch Growth Engine — Intern Onboarding

## What this is

DevLaunch Growth Engine is a **multi-tenant SaaS platform for customer
acquisition**. Think of it as an internal growth/marketing-ops tool: a
company (a "tenant") signs up, creates a project, drops in a tracking/lead
widget, and the platform helps them find prospects, capture leads, score
them, message them, run them through a sales pipeline, and report on
revenue — with AI agents assisting at each stage, and a human always
approving anything consequential before it actually happens (sending an
email, publishing a page, moving money).

It is **not** a single-customer app — every table, every query, every
background job is scoped to a `tenant_id`, enforced at the database level
(not just in application code). That isolation model is the single most
important thing to understand before touching any code here.

## Tech stack

- **Backend:** Node 22 + TypeScript + Express (`apps/api`)
- **Background jobs:** Redis + BullMQ worker process (`apps/worker`)
- **Database:** PostgreSQL 16, raw SQL migrations (`packages/db`), no ORM
- **Frontend:** React 18 + TypeScript + Vite, plain CSS with design tokens
  (no Tailwind, no component library) (`apps/dashboard`)
- **Embeddable widget:** vanilla JS, no framework (`packages/embed-widget`)
- Everything runs via **Docker Compose** locally

## The one concept you must understand: tenant isolation

Every tenant-owned table has Postgres **Row-Level Security** (RLS) forced
on it. A request can only ever see rows where `tenant_id` matches a
session variable (`app.current_tenant_id`) that the API sets *after*
verifying the authenticated user actually has an active membership in that
tenant. This happens in `apps/api/src/middleware/tenant.ts`
(`requireTenantMembership`) — read that file first, it's the key to
everything else.

Critically: the database **role** the app connects as is deliberately
**not** a Postgres superuser (`devlaunch_app`, not `devlaunch`), because a
superuser silently bypasses RLS even if every policy is written correctly.
There's a startup check (`assertDatabaseRoleRespectsRls` in
`apps/api/src/db/pool.ts`) that refuses to run if this is ever violated.
This was a real bug found and fixed during development — see
`docs/SECURITY_REVIEW.md` if you want the story.

**Rule of thumb when writing any new feature:** never trust a `tenantId`
from the client directly. It only ever gets used as a lookup key against
real `memberships` rows, server-side.

## Directory layout

```
apps/
  api/          Express API — routes, middleware, business logic ("lib/")
  worker/       BullMQ worker — runs queued agent jobs + cron-style loops
  dashboard/    React SPA — the actual UI
packages/
  db/           SQL migrations (numbered, sequential) + RLS policies
  embed-widget/ The <script> snippet tenants paste into their own sites
docs/           Architecture, decisions, feature-status docs (see below)
```

## How to run it locally

```bash
cp .env.example .env     # fill in real values — ask a teammate for a dev set
docker compose up -d --build
```

Dashboard: `http://localhost:3000` · API health check:
`http://localhost:4000/api/v1/health`

`.env` is gitignored on purpose — it holds real API keys and secrets.
Never commit a real `.env`.

## What's actually built (don't assume from the name of a feature)

This is a large, long-running project with a lot of surface area —
lead capture, scoring, messaging sequences, a sales CRM/pipeline, an AI
agent platform, workflow automation, billing, website SEO/growth analysis,
and integrations with ~15 external providers (OpenAI, Hunter, Tavily,
Qdrant, PostHog, Sentry, Brevo, etc.).

**Before touching any area, read `docs/FEATURE_STATUS.md` first.** It's
the single source of truth for what's really built (✅), partially stubbed
honestly (🟡), or not started (⬜) — multiple people/AI sessions have
worked on this in parallel, so this file is how everyone stays in sync.
Don't trust a route or UI page existing to mean the feature behind it is
complete; some things intentionally return `"not_configured"` rather than
fake data when a credential isn't set up.

Other useful docs:
- `docs/ARCHITECTURE.md` — request flow from dashboard → API → queue →
  worker → agent, with the tenant-isolation mechanics spelled out
- `docs/SECURITY.md` / `SECURITY_REVIEW.md` — the RLS model and real
  findings/fixes
- `docs/INTEGRATION_STATUS.md` — which external providers are wired up
  and how they degrade gracefully when not configured

## Ground rules for new code here

- **Never fabricate a successful response.** If a provider/integration
  isn't configured, the code must honestly report that (`not_configured`,
  a clear error) — never return fake/placeholder data dressed up as real.
- **Everything new is tenant-scoped with RLS**, following the exact
  pattern in an existing migration — copy one, don't invent a new scheme.
- **Human approval gates anything consequential** (sending a real email,
  publishing, spending money) — the `approvals` table + flow already
  exists, reuse it rather than building a second approval mechanism.
- Don't introduce a second version of something that already exists (a
  second CRM, a second email sender, a second analytics pipeline) — check
  `FEATURE_STATUS.md` first.

## Suggested first task

Run the app locally, create a test tenant through the dashboard sign-up
flow, create a project, and walk a lead through the pipeline by hand
(capture → score → message → move through the deal pipeline). That tour
touches most of the architecture (RLS, the queue/worker, the approval
gate) without requiring you to write code yet — a good way to build a
mental model before your first real PR.
