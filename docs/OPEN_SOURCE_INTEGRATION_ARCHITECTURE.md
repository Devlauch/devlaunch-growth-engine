# Open-Source Integration Architecture

A concise statement of the layering principle already in use throughout this round's
integrations (listmonk, chatwoot, postiz-app in the prior Milestone 2 round; formbricks,
PostHog Cloud API, and others in the current round), so every one of the 11 concurrent
feature agents builds against the same shape rather than inventing a new pattern per service.
This document does not introduce a new architecture — it writes down the one the codebase
already demonstrates (see `docs/LICENCE_COMPLIANCE.md` and `docs/OPEN_SOURCE_INTEGRATION_AUDIT.md`
for the concrete precedents this generalizes from) and makes its hard rules explicit so they
are enforced consistently, not just followed by accident.

## The layering principle

```
DevLaunch Dashboard (apps/dashboard)
        |
        v
DevLaunch API (apps/api) — tenant-scoped, RLS-enforced, the only thing the dashboard ever talks to
        |
        v
Native business logic (apps/api/src/lib/*, apps/worker)
        |
        v
Integration adapters (apps/api/src/lib/<service>Client.ts, apps/api/src/routes/<service>Webhooks.ts)
        |
        v
Independent external services (listmonk, chatwoot, postiz-app, formbricks, PostHog Cloud, ...)
```

Each layer only talks to the layer directly below it:

- **The dashboard never calls an external service directly.** It calls DevLaunch's own API,
  which is the only component that holds integration credentials, decides tenant scoping, and
  enforces approval gates (e.g. the existing `approvals` table gating sends/publishes).
- **Native business logic owns the decision of *whether* to call an external service** (e.g.
  "is this lead qualified enough to sync to the CRM," "has this send been approved"). It never
  embeds an external service's own execution engine in-process.
- **Integration adapters are thin.** Each one (`listmonkClient.ts`, `chatwootClient.ts`,
  `postizClient.ts`, and whatever the current round's formbricks/PostHog adapters end up being
  named) does exactly three things: translate DevLaunch's internal call into the external
  service's documented REST/GraphQL/webhook contract, translate the external response back into
  DevLaunch's own shapes, and hold nothing persistent of its own (no credential storage outside
  the existing per-tenant AES-256-GCM-encrypted `integration_credentials` mechanism, no business
  logic, no caching layer that could drift from the source of truth).
- **External services are opaque, independently-deployed, and never modified.** DevLaunch
  consumes their public API/webhook surface exactly as documented and runs their official,
  unmodified container image (see each service's own `docker-compose.<service>.yml`, which pulls
  a tagged upstream image — never a Dockerfile that rebuilds from a local clone of the service's
  source).

## Three hard rules for every new integration (all 11 concurrent agents)

### 1. No new agent may embed n8n's execution engine or Twenty's CRM as a competing service

Neither n8n's workflow engine nor Twenty's CRM runtime may be forked, vendored, or re-hosted
inside DevLaunch's own API/worker process, and neither may be stood up as a second, parallel
"orchestration layer" or "CRM layer" competing with DevLaunch's existing `agent_executions`
system or its own native CRM (companies/contacts/notes/deals/meetings). This is not solely a
licensing rule (n8n's Sustainable Use License and Twenty's AGPLv3 both separately permit
API-only external-application use — see `OPEN_SOURCE_LICENSE_AUDIT.md`) — it is an
architectural rule independent of licensing: DevLaunch already has a working, RLS-scoped
orchestration system (`agent_executions`) and a working, RLS-scoped CRM, and introducing a
second system with a different multi-tenancy model (n8n's Enterprise-gated "Project" RBAC;
Twenty's schema-per-workspace Postgres) fragments tenant isolation and operational ownership
for no capability gain. If n8n or Twenty is ever used at all, it is used exactly as
`OPEN_SOURCE_INTEGRATION_MATRIX.md` describes: n8n for DevLaunch's own internal ops glue
workflows only (never customer-facing, pending a commercial agreement), and Twenty only as the
already-completed reference data model for the native CRM that was built *instead* of
deploying it.

### 2. External services must communicate via supported APIs/webhooks only

No new integration may fork, patch, or vendor an external service's own source code, and no
integration may reach into an external service's database directly (even if it happens to run
on Postgres, as listmonk does) — only its documented REST/GraphQL endpoints and its documented
outbound webhook contract are a supported integration surface. This is the same "arms-length
service" pattern already load-bearing for listmonk/chatwoot/postiz-app's AGPL-safety argument
(see `LICENCE_COMPLIANCE.md`): the moment DevLaunch modifies an AGPL-covered service's own
source and serves that modified version over the network, the copyleft trigger applies. Staying
API-only is simultaneously the correct architecture and the thing that keeps every AGPL/GPL
repo in this set license-safe without needing a case-by-case legal review per integration.

### 3. Tenant isolation must be preserved, and credentials must never reach the browser

- **Tenant isolation**: none of the 13 reference repos implement DevLaunch's own
  RLS-based tenant model (confirmed independently by this audit and the prior Milestone 1
  audit — they use app-layer scoping, schema-per-workspace, or no tenant concept at all). Every
  new integration must therefore make an explicit, documented choice about how tenant isolation
  is achieved at the integration boundary: either (a) one external-service tenant/workspace
  per DevLaunch tenant (the pattern already used — one listmonk list-namespace, one Chatwoot
  `Account`, one Postiz `Organization` per DevLaunch tenant), or (b) one fully separate
  external-service instance per DevLaunch tenant, for services with no tenant concept
  whatsoever. "We'll figure out isolation later" is not an acceptable default — the integration
  adapter layer is exactly where this decision must be enforced, since DevLaunch's own RLS stops
  at its own database boundary and cannot reach into an external service's data model.
- **Credentials never reach the browser**: every external-service API key, OAuth token, or
  webhook secret is stored exclusively in DevLaunch's API-side, per-tenant, AES-256-GCM-encrypted
  `integration_credentials` mechanism (the same one Listmonk/Chatwoot/Postiz/Hunter already use,
  per `FEATURE_STATUS.md`'s own description of that mechanism) and is used exclusively
  server-side, inside `apps/api`/`apps/worker`. The dashboard never receives a raw credential in
  any API response, never constructs a direct browser-to-external-service request, and never
  embeds a credential in client-side JavaScript. Where an external service ships an official
  embeddable widget (e.g. Chatwoot's `sdk.js` bootstrap script), only the service's own public,
  unauthenticated widget-bootstrap mechanism is embedded — never a privileged API key.

## Why this layering survives the current round's licensing mix

This layering is what makes the "safe for direct API integration" column in
`OPEN_SOURCE_LICENSE_AUDIT.md` true in practice, not just in theory. AGPLv3's network-use
copyleft (listmonk, postiz-app, formbricks backend, twenty) is triggered by distributing or
running a *modified* version of the covered software and offering network access to it — never
triggered by an unmodified instance's own documented API being called from an external
Application. n8n's Sustainable Use License separately restricts resale/monetization regardless
of modification — a business constraint this architecture does not resolve on its own (see
License Audit), but does correctly *scope*: treating n8n as an opaque external service reachable
only by webhook/API key, exactly like every other integration in this document, is what keeps
"internal-only use" actually internal-only rather than accidentally customer-facing through a
dashboard feature that forgot the layering.
