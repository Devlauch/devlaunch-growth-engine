# Open-Source Integration Audit

Milestone 1 deliverable for the DevLauch Growth Engine open-source integration effort.
Produced by five parallel read-only research passes over the 13 cloned reference
repositories under `~/project/Growth/` plus the existing `platform/` codebase, and
cross-checked against platform's actual source (not just its intended design) where a
real overlap question existed (e.g. `growthAnalyzer.ts`, `agent_executions`,
`leadGeneration.ts`, `crawl4aiClient.ts`).

Nothing in this document was cloned or installed as part of producing it — this is
pure read-only due diligence, as required before any integration code is written.

## How to read this document

Each repository gets a one-line verdict in the comparison table below, then its own
section with: what it is, architecture, reusable surface, DB/auth requirements,
license obligations, security/maintenance risk, overlap with platform, and a
recommended integration approach. A final section rolls this up into licence
assessment, dependency conflicts, security risks, infrastructure requirements, and
implementation priorities, per the spec's required deliverable shape.

---

## 1. Repository comparison

| Repo | Verdict | Why |
|---|---|---|
| `crawl4ai` | **Keep — already integrated** | Already a verified production dependency (`crawl4aiClient.ts`, `websiteCrawler.ts`, `growthAnalyzer.ts`). Only operational hygiene remains. |
| `chatwoot` | **Adopt — independent service** | Only gap-filler for live chat/chatbot. MIT core, Rails/Ruby (can't merge in-process). Enterprise dir (Captain AI) is paid. |
| `listmonk` | **Adopt — independent service** | Lightest, best-fit email/list engine. Same DB family (Postgres) as platform. AGPLv3 — use unmodified. |
| `postiz-app` | **Adopt — independent service** | Only gap-filler for social publishing (37 provider integrations already built). AGPLv3, no commercial carve-out — call via API only, never fork. |
| `twenty` | **Conditional — build lighter native CRM instead, or adopt as external service** | Full CRM platform; likely overkill for platform's "sales pipeline" gap. AGPLv3 with an explicit "Application Exception" that makes API/webhook use license-safe. Good reference data model either way. |
| `formbricks` | **Adopt selectively — MIT widget only, or independent service** | Survey/NPS engine, not a lead-capture replacement. Backend is AGPLv3 (avoid modifying); `js-core`/`surveys` SDK is MIT and embeddable standalone. |
| `posthog` | **Do not self-host — use Cloud API or build internal analytics** | Clean gap (platform has no product analytics), but self-hosting means ClickHouse+Kafka+Zookeeper+object storage — disproportionate. MIT core, `ee/` is proprietary. |
| `n8n` — **Do not monetize without a commercial agreement** | Complementary (external integration glue, not an orchestration replacement), but its Sustainable Use License forbids reselling execution to paying customers without a paid n8n agreement. |
| `mastra` | **Do not adopt as orchestration layer** | Platform's existing `agent_executions` system already does this, is RLS-integrated, and works. No concrete capability gap identified. Apache-2.0 core; `ee/` paths excluded. At most, cherry-pick its tool-calling loop as a library. |
| `aaron-marketing-skills` | **Adopt as content, not code** | Pure Markdown/JSON prompt-skill library, Apache-2.0, zero runtime dependency. Load `SKILL.md` files into agent prompts. |
| `mautic` | **Skip — redundant with listmonk, heavier, no multi-tenancy** | PHP/Symfony/MariaDB stack; GPLv3 (SaaS-safe); only worth it if platform needs branching automation/forms/lead-scoring beyond campaigns. |
| `OpenOutreach` | **Skip** | Thin Django wrapper around two external PyPI packages not in this clone; single-operator tool with fixed email footer and third-party data pooling. Apache-2.0 but wrong shape. |
| `leadhub` | **Skip** | Functionally redundant with platform's existing (more mature) lead-discovery/scoring pipeline. Single-day commit history, effectively unmaintained, unpinned third-party OSINT dependency. |

---

## 2. Platform's existing baseline (for overlap comparisons)

Confirmed directly from source, not assumed:

- **Lead discovery/scoring**: `apps/api/src/workflow/stages/leadGeneration.ts` composes discovery (`@devlaunch/agent-sdk` connector registry, e.g. `PublicDirectoryConnector`), enrichment (`companyEnrichment.ts`), ICP matching (`icpMatching.ts`), and rubric-based scoring (`scoreLead.ts`, `routes/scoring.ts`).
- **Growth/competitor crawling**: `apps/api/src/lib/growthAnalyzer.ts` reuses `crawl4aiClient.ts` (already verified against a live `unclecode/crawl4ai:0.9.6` container, documented in `docs/CRAWL4AI_VERIFICATION.md`), also used by `routes/competitors.ts` and `apps/worker/src/agents/websiteCrawler.ts`'s `HttpCrawl4AIBackend`.
- **Agent orchestration**: `agent_executions` (see `packages/db/migrations/010_create_agent_executions.sql`) — a lean, RLS-scoped, tenant-isolated state machine (`status`: queued/running/succeeded/failed/cancelled/awaiting_approval; `trigger`: manual/schedule/event/api), triggered from `apps/api/src/routes/agentRuns.ts`/`reports.ts`, executed in `apps/worker`.
- **Multi-tenancy**: Postgres row-level security (RLS) on every tenant-owned table, keyed off `current_setting('app.current_tenant_id', true)::uuid` — the defining architectural choice every third-party repo has to be evaluated against. None of the 13 repos use RLS; they use app-layer scoping (Chatwoot `account_id`), schema-per-workspace (twenty), or no multi-tenancy at all (listmonk, mautic, leadhub, OpenOutreach).
- **Gaps confirmed genuinely absent today**: real email/campaign sending, social-media publishing, live chat/chatbot, CRM/sales pipeline, product analytics/event tracking, survey/NPS tooling.

---

## 3. Per-repository findings

### crawl4ai

- **What it is**: the Apache-2.0 async web-crawling/extraction engine powering the commercial "Crawl4AI Cloud" API; this repo is the open-source core + self-hostable Docker server.
- **Already integrated**: platform's `crawl4aiClient.ts` and `websiteCrawler.ts` already call a running `unclecode/crawl4ai:0.9.6` container's `/crawl` endpoint; `growthAnalyzer.ts`'s own doc comment confirms it deliberately reuses this client rather than reinventing it.
- **Architecture**: Python ≥3.10, async-first, runs real Chromium/Firefox/WebKit via Playwright/Patchright. Self-hosted server (`deploy/docker/`) has its own auth gate, egress proxy with SSRF tests, rate limiting, crawler pool, MCP bridge. Hardened Docker defaults (`cap_drop: ALL`, read-only root FS, memory/PID limits).
- **DB**: none required externally; local SQLite for caching, optional Redis for the self-hosted server's queue state. Runs as an independent service — matches how platform already consumes it.
- **Auth**: bearer-token (`CRAWL4AI_API_TOKEN`) for the self-hosted server; no multi-tenancy of its own, which is fine since platform treats it as an internal backend.
- **License**: Apache 2.0 **plus an added Attribution Requirement clause** — any public use must display "This product includes software developed by UncleCode... as part of the Crawl4AI project" (README/NOTICE/credits page/CLI help). This is a real, enforceable obligation beyond plain Apache-2.0 and should be confirmed as satisfied somewhere in platform's UI/docs.
- **Security/maintenance**: very actively maintained, publishes GitHub Security Advisories, documents unsupported-version cutoffs (0.8.x no longer patched) — platform's pinned `0.9.6` is current.
- **Recommended action**: no integration work needed. Action items are operational only: (a) verify the running container stays on the current supported minor, (b) verify the Apache attribution/NOTICE requirement is actually satisfied in platform's public-facing surface, (c) consider adopting additional already-available endpoints (`/crawl/stream`, `/screenshot`, `/pdf`, `/execute_js`, MCP bridge) beyond the single `/crawl` call used today.

### chatwoot

- **What it is**: Rails/Vue omnichannel customer-support platform (live chat widget, email, WhatsApp, social channels, help center), with a first-party "Captain" AI agent feature.
- **Architecture**: Ruby 3.4.13 / Rails 8.0.5.2 backend, Vue/Vite frontend. Fully separate language runtime/deploy pipeline from platform's Node/TS stack — cannot be merged in-process, only run as an independent service.
- **Reusable surface**: extensive REST API (`api/v1/accounts/*`, `api/v1/widget/*` for the public embeddable widget), and a first-class **webhook-based bot integration model** (`AgentBot` — `outgoing_url` + `secret`) that lets an external AI/chatbot service register, receive conversation events, and reply via the API — i.e. a chatbot hand-off pattern without needing the paid "Captain" feature.
- **DB**: Postgres + Redis (Sidekiq), fully separate instance from platform's — no shared schema possible.
- **Auth/multi-tenancy**: Devise session/token auth; `Account` is the tenant/workspace model, and nearly every table is scoped by `account_id` — genuinely multi-tenant, but isolation is enforced at the **app layer**, not via DB-level RLS like platform. This is a materially weaker isolation guarantee if platform's compliance posture depends on RLS-grade enforcement.
- **License**: core app is MIT; `enterprise/` directory (includes Captain AI, likely SSO) requires a paid Chatwoot Enterprise subscription — not AGPL, no copyleft, just a subscription gate on specific features.
- **Security/maintenance**: handles customer PII/chat transcripts directly — real compliance surface (GDPR/CCPA). The public widget API is deliberately unauthenticated by design (any visitor can start a conversation) and is the primary external attack surface needing independent hardening/rate-limiting. Actively maintained (v4.20.1).
- **Recommended action**: run as a fully independent service (own Postgres/Redis/Rails/Sidekiq/Vite containers). Embed the widget snippet in platform's customer-facing pages; use REST API + outgoing webhooks to sync conversation events into platform; use the `AgentBot` webhook model if/when platform wants its own AI chatbot logic instead of paying for Captain. Exclude/budget separately for `enterprise/`.

### listmonk

- **What it is**: a standalone, self-hosted newsletter/mailing-list manager — subscriber/list management, campaign composition and sending, bounce processing, public subscribe/unsubscribe pages, and a transactional-email API. Single static Go binary.
- **Architecture**: Go 1.27, Echo router, Postgres via sqlx — **same DB family as platform**. Compiles to one binary; ships a genuinely turnkey, 2-container `docker-compose.yml` (`app` + `db`). By far the lightest footprint of any candidate repo.
- **Reusable surface**: concrete, well-documented REST API — `POST /api/tx` (transactional send, including to addresses not in the subscriber DB), `POST /api/campaigns` + `PUT /api/campaigns/:id/status` (create/trigger a send), and **first-class inbound bounce/complaint webhook handlers already built for Amazon SES, SendGrid, and Postmark** (`POST /webhooks/service/:service`) — exactly what platform would need for ESP callback ingestion.
- **DB**: Postgres, compact schema (~483 lines). No `tenant_id`/RLS concept anywhere (confirmed via grep) — single-tenant by design.
- **Auth**: native API-key (`api_key:access_token` header) + session auth + permission system + OIDC support.
- **License**: **AGPLv3** — network-use copyleft. Running stock/unmodified listmonk and calling its documented API does not trigger source-disclosure; **any customization** (custom bounce handling, multi-tenant patches, white-labeling) would.
- **Security/maintenance**: actively maintained (commits days old at audit time), has its own `SECURITY.md`. Bounce webhook endpoints are necessarily internet-facing; SendGrid path is signature-verified in code, SES/Postmark paths should be checked for equivalent verification before exposing publicly.
- **Recommended action**: run as an independent service, call its REST/webhook API unmodified (stay inside the AGPL-safe "arms-length service" pattern). Because it has no tenant concept, either (a) run one listmonk instance+DB per tenant (very feasible given its light weight), or (b) run one shared instance as platform's own sending engine, with platform's own RLS-isolated Postgres owning tenant-facing list/subscriber data and pushing to listmonk via its API. This is the single strongest-fit candidate in the entire audit.

### postiz-app

- **What it is**: a social-media scheduling/publishing/analytics platform (NestJS/Next.js/Temporal), with an official Postiz Cloud SaaS and a feature-equivalent self-hosted edition.
- **Reusable surface**: a public REST API (`/public/v1`, documented, official `@postiz/node` SDK, n8n/Make.com integrations) sitting in front of **37 confirmed social-provider integration files** (X, LinkedIn, TikTok, Facebook, Instagram, YouTube, Pinterest, Threads, Mastodon, Bluesky, Discord, Slack, Telegram, and 24 more) — each already handling OAuth connect/refresh/publish/media-upload with a shared interface and Temporal-based retry taxonomy. This represents a large amount of integration work platform would otherwise have to build and maintain per-network itself.
- **Architecture**: Postgres 17 + Redis + a full Temporal cluster (+ its own Postgres + Elasticsearch) for scheduling/retries — a notably heavier operational footprint than platform's BullMQ-based worker, and a different orchestration paradigm (no code/library reuse realistic, API-only integration).
- **Auth/multi-tenancy**: native `Organization` ↔ `User` multi-tenancy, each org with its own API key and connected integrations; public-API auth resolves to a scoped `Organization` at the middleware layer (not DB-level RLS).
- **License**: **AGPLv3, no commercial carve-out found** in this clone. Calling an unmodified, separately-run Postiz instance over its API is the safe path; forking/modifying its source would trigger network-use copyleft with no escape hatch (unlike twenty's exception, see below).
- **Security/maintenance**: very active (commercially backed), shows deliberate SSRF-safety handling for media fetches. Real credential-management burden: dozens of per-social-network OAuth app secrets (each network also requires its own developer-app registration/review, which can take weeks independent of integration code). One unresolved flag: whether stored OAuth tokens are field-level encrypted was not confirmed from the schema alone.
- **Recommended action**: run as an independent service (its own Postgres/Redis/Temporal cluster); integrate purely via its public REST API/SDK, never fork. Map one Postiz `Organization` per platform tenant. Budget the OAuth app-registration/review process per social network as the real integration cost, not the API wiring itself.

### twenty

- **What it is**: an extensible, code-first "CRM construction kit" (objects/fields/views defined as code) rather than a fixed-schema CRM, with REST, GraphQL, and MCP APIs, webhooks, and its own AI-agent layer.
- **Architecture**: NestJS 12 + TypeORM + GraphQL, Node `^26.5.1` (notably bleeding-edge — verify against platform's actual Node version before any shared tooling, irrelevant if run as a separate container). Multi-tenancy is **schema-per-workspace** in Postgres — architecturally incompatible with platform's single-schema-with-RLS model; cannot be embedded, must run as a fully separate service with its own Postgres cluster.
- **Reusable surface**: dual REST + GraphQL API, an MCP server (already agent-callable out of the box), and outbound webhooks on CRM object events (new Person, new Opportunity, etc.) — the natural sync path into platform (CRM event → webhook → platform ingests lead/deal). Ships its own LLM-agent framework, Gmail/Microsoft inbox+calendar sync, and billing — a notably large product surface for what platform's stated gap ("sales pipeline") actually needs.
- **License**: **AGPLv3 with an explicit "Twenty Application Exception"** — critically, building an external "Application" that calls Twenty only through its published REST/GraphQL APIs, webhooks, or SDKs does **not** trigger AGPL obligations, and such an Application may be licensed on proprietary terms. Only modifying Twenty's own source triggers full AGPL copyleft. Some `ee/`-style marked files are separately commercially licensed.
- **Security/maintenance**: extremely active (VC-funded), but a large attack surface if self-hosted — SSO, inbox/calendar PII ingestion, dynamic per-tenant DDL generation (a higher-severity bug class than typical CRUD), its own AI-agent layer with multiple LLM provider keys to secure.
- **Recommended action**: a genuine architecture decision, not a clear-cut skip. Given platform already has its own RLS multi-tenancy/auth and the actual gap is "sales pipeline," not "full extensible CRM with inbox sync and AI agents," **building a lighter native CRM** (using Twenty's Person/Company/Opportunity/Task/Note/Timeline model purely as a reference schema) is the better fit *unless* there's a concrete near-term need for CRM-grade UI/SSO/permissions platform doesn't want to build itself — in which case running Twenty as an external service accessed only via its license-safe API/webhook surface is a legitimate alternative.

### formbricks

- **What it is**: an open-source survey/experience-management platform ("Qualtrics alternative") — in-app/website/link/email surveys with no-code branching logic and audience targeting.
- **Architecture**: TypeScript/Next.js monorepo. The *current* stack is heavier than vanilla Formbricks: it bundles AuthZed/SpiceDB (authorization is a **hard runtime dependency** — "without it, every authorization check refuses," per its own ADR-0018), a Cube analytics service, and an AI/embedding "Hub" service, alongside Postgres/Redis.
- **Reusable surface**: versioned REST API (`v3`, OpenAPI spec), native per-workspace webhook model, and a **framework-agnostic, MIT-licensed embeddable SDK** (`packages/js-core` + `packages/surveys`/`survey-ui`) built with Vite — this part is low-risk to vendor directly regardless of the AGPL backend. It's a full survey-logic engine (branching/targeting/templates), not a drop-in lead-capture replacement, though it could subsume lead-capture as one survey template if desired.
- **DB/auth**: Postgres via Prisma plus a mandatory SpiceDB instance (its own Postgres-backed datastore) plus Redis — not a lightweight add-on. Strong native multi-tenancy (`Organization` → `Workspace`/`Team`/`Membership`, scoped API keys with read/write/manage permission levels).
- **License**: **mixed** — SDK packages (`js-core`, `android`, `ios`, `api`, `surveys`, `survey-ui`) are MIT; `apps/web/modules/ee` is commercially gated; everything else (web app core, database schema, backend logic) is **AGPLv3** — a real obligation if platform modifies formbricks core and offers it over the network to its own customers.
- **Security/maintenance**: very actively maintained (commits days old), explicit prompt-injection assessment requirements for LLM/MCP code, fail-closed authorization design. Public-facing survey/link pages are a real attack surface (untrusted input, file uploads).
- **Recommended action**: do not fork/modify the AGPL-covered backend. If only the survey/NPS capability (not lead-capture) is wanted, run Formbricks as an independent service (full SpiceDB/Postgres/Redis stack) and integrate via its v3 REST API + native webhooks. If only the lightweight embeddable widget is wanted, vendor the MIT-licensed `js-core`/`surveys` packages directly while still talking to a separately-hosted Formbricks backend for storage/logic.

### posthog

- **What it is**: a combined product-analytics/session-replay/feature-flag/experimentation/CDP/data-warehouse/AI-observability platform — not a point SDK, a full multi-service product.
- **Architecture**: mixed Python/Django + React + a growing Rust ingestion tier. Confirmed datastore requirements from `docker-compose.base.yml`: **Postgres 15 + Redis 7 + ClickHouse + Kafka (Redpanda) + Zookeeper + SeaweedFS (S3-compatible object storage)** — a 7+ service stack, roughly doubling platform's entire operational surface for one feature.
- **Reusable surface**: Capture API (event ingestion), feature flags, session replay, and — most relevant to "customer acquisition analytics/revenue attribution" — Web analytics, Group analytics (useful for B2B revenue attribution), Experiments, and a Warehouse/CDP layer for blending external revenue data.
- **Auth/multi-tenancy**: real, long-maintained `Organization` → `Team`/Project → `PersonalAPIKey` model; bearer auth throughout. Separate from platform's own RLS model — would need a full adapter layer if ever embedded, though self-hosting wouldn't need one since it'd run standalone.
- **License**: **MIT** for everything outside `ee/`; the `ee/` directory (historically enterprise/paid features) is separately and more restrictively licensed — any self-hosting plan must avoid depending on `ee/` features without an enterprise license.
- **Security/maintenance**: very actively maintained, large engineering org. Operational complexity if self-hosted is genuinely high (ClickHouse cluster ops, Kafka/Zookeeper, a Rust ingestion tier) — new skill/on-call surface for a team currently running just Postgres+BullMQ.
- **Recommended action**: **do not self-host the OSS stack.** In order of preference: (a) use **PostHog Cloud** (hosted) with the `posthog-js`/`posthog-node` SDKs against the hosted capture API — near-zero new infra, paid per event; or (b) build a lightweight internal analytics layer on platform's existing, already-RLS-integrated `usage_events` table plus a small aggregation job in `apps/worker`, deferring ClickHouse-scale performance until event volume genuinely requires it. Revisit full self-hosting only if event volume and feature need (replay, heavy flags/experiments) justify the ClickHouse/Kafka burden.

### n8n

- **What it is**: a visual, node-based workflow/automation builder with 1500+ integrations, meant for wiring platform (or its customers) into arbitrary third-party SaaS tools, APIs, and AI models.
- **Architecture**: TypeScript monorepo (Express + TypeORM backend, Vue 3 frontend). DB: SQLite or Postgres only (MySQL/MariaDB support dropped in this version) — an isolated instance is advisable, should not share platform's RLS-protected schema.
- **Reusable surface**: a webhook trigger surface (external callers hit an activated workflow's registered path directly) and a scoped, API-key-authenticated public REST API (`workflows.public.controller.ts`: publish/unpublish/run/CRUD) — both confirm workflows can be triggered externally without duplicating orchestration logic inside platform.
- **Auth/multi-tenancy**: API-key auth with scoped permissions; a "Project" team-workspace concept exists but is **gated behind the Enterprise license** and is designed for internal team RBAC within one organization's instance, **not** as a vetted security boundary for hosting many mutually-untrusting external customers from one shared instance — any "multi-tenant hosting of n8n for external customers" plan should be treated as unverified/high-risk until explicitly tested.
- **License**: **Sustainable Use License v1.0** (fair-code, not OSI open source) — confirmed verbatim: usable only for internal business purposes or non-commercial/personal use; redistribution must be free of charge for non-commercial purposes. **This directly blocks reselling n8n workflow execution as a paid feature to platform's own SaaS customers without a paid commercial/OEM agreement from n8n.** Enterprise-gated (`.ee.`) files require a separate paid Enterprise License.
- **Security/maintenance**: actively maintained (v2.49.0). The Code node exposes arbitrary JS/Python execution (run via separate task-runner processes for isolation, but still a meaningful RCE/sandbox-escape surface if ever exposed multi-tenant). Credentials are encrypted at rest.
- **Recommended action**: run as a fully independent, arms-length service (separate container/DB, invoked only via webhook or scoped API key) for **platform's own internal use** (e.g. letting platform's own ops team build glue workflows). **Do not ship n8n execution as a monetized, customer-facing feature without first securing a commercial/OEM agreement with n8n** — this is a licensing blocker, not just a technical one, and should go to whoever owns commercial/legal decisions before any product plan assumes it.

### mastra

- **What it is**: a TypeScript AI-agent/workflow framework (model routing across 40+ LLM providers, agent/tool abstractions, graph-based workflows, human-in-the-loop suspend/resume, memory, MCP authoring) — a library/framework, consumed via `npm install`, not a hosted product.
- **Architecture**: large pnpm-workspace monorepo, ~33 independently-versioned, independently-publishable packages (`@mastra/core`, `@mastra/memory`, etc.), each with its own subpath exports — genuinely consumable as a scoped dependency rather than an all-or-nothing framework adoption. Storage is pluggable, including a Postgres adapter (`stores/pg`) — unlike PostHog, adopting specific Mastra primitives would not force a new datastore onto platform.
- **Node compatibility flag**: Mastra requires Node `^22.19.0 || >=24.11.0`; platform's Dockerfiles use `node:22-alpine` (floating). As long as the resolved image is ≥22.19 this is fine, but should be pinned explicitly (e.g. `node:22.19-alpine` or newer) rather than left floating.
- **The real architectural question**: does Mastra's orchestrator replace platform's existing `agent_executions` system? **No — explicitly recommended against.** Platform's system is small, working, already RLS-integrated, and already has the human-approval gate semantics (`awaiting_approval` status) that Mastra would need its own adapter to replicate. No concrete capability gap was identified in platform's current system that Mastra uniquely fills. Replacing a working, tenant-isolated system with an entire external orchestration framework mid-project is high-risk, low-payoff.
- **License**: **Apache 2.0** for everything outside `ee/`-namespaced directories (`auth/ee`, `editor/ee`, `agent-builder/ee`), which require a paid enterprise license for production use.
- **Recommended action**: keep `agent_executions` as the system of record. Only if a specific pain point surfaces (e.g. hand-rolled multi-provider LLM client code becoming unmaintainable, or a genuine need for a declarative branch/parallel workflow DSL), consider adding `@mastra/core` as a scoped dependency inside the worker's execution step for that one capability — e.g. its tool-calling loop or model-router — writing results back into platform's existing `agent_executions` row, rather than letting Mastra own run lifecycle, storage, or multi-tenancy.

### aaron-marketing-skills

- **What it is**: a content/prompt repository — "120 marketing skills, 7 disciplines" — packaged as a Claude Code plugin and portable skill set, **not executable software**. Confirmed by file-type census: 523 Markdown files, 244 JSON (metadata/registries), 158 Python (stdlib-only, CI/validation tooling only, not runtime).
- **Structure**: each skill is a directory with a `SKILL.md` (YAML frontmatter: name, description, `allowed-tools`, version) followed by Markdown instructions — meant to be read by an LLM agent host, not compiled/executed.
- **DB/auth**: none — stateless content.
- **License**: clean **Apache 2.0** throughout (root `LICENSE` plus per-skill frontmatter `license: Apache-2.0` field) — no mixed-license caveat, unlike posthog/mastra.
- **Security/maintenance**: low operational risk since nothing executes in the runtime path; risk is entirely in prompt-content quality/trust, not infrastructure. The repo's own `scripts/connectors/` (tavily, firecrawl, resend, etc.) are optional CI-only data fetchers and should not be assumed to run as part of "loading a skill."
- **Recommended action**: treat purely as a content/prompt asset library. Copy the relevant `SKILL.md` files into a platform-owned prompt-template store (new table, or a static asset directory read by `apps/worker`), index by discipline/phase using the repo's own `references/system-catalog.json` as a routing map, and inject the matching skill's Markdown body into an agent-execution's system/context content when an `agent_instances` row is configured as a marketing-flavored agent. Do not adopt the repo's own Python/Bash CI tooling.

### mautic

- **What it is**: "the world's largest open source marketing automation project" — contacts, segmented lists, a visual campaign/automation builder, email marketing, landing pages, forms, dynamic content, and a plugin/integration marketplace.
- **Architecture**: PHP 8.2+/Symfony, bundle-based. No production-ready Docker Compose in the repo (only a DDEV dev config) — production deployment is a full Apache+PHP-FPM+MariaDB(+Redis)+cron stack, the heaviest footprint of any candidate repo.
- **Reusable surface**: real OAuth2-protected REST API across bundles (contacts/leads, lists, campaigns, email send — including "send this email to this specific contact"), plus a genuine WebhookBundle for outbound event delivery (contact-created, email-open/click, form-submit, campaign events) with its own delivery queue/retry/kill-switch semantics.
- **DB**: **MySQL/MariaDB only**, confirmed from Doctrine config (utf8mb4/row_format settings have no Postgres equivalent) — cannot share platform's Postgres instance under any circumstance; a wholly separate DB engine must be added to the stack.
- **Multi-tenancy**: **not natively supported.** Has a soft per-user "owner" scoping and a "Companies" CRM entity, but no tenant_id/schema-per-tenant isolation. Serving many unrelated client tenants from one instance means they share the same DB/namespace/admin surface — real isolation would require one Mautic instance per tenant, which multiplies the already-heavy LAMP-stack footprint per tenant.
- **License**: **GPLv3** — no network-use/SaaS clause (unlike AGPL), so running a modified Mautic as a backend service behind platform does not by itself trigger source-disclosure; only distributing Mautic's code to third parties would.
- **Overlap**: significant overlap with listmonk (both do list/segment management and campaign sending). Mautic adds forms/landing-pages/lead-scoring/multi-channel automation that listmonk doesn't attempt.
- **Recommended action**: **skip as the default choice.** Given platform's actual stated gap ("no email-sending/campaign infrastructure, no list management") is fully covered by listmonk at a fraction of the operational cost, and Mautic has no native multi-tenancy while listmonk's lighter weight makes per-tenant instances actually feasible, Mautic is only worth reconsidering if platform's roadmap grows to need branching marketing-automation workflows, forms, or lead-scoring beyond campaigns/lists — and even then, it should be added alongside listmonk's transactional/campaign role, not as a replacement, to avoid running two overlapping list/campaign systems simultaneously.

### OpenOutreach

- **What it is**: a self-hosted, Django-based CLI that discovers leads via a licensed data provider, qualifies them with an LLM (with a written reason per lead), and sends a cold-email opener from the operator's own mailbox. Markets itself as "zero platform-ToS surface."
- **Critical finding**: this repo is a **thin orchestrator, not the actual pipeline** — the real discovery/qualification/enrichment logic lives in two external PyPI packages (`openoutfind`, `openoutsend`) hosted on separate GitHub repos not present in this clone, pinned at exact versions and re-pinned almost daily by the same single maintainer (a real supply-chain/version-drift risk).
- **Architecture**: Python ≥3.12, Django used purely as an ORM host (no web surface). Single SQLite file per install (`~/.openoutreach/data/db.sqlite3`) — a single-operator local tool, not multi-tenant, no internal auth layer.
- **Non-license behavioral baggage** (disclosed in its own `LEGAL_NOTICE.md`): auto-subscribes the operator to a project newsletter by default outside protected jurisdictions, fixes an **immutable "Sent with OpenOutreach" footer on every outbound email** (cannot be removed), and funnels discovered contacts into the maintainer's shared central store (`hub.openoutreach.app`) pooling resolved contacts across all installs — a real data-sharing/privacy consideration for a client-facing multi-tenant SaaS.
- **License**: Apache 2.0, no copyleft — but the behavioral baggage above matters more than the license here.
- **Overlap**: partially redundant with platform's existing discovery/scoring pipeline (which already looks more mature — enrichment, dedup, multi-tenant rubric scoring are already-built, named features); the "LLM writes a qualification reason per lead" idea and the cold-email send-agent half are the only genuinely new concepts.
- **Recommended action**: **skip as a dependency.** Wrong shape (single-operator Django CLI, Python 3.12, SQLite, immutable branding, third-party data pooling) for a multi-tenant client-facing SaaS. If platform wants the "LLM-written qualification reason" idea or a cold-outreach send-agent, reimplement the *concept* natively in TypeScript against platform's own ICP/scoring pipeline and its own email infrastructure.

### leadhub

- **What it is**: "Open-source B2B lead discovery for AI agents" — an MCP server (FastMCP) exposing a `leadhub_find_leads` tool that runs discover → qualify → harvest → fetch → save → export, plus a YAML-driven CLI.
- **Architecture**: Python ≥3.12, no web framework, SQLite (3 flat tables, no FK relationships). No Dockerfile/docker-compose in the repo — self-hosting is explicitly left to the user.
- **Reusable surface**: MCP tools only (`leadhub_find_leads`, `leadhub_search_web`, `leadhub_qualify_domain` [rule-based, no LLM], `leadhub_harvest_domain`, etc.) — would require a subprocess/MCP bridge to call from Node/TS, not natively callable.
- **Dependency risk**: its most useful enrichment path depends on installing the third-party **`theHarvester`** tool directly from its GitHub repo (not a pinned PyPI release) — an unpinned supply-chain dependency, and itself a large OSINT tool with its own scraping/ToS exposure. DuckDuckGo-based search is also fragile to anti-scraping changes.
- **Maintenance risk**: **high** — git log shows exactly 3 commits, all on the same calendar day (2026-06-13), with nothing since. No CI config, no tests directory found. Likely a one-shot publish, not an actively maintained project.
- **License**: MIT, no obligations.
- **Overlap**: **largely duplicates** platform's existing, more mature discovery/scoring pipeline — different data source (DuckDuckGo + theHarvester vs. platform's public-directory connector + ICP matching + rubric scoring), but platform's own pipeline already looks considerably more capable and tenant-aware.
- **Recommended action**: **skip.** Functionally redundant, effectively unmaintained, unpinned third-party dependency, no multi-tenancy/auth model to fit platform's RLS architecture. At most, the narrow idea of "theHarvester-style OSINT domain harvesting" could be reimplemented natively as a future discovery-source connector inside `@devlaunch/agent-sdk` — not by wrapping this repo.

---

## 4. Licence assessment (roll-up)

| License | Repos | Practical obligation for platform |
|---|---|---|
| MIT | crawl4ai core (minus attribution clause), chatwoot core, posthog core, formbricks SDK packages, aaron-marketing-skills, leadhub | None beyond standard notice retention. Chatwoot/posthog `ee/`/`enterprise/` directories are separately gated — avoid or pay. |
| Apache 2.0 | OpenOutreach, mastra core (minus `ee/`), aaron-marketing-skills | None beyond notice retention. crawl4ai additionally requires a visible attribution credit (not just notice-file retention) — verify this is actually displayed somewhere in platform's UI/docs. |
| GPLv3 (no network clause) | mautic | Safe to run as an unmodified or even modified backend service — only distributing Mautic's own code to third parties triggers disclosure. |
| AGPLv3 | listmonk, postiz-app, formbricks backend, twenty (with Application Exception), chatwoot `enterprise/` (actually proprietary, not AGPL) | **Run unmodified, call only via documented API/webhooks.** Any code-level modification to the AGPL-covered backend forces that modified source to be published to users interacting with it over the network. Twenty's explicit "Application Exception" is the one case where calling via API is contractually confirmed license-safe even beyond the general AGPL interpretation — the others rely on the standard (less explicitly spelled out) "unmodified service, API-only" argument. |
| Sustainable Use License v1.0 (fair-code, not OSI) | n8n | **Blocks reselling to paying customers without a commercial/OEM agreement with n8n.** This is a go/no-go business decision, not an engineering one — flag to whoever owns commercial terms before any product plan assumes monetized n8n execution. |

**Action item before any integration ships**: confirm platform's NOTICE/credits surface satisfies crawl4ai's attribution clause, and get an explicit legal/commercial sign-off on n8n if it's ever exposed as a customer-facing (vs. purely internal) feature.

## 5. Dependency conflicts

- **Database engine fragmentation**: mautic requires MariaDB/MySQL (cannot share Postgres); twenty requires its own Postgres cluster with schema-per-workspace (cannot share platform's schema); posthog requires ClickHouse+Kafka+Zookeeper+object storage in addition to Postgres+Redis; formbricks requires a mandatory SpiceDB instance in addition to Postgres+Redis. **None of these can live inside platform's existing Postgres instance except listmonk**, which is schema-compatible (Postgres) but still needs its own isolated database for tenant-safety reasons (no RLS/tenant concept of its own).
- **Node version skew**: twenty pins `^26.5.1` (bleeding-edge), formbricks pins `node >=26.0.0 <27`, n8n requires `>=24.0.0`, mastra requires `^22.19.0 || >=24.11.0` against platform's floating `node:22-alpine`. None of these matter if each service runs in its own container (the recommended pattern throughout this audit), but platform's own Dockerfiles should pin an explicit patch version rather than float `node:22-alpine`, since a stale cached base image could silently fail a Mastra install if that path is ever taken.
- **Package manager mismatch**: several candidates use pnpm/Yarn Berry (mastra: pnpm ≥11; twenty: Yarn 4.18.1; formbricks: pnpm) vs. whatever platform's own apps/api and apps/worker use — irrelevant for services run in their own containers, relevant only if any library (e.g. `@mastra/core`) is ever added as an in-process dependency.
- **Orchestration paradigm clash**: postiz-app (Temporal) and n8n/mastra (their own workflow engines) all have a different orchestration model from platform's BullMQ-based `agent_executions`. None should be allowed to become platform's orchestration layer — they should be called, not merged with, platform's job system.

## 6. Security risks

- **Multi-tenancy isolation mismatch is the single biggest architectural risk across this entire audit.** Platform's whole security model rests on Postgres RLS; none of the 13 repos implement RLS. Chatwoot and postiz-app use app-layer `account_id`/`Organization` scoping (weaker but real); twenty uses schema-per-workspace (strong but structurally different); listmonk, mautic, leadhub, and OpenOutreach have **no tenant concept at all** and would need one-instance-per-tenant if genuine isolation across DevLauch's own clients is required. This must be an explicit, documented decision per integrated service, not an assumption.
- **Public-facing attack surface**: chatwoot's widget API, postiz's OAuth-token handling for 30+ social networks, formbricks' public survey/link pages, and listmonk's bounce webhook endpoints are all deliberately internet-facing by design and need independent hardening/rate-limiting from platform's own perimeter.
- **Supply-chain risk**: leadhub (unpinned `theHarvester` install from GitHub HEAD) and OpenOutreach (two external PyPI packages re-pinned almost daily by one maintainer) are the two weakest links — both already recommended as skips, partly for this reason.
- **n8n's Code node** (arbitrary JS/Python execution, sandboxed via separate task-runner processes) is a meaningful RCE/sandbox-escape surface if n8n is ever exposed multi-tenant — another reason to keep it to internal use only until/unless a commercial agreement and a validated isolation story both exist.
- **Unverified items flagged by the audit agents** (should be checked before production use of each service): whether postiz-app encrypts OAuth tokens at rest at the field level (schema shows plain columns); whether SES/Postmark bounce-webhook paths in listmonk have signature verification equivalent to its SendGrid path; whether posthog's `ee/` licensing fully scopes which features are enterprise-gated.

## 7. Infrastructure requirements

Per adopted/conditional repo, if integrated as an independent service:

| Repo | New infra beyond its own container |
|---|---|
| chatwoot | Postgres (own instance) + Redis |
| listmonk | Postgres (own database — can share the same Postgres *server* as platform, not its schema/tables) |
| postiz-app | Postgres + Redis + full Temporal cluster (Temporal server + its own Postgres + Elasticsearch) |
| twenty (if adopted as external service) | Postgres cluster supporting schema-per-workspace + Redis |
| formbricks | Postgres + mandatory SpiceDB instance + Redis (+ optional Cube/Hub services) |
| posthog (not recommended to self-host) | Postgres + Redis + ClickHouse + Kafka/Zookeeper + S3-compatible object storage |
| n8n (internal use only) | Postgres (or SQLite for light internal use) |
| mautic (not recommended) | MariaDB + Redis + Apache/PHP-FPM + cron worker |

crawl4ai, mastra, and aaron-marketing-skills require no new infrastructure beyond what's already running or a scoped library dependency.

## 8. Implementation priorities

Ordered by value-to-cost ratio, consistent with the master prompt's instruction not to merge every repository in one pass:

1. **Operational hygiene on crawl4ai** (already shipped) — confirm attribution notice + version currency. Near-zero cost, closes a real licence-compliance gap.
2. **listmonk** — the single best-fit new integration: same DB family, lightest footprint, directly closes the "no email/campaign infrastructure" gap, ESP bounce webhooks already built.
3. **chatwoot** — closes "no live chat/chatbot" gap with a mature, MIT-core, widely-used product; clear independent-service integration path.
4. **postiz-app** — closes "no social publishing" gap; the only realistic way to get 30+ social-network integrations without building and maintaining them individually.
5. **aaron-marketing-skills** — essentially free (content-only, Apache-2.0, zero runtime dependency) to start loading into agent prompts whenever marketing-agent work resumes.
6. **twenty vs. native CRM** — a real product decision, not an engineering default; recommend scoping actual CRM requirements with the user before committing either way.
7. **formbricks** — lower priority than the above since it's additive (NPS/surveys) rather than closing a named gap; revisit after the above land.
8. **posthog (Cloud API, not self-hosted)** — worth adding once there's a concrete need for acquisition/revenue analytics beyond what `usage_events` can answer.
9. **n8n** — hold for internal/ops use only until a commercial licensing conversation happens; do not plan customer-facing features around it.
10. **mautic, OpenOutreach, leadhub** — do not integrate; revisit mautic only if/when branching marketing-automation workflows become a named requirement beyond what listmonk covers.

Per the master prompt's milestone structure, this document satisfies Milestone 1. Milestone 2 (integration foundation, service communication, shared tenant context) should start from item 2 (listmonk) as the lowest-risk, highest-value first real integration, with its own service-communication pattern (REST + webhook ingestion route in `apps/api`) designed to be reused by chatwoot and postiz-app afterward rather than inventing a new pattern per service.
