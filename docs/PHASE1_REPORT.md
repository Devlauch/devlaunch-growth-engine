# Phase 1 Build Report — Growth Platform

**Date:** 2026-11-21
**Audience:** This document is written so a non-technical founder can read the first half (what exists, what to do next) and a developer can use the second half (how to run it, what's stubbed, what's missing) as a punch list.

---

## 1. What was built

### 1.1 Monorepo layout

```
platform/
  apps/
    api/         Node/TypeScript HTTP API (auth, tenants, projects, agent-runs, public lead-capture endpoint)
    worker/       BullMQ worker that executes agents (currently: a mocked market-research agent)
    dashboard/    React + Vite static dashboard (placeholder-level UI, see 1.5)
  packages/
    db/           SQL migrations, seed data, Postgres schema, RLS policies
    agent-sdk/    Shared TypeScript types/contracts used by api + worker
  docker-compose.yml   Postgres, Redis, api, worker, dashboard services wired together
  pnpm-workspace.yaml  Workspace definition (npm-compatible `workspaces` also declared in root package.json)
  README.md            Setup notes + "Known TODOs / Phase 2+" section
```

It is a single pnpm/npm workspace: `agent-sdk` is built first, then `api` and `worker` depend on it, and `dashboard` is an independent Vite app.

### 1.2 Database migrations (`packages/db/migrations`)

19 ordered SQL migrations, applied in order, covering:

- `001` extensions, `002` tenants, `003` users, `004` memberships (tenant↔user roles)
- `005` projects, `006` project_profiles, `007` icp_profiles (ideal-customer-profile data used to drive research/scoring)
- `008` agent_templates, `009` agent_instances, `010` agent_executions (the agent run/job model)
- `011` approvals (a human-in-the-loop approval queue — currently defined but not yet wired to leads, see Strategy section)
- `012` audit_events (append-only audit trail)
- `013` RLS policies enabled tenant-wide (row-level security so one tenant cannot read another's rows)
- `014` seed dev tenant
- `015` leads (public lead-capture table: name/email/company/message/custom_fields/status/source/ip_hash)
- remaining migrations round out indexes/constraints (e.g. `leads_identity_present` CHECK requiring name-or-email)

`seed.sql` populates a dev tenant, a dev user, and sample agent templates so the stack is usable immediately after migrating.

### 1.3 API routes (`apps/api`)

- **Auth:** register / login / refresh / me (real JWT issuance) — plus a dev-only `X-Dev-User-Id` bypass (see "Stubbed vs real" below)
- **Tenants:** create tenant, membership-scoped access, cross-tenant requests correctly rejected with 403
- **Projects:** create/list projects under a tenant, each project auto-generates a `public_api_key` for its lead-capture widget
- **Agent templates / agent instances:** list templates, create an instance of a template on a project
- **Agent runs:** POST a run, which enqueues a BullMQ job for the worker; GET the resulting `agent-executions` (implemented as `GET /api/v1/tenants/:tenantId/agent-executions/:executionId` plus a project-scoped list — see note below on a spec-vs-implementation naming difference)
- **Public lead-capture endpoint:** unauthenticated POST keyed by a project's `public_api_key` + Origin allowlist; validates payload (name-or-email required), writes a `leads` row with `source=public_widget`, and writes a matching `audit_events` row
- **Middleware:** in-process fixed-window rate limiter (not yet Redis-backed — see TODOs)

Note: the spec prose mentions `GET /api/v1/executions/:id`; the implementation instead used the tenant/project-scoped route shown above. This is flagged in the root README as a decision to revisit if the shorter alias is still wanted.

### 1.4 Market-research demo agent (`apps/worker/src/agents/marketResearch.ts`)

A worker-side agent (`runMarketResearch()`) that is invoked via the `agent-runs` → BullMQ → worker pipeline. It currently always uses a `MockResearchAdapter`, which returns schema-valid "evidence" objects (source, timestamp, confidence) but with fixture data, and always marks the output `mock: true`. The adapter boundary is a real interface (`apps/worker/src/agents/researchAdapter.ts`) designed so a real adapter (e.g. Crawl4AI-backed) can be swapped in without changing the agent or API contract.

### 1.5 Public lead-capture widget + embed snippet

A small embeddable JS widget (`embed.js`) that a customer's website can drop in to collect leads (name/email/company/message/custom fields) and POST them to the public lead-capture API endpoint using a project's `public_api_key`. On success it shows a transient "Thanks! We'll be in touch" DOM message (no reference ID surfaced to the submitter — noted as a gap below). Origin allowlisting + identity-presence validation are the only anti-abuse measures currently in place (no honeypot, no consent checkbox, no dedup).

### 1.6 Dashboard screens (`apps/dashboard`)

Builds clean (tsc --noEmit + vite build) and produces a working SPA (index.html + ~187KB JS bundle + CSS), served in production by a small `serve.js` static server that correctly serves `/`, `/healthz`, and client-side routes (e.g. `/tenants/:id`) all as HTTP 200. At this stage it is a functional scaffold/placeholder rather than a full-featured UI — it is wired into `docker-compose.yml` as a real service, but building out the actual tenant/project/lead/agent-execution screens is listed as Phase-2 work in the README.

---

## 2. How to run it locally

**Nothing has been started, deployed, or exposed anywhere as part of this report.** The steps below are what a developer would run; none of them have been executed against a persistent/shared environment (only a throwaway, local smoke test was performed during build verification — see Section 3).

```bash
# 1. Install dependencies (workspace-wide)
npm install --workspaces
# Note: pnpm itself could not be used for installs in the verification sandbox — the only
# `pnpm` on PATH there was a Windows-side npm-global shim that panics under WSL path
# interop; this is an environment quirk, not a project defect. pnpm-workspace.yaml is
# still provided, and root package.json also declares npm/yarn-compatible `workspaces`,
# so npm works identically.

# 2. Build (agent-sdk -> api -> worker -> dashboard via tsc/vite)
npm run build

# 3. Run unit tests
npm run test

# 4. Bring up Postgres + Redis + api + worker + dashboard
docker compose up -d

# 5. Apply database migrations (against the Postgres container)
#    See packages/db/README.md for the exact migration-runner command and .env variables.
#    Migrations must be applied in numeric order (001 ... 019); seed.sql after that.
```

Environment variables (see `platform/.env.example` and `packages/db/.env.example`) must be set before any real/shared run — in particular `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` (placeholders only today) and `ALLOW_DEV_AUTH` (must be `false` outside local dev).

---

## 3. What is stubbed vs real

| Area | Status |
|---|---|
| JWT auth (register/login/refresh/me) | **Real** — working JWT issuance and verification |
| Dev auth bypass (`X-Dev-User-Id` header, `ALLOW_DEV_AUTH`) | **Stub** — must be removed/disabled before any shared or production deployment |
| Tenant isolation / RLS | **Real** — verified live: a second real user got a 403 on cross-tenant access |
| Agent run pipeline (API → BullMQ → worker → execution record) | **Real** — verified live end-to-end |
| Market-research agent output | **Mocked** — `MockResearchAdapter` always returns `mock:true` fixture evidence; no real Crawl4AI or other live-crawl wiring yet |
| Mastra agent runtime | **Not wired** — `@mastra/core` is still a pre-release alpha (`1.86.0-alpha.3`); a `MastraAgentRuntime` adapter is planned but deferred until it reaches a stable semver |
| Public lead-capture endpoint | **Real** — verified live: 404 on unknown key, 403 on disallowed Origin, 201 + real `leads` row + matching `audit_events` row on valid key + allowlisted origin |
| Rate limiting | **Stub-grade** — in-process fixed-window limiter; not safe once more than one API instance runs (needs a Redis-backed limiter) |
| Dashboard UI | **Scaffold** — builds and serves correctly, but is a placeholder-level UI, not the full tenant/lead/agent-execution screens the product needs |
| JWT secrets, DB credentials | **Placeholders only** — real secrets must be generated before any non-local deployment |

---

## 4. Unimplemented items / credentials still required (per the spec's "definition of done")

1. Real OIDC-based authentication to replace the `ALLOW_DEV_AUTH` / `X-Dev-User-Id` dev bypass.
2. `MastraAgentRuntime` adapter in `apps/worker/src/agents/registry.ts`, pending a stable (non-alpha) `@mastra/core` release.
3. A real `Crawl4AIResearchAdapter` (or equivalent) calling a live crawl/research service over HTTP, replacing `MockResearchAdapter`.
4. A Redis-backed rate limiter to replace the current in-process one, required before running more than one API instance.
5. The real `apps/dashboard` UI (tenant, project, lead inbox, agent-execution, approvals screens) — current dashboard is a working but minimal scaffold.
6. Rotated, real `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` values (only placeholders exist in `.env.example`) — required before any non-local deployment.
7. A decision on the `GET /api/v1/executions/:id` route-naming question (spec prose vs. the implemented tenant/project-scoped route).
8. A `public_api_key` rotation endpoint (PATCH/DELETE) for project widget settings — Phase 1 only auto-generates the key at project creation.
9. (Flagged by the strategy review below, not yet built) No `contacted`/`demo_scheduled` lead status, no automatic approvals-table entry or notification when a lead is captured, no lead score/confidence/evidence columns, no role/title or institution-name field on the public widget, no submission reference ID shown to the submitter, no honeypot/consent checkbox, and `ip_hash` is captured but not used for deduplication.
10. No managed hosting, domain, TLS, or real secrets have been provisioned — see the cost review below for the recommended minimal path.

---

## Strategy and cost findings

*The two sections below are reproduced verbatim from the strategy and cost review that accompanied this build, so this single document covers both the technical build and the business read on it.*

### Strategy review (verbatim)

**Biggest gap:**
No closed loop after lead capture: `leads.status` (`015_create_leads.sql`) only supports `new|qualified|rejected|approved_for_outreach|archived` — no `contacted`/`demo_scheduled` state — and `ingestLead()` only writes an audit_events row, never creates an approvals entry or notifies a Sales User/Marketer. A submitted lead can sit in `status='new'` indefinitely with no human nudge, despite the platform already having an approvals table it isn't using for this.

**False-qualification risk:**
`runMarketResearch()` (`apps/worker/src/agents/marketResearch.ts`) always returns `mock:true` via `MockResearchAdapter`, with evidence items that are schema-valid (source/timestamp/confidence) but fixture data. Nothing confirmed the dashboard renders `mock:true` as a hard warning, and `leads.status` can be set to `'qualified'` via a plain UPDATE with zero DB-level requirement that evidence backs the claim (unlike the `leads_identity_present` CHECK, which does enforce name-or-email). This lets confident-looking mock/unverified scores masquerade as real buying signal.

**Next-agent priority order:**
1. Lead-qualification scoring agent (needs new score/confidence/evidence columns on leads, joined against icp_profiles/project_profiles)
2. Lead-discovery agent (swap MockResearchAdapter for Crawl4AIResearchAdapter once scoring exists to act on)
3. Sales-assistant agent (draft-only outreach gated through existing approvals table)
4. SEO agent (lowest priority — no supporting schema yet, slowest feedback loop)

**Next-agent reasoning:**
Lead-discovery would just add more unscored rows to the same leads table that already has no qualification signal (no score/confidence columns exist today) — multiplying noise instead of producing qualified conversations. Qualification scoring must exist first so icp_profiles/project_profiles (migrations 006/007) actually get used, then discovery has something meaningful to feed, then sales-assistant has qualified leads to act on, then SEO last since it has zero schema support currently.

**Widget conversion gaps:**
- No role/title field (Principal, HOD, Dean, T&P Officer) or institution-name field in leads schema — only name/email/company/message/custom_fields, so the exact ICP signal this platform targets has no guaranteed column
- Success message in embed.js is only transient DOM text ("Thanks! We'll be in touch", line 101) with no reference ID shown, giving a skeptical Principal no durable proof of submission
- No honeypot or bot-filtering beyond origin allowlist + name-or-email presence check in leadInputSchema
- No consent/GDPR-style checkbox, which institutional (esp. public university) submitters may expect
- ip_hash is captured but unused for dedup — repeated submissions from the same person create N separate rows instead of one updated lead

### Cost review (verbatim)

**Cheapest hosting recommendation:**
Stack is Postgres+Redis+Node API+Node worker+static dashboard — all commodity, nothing exotic (no vector DB, no GPU, no message broker beyond Redis). Three realistic options: (1) Single small VM (Hetzner CX22 2vCPU/4GB ~€4-5/mo, or DigitalOcean/Linode 2GB droplet ~$12-18/mo) running the existing docker-compose as-is, with Postgres/Redis as containers on the same box — $5-20/mo total, zero managed-service markup. (2) Split managed DBs: Neon/Supabase free tier Postgres (free up to ~0.5GB, then ~$19-25/mo) + Upstash Redis free tier (10k cmds/day free, then pay-per-request, typically <$5/mo at this scale) + a $5-7/mo VM or Render/Railway/Fly.io instance for api+worker+dashboard — roughly $10-30/mo but with automated backups/HA you'd otherwise have to build yourself. (3) All-in-one PaaS (Render or Railway): each service (api, worker, dashboard, Postgres, Redis) as a managed component, ~$7-25/mo per service → $35-70/mo total, no server ops but costs scale fastest. For a bootstrapped first tenant I'd pick option (1): a single $5-12/mo Hetzner/DO VM running the current docker-compose file nearly unchanged (swap localhost URLs for the VM's internal docker network, point a domain + Caddy/Nginx with free Let's Encrypt TLS at it, set ALLOW_DEV_AUTH=false and real JWT secrets). It reuses the exact compose file already written, needs no code changes, and total infra cost is under $15/mo including the domain — the DB/Redis containers on the same box are fine until you have real concurrent write load or need HA, which a single early tenant won't.

**Free vs. paid lead sources:**
Free/compliant sources that fit the spec's "no scraping LinkedIn, prefer official sources" rule and cost nothing beyond the worker's own crawl time: official college/university websites and their placement-cell pages (most publish student/recruiter contact pages directly), public UGC/AICTE institution directories (these are government-published, static, and legally scrapable/fetchable), state/university board websites listing affiliated colleges, public Google/Bing search + the colleges' own "contact us" or "training & placement officer" pages, and public event/conference listing sites for edtech or campus-hiring events. All of these can be driven through the existing `ResearchAdapter` interface (apps/worker/src/agents/researchAdapter.ts) by writing a `PublicDirectoryResearchAdapter` that does simple HTTP fetch + HTML parsing (e.g. Cheerio) against these official, non-LinkedIn sources — no API cost at all, only your own compute (already covered in the VM cost above). This is the right place to start since the worker currently only has a MockResearchAdapter. Paid providers (Apollo.io, Clearbit/Clay, ZoomInfo, Lusha) are not worth it yet: they start around $49-99/mo for a few hundred verified contacts, and at pre-revenue/first-tenant scale the free official-source path will cover initial volume at near-zero marginal cost. Crawl4AI (already named as later-phase work in the README) is itself free/open-source and would upgrade the free path's quality before you need to pay for a data provider at all.

**Optional services, cost ranking:**

| Service | Cost tier | Note |
|---|---|---|
| n8n | low | Lightweight Node app, single container, modest RAM (~512MB-1GB); cheap to self-host alongside the existing stack. |
| listmonk | low | Single small Go binary + reuses your existing Postgres; near-zero added infra cost, safe to turn on early for email/newsletter sending. |
| formbricks | low-medium | Node/Postgres app, similar footprint to the platform itself; fine on the same small VM for surveys/feedback once needed. |
| postiz | medium | Needs its own Postgres+Redis+Node services and social-platform API credentials; roughly doubles your container count if self-hosted. |
| chatwoot | medium-high | Rails app wanting Postgres+Redis+Sidekiq workers of its own; recommended minimum is ~2GB RAM dedicated, effectively needs its own small VM ($10-20/mo) to run well. |
| mautic | high | PHP/MySQL stack, memory-hungry, needs cron workers and its own DB; realistically a separate $15-25/mo VM, plus ongoing PHP/MySQL ops overhead distinct from your Node/Postgres stack. |
| twenty | high | Full CRM: Postgres+Redis+its own API/worker/front-end services; GitHub-recommended minimum is several GB RAM — effectively a second platform-sized deployment ($20-40/mo) to self-host properly. |
| posthog | highest | Self-hosted PostHog needs ClickHouse+Kafka+Postgres+Redis (a multi-service analytics pipeline, several GB RAM minimum); far cheaper to use PostHog Cloud's free tier (1M events/mo free) than to self-host it at small scale. |

**Upgrade trigger:**
Move off the single-VM/free-tier/self-hosted-only path once you're reliably landing paying tenants (e.g. 3-5+ paying customers or sustained >$500-1000/mo revenue) or once free lead-source volume plateaus below pipeline targets despite good coverage — at that point a $49-99/mo data provider (Apollo.io/Clearbit) or managed Postgres/Redis with backups becomes cheap relative to the revenue or sales time it unlocks, whereas before that point every dollar should go to validating the product, not infra.

---

## 5. Prioritized "what to do next" (strategy + cost combined, max 8 items)

1. **Close the lead loop first:** add `contacted`/`demo_scheduled` to `leads.status`, and make `ingestLead()` also create an `approvals` entry (or equivalent notification) so a new lead always produces a human nudge, not just an audit row.
2. **Build the lead-qualification scoring agent next** (before lead-discovery): add score/confidence/evidence columns to `leads`, scored against `icp_profiles`/`project_profiles`, and make the dashboard hard-flag any result where `mock:true` so unverified data can never look like real buying signal.
3. **Replace `MockResearchAdapter` with a free, compliant `PublicDirectoryResearchAdapter`** (official college/placement-cell pages, AICTE/UGC directories, university board sites) via the existing `ResearchAdapter` interface — zero API cost, only compute already budgeted in step 6.
4. **Fix the widget's ICP and trust gaps:** add role/title + institution-name fields, show a durable reference ID on submission instead of a transient toast, add a honeypot field and a consent checkbox, and use the already-captured `ip_hash` to dedupe repeat submissions into one updated row.
5. **Build the sales-assistant agent** (draft-only outreach, gated through the existing `approvals` table) once qualification scoring exists to feed it — then SEO agent last, since it has no supporting schema yet.
6. **Deploy on the cheapest viable path:** a single ~$5-12/mo Hetzner/DO VM running the existing `docker-compose.yml` nearly unchanged, domain + Caddy/Nginx + free Let's Encrypt TLS, `ALLOW_DEV_AUTH=false`, and freshly rotated `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` — total under $15/mo.
7. **Before that deploy, close the remaining Phase-1 hardening items:** real OIDC auth to replace the dev-auth bypass, and a Redis-backed rate limiter (the in-process one breaks once more than one API instance runs).
8. **Hold off on paid data providers and heavy optional services** (Apollo/Clearbit, Chatwoot, Mautic, Twenty, self-hosted PostHog) until there are 3-5+ paying tenants or >$500-1,000/mo revenue, or until the free lead-source path plateaus below pipeline targets — only low-cost add-ons (n8n, listmonk) are worth turning on early.
