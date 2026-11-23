# Licence Compliance — Milestone 2 Integrations

Companion to `docs/OPEN_SOURCE_INTEGRATION_AUDIT.md`. Each integrated
service gets its own section below, appended by the agent that built it.
Do not edit another agent's section; add your own.

## Listmonk (Agent B)

- **Licence**: AGPLv3 — confirmed in the reference clone's root `LICENSE`
  file. Network-use copyleft: running stock/unmodified listmonk and
  calling its documented API does not trigger source-disclosure; any
  customization (custom bounce handling, multi-tenant patches,
  white-labeling of its own source) would.
- **What this integration actually did**: called listmonk's documented,
  versioned REST API (`POST /api/lists`, `POST /api/subscribers`,
  `POST /api/campaigns`, `PUT /api/campaigns/:id/status`, `GET /api/health`,
  and its `POST /webhooks/service/:service` convention referenced only as
  a naming precedent — see `apps/api/src/lib/listmonkClient.ts` and
  `apps/api/src/routes/listmonkWebhooks.ts`'s doc comments for the exact
  endpoints/auth-header format/line references consulted in
  `~/project/Growth/listmonk`'s `cmd/handlers.go` and
  `internal/auth/auth.go`) against a SEPARATELY RUN, UNMODIFIED instance
  (`docker-compose.listmonk.yml` pulls the official
  `listmonk/listmonk:v5.0.2` image verbatim, plus its own dedicated
  `postgres:17-alpine` — no Dockerfile, no patch, no vendored copy of
  listmonk's source anywhere in this repo).
- **No source code was copied, forked, vendored, or modified.** The
  read-only reference clone at `~/project/Growth/listmonk` was consulted
  ONLY to confirm: the real `/api/*` route table (`cmd/handlers.go`), the
  `token <api_user>:<api_key>` auth header format
  (`internal/auth/auth.go:parseAuthHeader`), and the real per-ESP bounce
  webhook dispatch/verification behavior (`cmd/bounce.go`'s
  `BounceWebhook` handler — which branch has real signature verification
  and which doesn't). Nothing from that clone is imported, copied, or
  built into this repo's published artifacts; `docker-compose.listmonk.yml`
  references the upstream published image by tag, not a local build of
  the cloned source.
- **Network-use (AGPLv3 §13) analysis**: because listmonk runs as its own
  unmodified, independently deployed binary/image (distributed via the
  official Docker Hub image, not rebuilt from this repo's clone of its
  source) and this platform only ever speaks to it over its public,
  documented HTTP API, no modified version of listmonk's own source is
  ever conveyed or made available to network users of listmonk through
  this platform — the AGPLv3 copyleft trigger (distributing/running a
  *modified* version and offering network access to it) does not apply.
  This conclusion rests entirely on the integration staying API-only; any
  future work that patches or forks listmonk's own Go source (e.g. to add
  native multi-tenancy instead of platform-side list tagging) would need
  separate legal review and would very likely trigger source-disclosure.
- **Residual risk / unresolved item carried from the audit**: the audit
  flagged "SES/Postmark bounce-webhook paths in listmonk have signature
  verification equivalent to its SendGrid path" as unconfirmed — this
  integration confirms (via `cmd/bounce.go`) that listmonk's OWN SendGrid
  branch does read a signature header while its Postmark branch does not,
  and documents (rather than silently assumes) that this platform's own
  parallel webhook endpoint (`listmonkWebhooks.ts`, which receives ESP
  bounce notifications independently of listmonk's own intake, in order to
  get bounce/complaint events into platform's own tenant-scoped
  suppression list) inherits the same per-ESP verification gap — see
  `docs/SECURITY_REVIEW.md`'s Listmonk section for the full breakdown and
  the concrete mitigations in place for the unverified SES path.

## Postiz (Agent D)

- **Licence**: AGPLv3. No commercial carve-out was found in the clone used
  for reference (`~/project/Growth/postiz-app`) — unlike Twenty's explicit
  "Application Exception", Postiz relies on the general "unmodified
  service, API-only" argument for safe network use.
- **What this integration actually did**: called Postiz's documented,
  versioned public REST API (`/public/v1`) from `apps/api/src/lib/postizClient.ts`
  against a SEPARATELY RUN, UNMODIFIED instance (see `docker-compose.postiz.yml`,
  which pulls the official `ghcr.io/gitroomhq/postiz-app` image verbatim —
  no Dockerfile, no patch, no vendored copy of its source in this repo).
- **No source code was copied, forked, vendored, or modified.** The
  read-only reference clone at `~/project/Growth/postiz-app` was consulted
  ONLY to confirm the real `/public/v1` route table, request/response DTOs,
  and the Postiz-side `State` enum for post status — see the doc comments
  at the top of `postizClient.ts` and `postizWebhooks.ts` for the exact
  file paths/line references consulted. Nothing from that clone is
  imported, copied, or built into this repo's published artifacts.
- **Network-use (AGPLv3 §13) analysis**: because Postiz runs as its own
  unmodified, independently deployed binary/image and this platform only
  ever speaks to it over its public, documented HTTP API, no modified
  version of Postiz's own source is ever conveyed or made available to
  network users of Postiz through this platform — the AGPLv3 copyleft
  trigger (distributing/running a *modified* version and offering network
  access to it) does not apply. This conclusion rests on the integration
  staying API-only; any future work that patches or forks Postiz's own
  source would need separate legal review.
- **Residual risk / unresolved item carried from the audit**: whether
  Postiz encrypts OAuth tokens for connected social accounts at rest on
  ITS OWN side was flagged by the audit as unconfirmed from schema alone,
  and remains unconfirmed by this integration (it only ever reads Postiz's
  API responses, never its database). This is Postiz's own operational
  concern, not something this platform's integration can verify or fix —
  noted here so it isn't silently assumed safe.

## Chatwoot (Agent C)

- **Licence**: core app is MIT — confirmed in the reference clone's root
  `LICENSE` file. No copyleft, no source-disclosure obligation. The
  `enterprise/` directory (Captain AI, some SSO features) is separately,
  commercially licensed (a paid subscription gate on specific features,
  not AGPL) and is **not depended on anywhere in this integration** — the
  entire point of building against the free `AgentBot` webhook model
  instead of Captain was to avoid that dependency (see
  `docs/SECURITY_REVIEW.md`'s Chatwoot section and
  `apps/api/src/routes/chatwootWebhooks.ts`'s doc comment).
- **What this integration actually did**: called Chatwoot's documented
  account-scoped REST API (`/api/v1/accounts/:account_id/...`) from
  `apps/api/src/lib/chatwootClient.ts` against a SEPARATELY RUN, UNMODIFIED
  instance (`docker-compose.chatwoot.yml` pulls the official
  `chatwoot/chatwoot:v4.20.1` image verbatim — no Dockerfile, no patch, no
  vendored copy of Chatwoot's source anywhere in this repo), and embeds
  Chatwoot's own OFFICIAL, documented widget bootstrap script
  (`{baseUrl}/packs/js/sdk.js` + `window.chatwootSDK.run(...)`) via
  `packages/embed-widget/chatwootWidget.js` — a thin loader, not a
  reimplementation of Chatwoot's widget UI.
- **No source code was copied, forked, vendored, or modified.** The
  read-only reference clone at `~/project/Growth/chatwoot` was consulted
  ONLY to confirm real endpoint shapes, the `api_access_token` auth header,
  the `AgentBot` model's `outgoing_url`/`secret` fields, and the exact
  HMAC-SHA256 webhook-signing scheme (`lib/webhooks/trigger.rb`) — see the
  doc comments at the top of `chatwootClient.ts` and `chatwootWebhooks.ts`
  for the exact file paths consulted. Nothing from that clone is imported,
  copied, or built into this repo's published artifacts.
- **MIT, not network-copyleft**: because Chatwoot's licence carries no
  AGPL-style network-use clause, there is no "modified version served over
  the network" analysis required the way there is for listmonk/postiz —
  MIT only requires retaining the licence/copyright notice, which this
  integration does not strip from anywhere (it never touches Chatwoot's
  own source or distributes any part of it).
- **Residual risk / unresolved item carried from the audit**: Chatwoot's
  own multi-tenancy is app-layer `account_id` scoping, not DB-level RLS —
  a real architectural difference from this platform's own model, flagged
  by the audit as "a materially weaker isolation guarantee if platform's
  compliance posture depends on RLS-grade enforcement." This integration
  does not change or improve Chatwoot's own internal isolation model (it
  cannot — that's Chatwoot's own codebase); it only ensures every
  PLATFORM-side table/route this agent built has real RLS/tenant-scoping
  regardless. Noted here, not silently assumed equivalent.
