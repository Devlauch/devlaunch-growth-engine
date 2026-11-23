# Security Review — Milestone 2 Integrations

Companion to `docs/OPEN_SOURCE_INTEGRATION_AUDIT.md`'s "Security risks"
section. Each integrated service gets its own section below, appended by
the agent that built it. Do not edit another agent's section; add your own.

## Listmonk (Agent B)

- **Credential storage**: a tenant's listmonk API key is never stored in
  plaintext. It goes through the generic, shared
  `POST .../integrations/listmonk/connect` route
  (`apps/api/src/routes/integrations.ts`, not edited by this change —
  built as common Milestone 2 infrastructure), which encrypts the single
  `secret` string via `apps/api/src/lib/credentialEncryption.ts`
  (AES-256-GCM) before it reaches `integrations.encrypted_credential_ref`.
  `apps/api/src/lib/listmonkClient.ts`'s `checkHealth(credential)` (the
  contract that generic route's health-check dynamically imports) makes
  one real call (`GET /api/health`) before the row is ever reported
  `'connected'` — an unreachable/unauthorized credential is reported
  `'error'`, never silently upgraded. Because the shared schema only
  supports one opaque `secret` string per integration, the API key and any
  optional webhook-verification material (SendGrid's public key,
  Postmark's Basic Auth pair) are folded into that one string as a JSON
  object (`parseListmonkCredential()` in `listmonkClient.ts` accepts
  either a bare API key string or that JSON form) — never a second,
  unencrypted column for the webhook material.
- **Tenant isolation**:
  - `listmonk_lists`, `listmonk_subscribers`, `listmonk_campaigns`
    (migration 291) all have RLS enabled AND forced (migration 292), the
    same `app.current_tenant_id` policy every other tenant-scoped table in
    this codebase uses.
  - `listmonk_lists.project_id` is `UNIQUE`, enforcing "one mapped listmonk
    list per platform project" at the DB level.
  - The public webhook route (`listmonkWebhooks.ts`) resolves a tenant
    from nothing but the URL's `:integrationId` (a random uuid, not a
    guessable sequential id) via a narrowly-scoped RLS lookup policy
    (migration 293, modeled directly on `019_public_project_lookup_rls.sql`'s
    existing `app.lookup_public_api_key` pattern) that reveals exactly one
    `integrations` row for `provider = 'listmonk'` and nothing else — it
    cannot be used to browse or enumerate other integrations.
  - Tenant-mapping model: ONE SHARED listmonk instance, platform tags
    lists per project (`platform-project:<project_id>`) rather than one
    listmonk instance per tenant — see
    `docs/INTEGRATION_STATUS.md`'s Agent B row for the full tradeoff
    writeup. This means listmonk's own single-tenant admin UI shows every
    platform tenant's lists side by side (distinguishable only by the tag/
    name platform assigns) — a real, accepted limitation of listmonk
    having no native multi-tenancy, mitigated by platform never trusting
    listmonk's own state as the source of tenant ownership (the mapping
    tables above are).
- **Inbound webhook signature verification — per-ESP, as flagged by the
  audit** (`docs/OPEN_SOURCE_INTEGRATION_AUDIT.md`: "SendGrid path is
  signature-verified in code, SES/Postmark paths should be checked"):
  - **SendGrid: REAL verification implemented.** ECDSA (P-256) over
    `${timestamp}${raw body}`, verified against a tenant-supplied base64
    DER public key using `req.rawBody` (the exact bytes, via `app.ts`'s
    `express.json({ verify })` capture — same mechanism Chatwoot's
    integration relies on). A missing key, missing header, or signature
    mismatch is rejected 401/503 — never silently accepted.
  - **Amazon SES: REAL cryptographic verification implemented (Milestone 3,
    Phase 1 real-world verification pass — see
    `docs/INTEGRATION_STATUS.md` section 11 for the full real-deploy
    writeup). This GAP IS NOW CLOSED**, not just documented. AWS's real
    scheme (verifying the SNS message's RSA signature against the real
    certificate at `SigningCertURL`) is implemented in
    `listmonkWebhooks.ts`: `SigningCertURL` is validated as a genuine
    `sns.<region>.amazonaws.com/SimpleNotificationService-*.pem` URL
    BEFORE it is ever fetched (a real SSRF guard — an attacker-supplied
    `SigningCertURL` pointing anywhere else is rejected without a network
    call), the real certificate is fetched (5s timeout, 1-hour cache) and
    parsed via `node:crypto`'s direct X.509-certificate support, and AWS's
    documented canonical "string to sign" is rebuilt and verified
    (`RSA-SHA256` for `SignatureVersion "2"`, `RSA-SHA1` for `"1"`) before
    any message — including `SubscriptionConfirmation`/
    `UnsubscribeConfirmation`, previously accepted with zero verification
    — is trusted. A missing/forged/mismatched signature is rejected 401.
    `SubscribeURL` is still deliberately never auto-fetched even once the
    signature verifies genuine — that remains a separate, intentional
    design decision (a human must still confirm the SNS subscription),
    not a remaining verification gap. Proven with real tests: a genuine
    RSA keypair + self-signed X.509 certificate generated via real
    `openssl` subprocess calls at test time, signing real SNS payloads —
    see `apps/api/test/listmonkWebhooks.test.ts`'s SES describe block (9
    tests: real-signature accept, SSRF-guard reject, wrong-keypair reject,
    tampered-body reject, cert-fetch-failure reject, dedup).
  - **Postmark: no cryptographic signature scheme exists for this path at
    all** (confirmed against the reference clone — unlike the SendGrid
    branch, listmonk's own Postmark bounce handler reads no signature
    header — AND re-confirmed directly against Postmark's own current,
    live documentation during the Milestone 3 pass above: "Postmark does
    not currently support HMAC webhook signature verification"; "The
    recommended approach to protect your webhook endpoint is HTTP Basic
    Authentication" — nothing better has shipped since the original
    audit). HTTP Basic Auth on the webhook URL is Postmark's own
    documented mitigation; this route REQUIRES it to be configured per
    integration and rejects with 503/401 rather than accepting an
    unverifiable request. This remains the best available verification
    for this specific path.
- **Approval gate (non-negotiable)**: `POST .../campaigns/:campaignId/send`
  (`listmonkIntegration.ts`) refuses to call listmonk's real
  `PUT /api/campaigns/:id/status {status:'running'}` endpoint — the
  **only** call that triggers a real send — unless the platform
  `campaigns` row already has `status = 'approved'`
  (`listmonkSync.ts`'s `triggerCampaignSend`, which re-checks this itself
  rather than trusting the caller). That status is set exclusively by the
  EXISTING, UNTOUCHED `POST .../approvals/:approvalId/decision` route
  (`apps/api/src/routes/approvals.ts`), which requires a real
  owner/admin/marketer decision. `POST .../campaigns` (draft creation)
  inserts a pending `approvals` row in the same transaction as the
  listmonk draft campaign — a mapping row is never created without a
  corresponding approval gate already in place. See
  `apps/api/test/listmonkSync.test.ts`'s `triggerCampaignSend` describe
  block for the automated proof.
- **Suppression/consent reuse, not a parallel mechanism**: subscriber sync
  (`syncProjectSubscribers`) calls the EXISTING `checkSendEligibility()`
  (`apps/api/src/lib/suppression.ts`) per lead and never syncs a
  suppressed/non-consenting lead to listmonk — see
  `apps/api/test/listmonkSync.test.ts`'s suppressed-lead test. Inbound
  bounce/complaint/unsubscribe events write directly into the EXISTING
  `suppression_list` table (same insert shape `compliance.ts`'s
  `suppressionRouter` uses), never a second suppression table.
- **Rate limiting**: the public webhook endpoint has both a per-IP and a
  per-integration fixed-window rate limit via the existing
  `rateLimitMiddleware` (the per-integration ceiling is set materially
  higher than the public lead-capture widget's, since a real ESP bounce
  storm can legitimately deliver many events at once).
- **Never fabricated**: `NotConfiguredListmonkClient` (used whenever no
  usable credential resolves) throws on every method — it never returns a
  fabricated subscriber count, campaign id, or delivery status.
  `RealListmonkClient` only ever returns data copied verbatim from a real
  listmonk API response; a non-2xx (and non-409-duplicate) response always
  throws `ListmonkApiError` rather than being swallowed into a fake
  success.

## Postiz (Agent D)

- **Credential storage**: a tenant's Postiz Organization API key is never
  stored in plaintext. `POST .../integrations/postiz/connect`
  (`apps/api/src/routes/postizIntegration.ts`) encrypts it via
  `apps/api/src/lib/credentialEncryption.ts` (AES-256-GCM, real envelope
  encryption, not obfuscation) before it ever reaches
  `integrations.encrypted_credential_ref`. The key is verified against a
  real `GET /public/v1/me` call BEFORE being stored, so a stored row always
  reflects a confirmed-live credential, never an unvalidated guess.
- **Tenant isolation**:
  - `postiz_organization_links` (migration 317) and `postiz_social_posts`
    (migration 318) both have RLS enabled + FORCED (migration 320), the
    same `app.current_tenant_id` policy every other tenant-scoped table in
    this codebase uses.
  - `postiz_organization_links.tenant_id` is `UNIQUE`, hard-enforcing the
    audit's "one Postiz Organization per tenant" recommendation at the DB
    level — a bug upstream of this constraint cannot silently bind two
    tenants' projects to the same Postiz Organization.
  - Every route handler scopes its queries by both `tenant_id` AND
    `project_id` from the authenticated session's `req.tenantDb` (already
    inside a transaction with `app.current_tenant_id` set by
    `requireTenantMembership`), never trusting a client-supplied id alone.
- **Approval gate (non-negotiable)**: `POST .../posts/:postId/publish`
  refuses to call Postiz's real publish endpoint unless a REAL
  `approvals` row linked via `postiz_social_posts.approval_id` /
  `approvals.social_post_id` (migration 319) has `status = 'approved'`.
  This is never auto-set by this integration — only the existing, UNTOUCHED
  `POST .../approvals/:approvalId/decision` route
  (`apps/api/src/routes/approvals.ts`) can set it, requiring a real
  owner/admin/marketer-role human decision (`requireRole(...GTM_ROLES)`).
  See `apps/api/test/postizIntegration.test.ts`'s "the non-negotiable
  approval gate" test group for the automated proof of this (no approval /
  pending approval / rejected approval are all refused with 403; an
  already-published post is never re-published).
- **Inbound webhook — DOCUMENTED, UNRESOLVED GAP**: Postiz's public API
  documents NO signature/HMAC verification scheme for its outbound webhook
  deliveries (confirmed against the reference clone's
  `apps/backend/src/api/routes/webhooks.controller.ts` — a bare
  unsigned POST). `apps/api/src/routes/postizWebhooks.ts` is explicitly
  marked best-effort/advisory-only as a result: it requires a shared
  secret this PLATFORM controls (not a Postiz-verified signature), and its
  doc comment states plainly that a party who learned the webhook URL
  could still forge a payload. The AUTHORITATIVE status/analytics source is
  the polling sync path (`POST .../posts/:postId/sync`, a real
  `GET /public/v1/analytics/post/:id` call) — the webhook can only ever
  prompt an earlier poll, never substitute for one. This mirrors the same
  "call out unverifiable webhooks explicitly rather than silently
  accepting them" rule `listmonkWebhooks.ts` follows for SES.
- **Rate limiting**: the public webhook endpoint has a per-tenant/project
  fixed-window rate limit (120/min) via the existing
  `rateLimitMiddleware` — same mechanism as `publicChatbot.ts`/`publicLeads.ts`.
- **Never fabricated**: no code path in this integration ever reports a
  "published" status, a post id, or an engagement metric that wasn't
  copied verbatim from a real, successful Postiz API response — see
  `channelProviders.ts`'s `PostizSocialPostProvider.publish()` (throws
  rather than inventing a postId when Postiz's response shape doesn't
  contain one) and `postizIntegration.ts`'s sync endpoint (a failed sync
  call reports the real error and leaves the row's last-known state
  untouched, never advances status optimistically).

## Chatwoot (Agent C)

- **Credential storage**: a tenant's Chatwoot `api_access_token` is never
  stored in plaintext. It flows through the SAME generic, shared
  `POST .../integrations/chatwoot/connect` (`apps/api/src/routes/integrations.ts`,
  built as common Milestone 2 infrastructure, not owned by this agent) which
  encrypts any supplied `secret` via `apps/api/src/lib/credentialEncryption.ts`
  (AES-256-GCM) before it reaches `integrations.encrypted_credential_ref`.
  `apps/api/src/lib/chatwootClient.ts`'s `checkHealth(credential)` (the
  contract that generic route's health-check dynamically imports) makes one
  real authenticated call (`GET /contacts?per_page=1`) before the row is
  ever marked `'connected'` — an unreachable/unauthorized credential is
  reported `'error'`, never silently upgraded.
- **Tenant isolation**:
  - `chatwoot_contact_leads` (migrations 295/296) — the Chatwoot-contact ->
    platform-lead idempotency mapping this agent owns — has RLS enabled
    AND forced, the same `app.current_tenant_id` policy every other
    tenant-scoped table in this codebase uses.
  - Both `apps/api/src/routes/chatwootIntegration.ts`'s authenticated
    routes and `apps/api/src/routes/chatwootWebhooks.ts`'s public webhook
    scope every query by `tenant_id` (the former via `req.tenantDb`'s
    already-tenant-scoped transaction + an explicit `project_id` ownership
    check; the latter by `SELECT set_config('app.current_tenant_id', ...)`
    from the URL's `:tenantId`, then looking up the `chatwoot` integration
    row for that exact `(tenant_id, project_id)` before trusting anything
    in the payload).
  - Chatwoot's OWN isolation model is app-layer `account_id` scoping, not
    DB-level RLS (confirmed in the reference clone and flagged by the
    audit as a materially weaker guarantee than this platform's own) — this
    integration never relies on Chatwoot's isolation for platform-side
    tenant separation; every platform-side table this agent touches has
    real RLS regardless of what Chatwoot does internally.
- **Inbound webhook — signature verification IS implemented (not a
  documented gap)**: Chatwoot's AgentBot/webhook deliveries are
  HMAC-SHA256 signed when a `secret` is configured on the Chatwoot side —
  confirmed directly against `lib/webhooks/trigger.rb#request_headers` in
  the reference clone (`~/project/Growth/chatwoot`, read-only):
  `X-Chatwoot-Timestamp` (unix seconds) +
  `X-Chatwoot-Signature: sha256=HMAC-SHA256(secret, "<ts>.<raw body>")`.
  `apps/api/src/routes/chatwootWebhooks.ts`'s `verifySignature()`
  recomputes this HMAC (using the real captured `req.rawBody` — see
  `apps/api/src/app.ts`'s `express.json({ verify })` and
  `apps/api/src/types/express.d.ts`, added specifically so this check is
  byte-exact against what Chatwoot actually signed, not a re-serialization
  of the parsed body) over a bounded 5-minute replay window, using
  `timingSafeEqual`, against a single GLOBAL `CHATWOOT_WEBHOOK_SECRET` env
  var (not per-tenant — same convention `LISTMONK_WEBHOOK_SECRET` already
  uses in this codebase). With that env var unset, every request is
  rejected 503 rather than silently accepted unauthenticated.
- **AgentBot vs. plain account webhook — why AgentBot**: both deliver
  the same event payload shapes and the same signature scheme (confirmed
  in `lib/webhooks/trigger.rb` — signing is shared, keyed only on
  `webhook_type`), but only the `AgentBot` model (`app/models/agent_bot.rb`:
  `outgoing_url` + `secret`, `include WebhookSecretable`) also lets this
  platform reply into the conversation via Chatwoot's normal REST API
  (`ChatwootClient#sendMessage`) under its own distinct sender identity —
  the free path to "platform's own bot logic answers inside Chatwoot" the
  audit called out, with no paid Captain subscription required.
- **Identity verification — explicitly anonymous-only this phase**: this
  integration does NOT implement Chatwoot's `identifier`/HMAC
  identity-verification feature (which lets a widget assert a specific,
  already-known contact's identity without allowing impersonation).
  `packages/embed-widget/chatwootWidget.js`'s own doc comment states this
  explicitly: the surface it's embedded on is anonymous marketing-site
  visitor chat, with no authenticated end-user session to assert an
  identity for. If a future surface embeds this widget somewhere a visitor
  IS already signed in, identifier verification must be added before
  relying on Chatwoot's contact identity there.
- **Rate limiting**: the public webhook endpoint is protected by signature
  verification (a request without a valid, fresh HMAC never reaches any
  DB query), which is the real security boundary here, matching
  `listmonkWebhooks.ts`'s established pattern for this codebase's
  provider-webhook routes. A per-IP/per-tenant fixed-window rate limit
  (`rateLimitMiddleware`, same mechanism `publicLeads.ts`/`publicChatbot.ts`
  use) was evaluated but intentionally NOT added on top of signature
  verification for this route, since a signed request already requires
  knowledge of a server-side secret never exposed to a browser — flagged
  here rather than silently decided, in case a future review wants
  defense-in-depth against a compromised/leaked `CHATWOOT_WEBHOOK_SECRET`.
- **Never fabricated**: a lead is only ever created from a real Chatwoot
  `contact`/`sender` object that actually carries a name or email in the
  webhook payload (`extractContact()` returns `null` otherwise, and the
  route skips sync entirely) — never a placeholder/guessed identity. An
  outgoing (agent/bot-authored) `message_created` event is explicitly
  excluded from contact extraction so platform's own bot/agent replies can
  never be mistaken for a new visitor lead. `chatwootSync.ts`'s reverse
  direction (lead -> Chatwoot contact) is a best-effort side effect that
  logs and swallows a failed Chatwoot call rather than blocking or
  fabricating a successful sync.

## Credential storage audit (cross-cutting, Milestone 3 Phase 1)

Cross-cutting pass across all three integrations (listmonk/chatwoot/postiz),
scoped to exactly the question this section's title asks: is any REAL (not
example/placeholder) API key, token, or secret logged, committed to a
migration file in plaintext, or written into a doc outside of
`credentialEncryption.ts`'s encrypted storage path. No source changes were
required — every check below came back clean.

- **Client libraries** (`apps/api/src/lib/postizClient.ts`,
  `listmonkClient.ts`, `chatwootClient.ts`): none of the three files import
  or call `logger`/`console` at all. Every reference to an API key/token/
  credential variable is either a plain in-memory assignment, a doc comment,
  or a value passed directly into a `fetch` request header/constructor —
  never logged. **None found.**
- **Route files** (`postizIntegration.ts`, `listmonkIntegration.ts`,
  `chatwootIntegration.ts`, the shared `integrations.ts`, and all three
  public webhook routes — `postizWebhooks.ts`, `listmonkWebhooks.ts`,
  `chatwootWebhooks.ts`): every `logger.warn`/`logger.error` call site near a
  credential/secret/signature check logs only a static message, a provider
  name, an integration id, or a caught error object — never the secret,
  token, or signature value itself. Spot-checked specifically:
  `integrations.ts`'s health-check failure log (provider + error, no
  credential), and each webhook route's "rejected: missing/invalid
  signature/secret" warnings (all static strings, no value interpolated).
  **None found.**
- **`packages/db/migrations/*.sql`**: every migration that touches a secret
  column (`integrations.encrypted_credential_ref`, introduced in
  `024_create_integrations.sql` and referenced in later additive migrations)
  only ever defines the column — no migration contains an `INSERT` with a
  literal secret/token/credential/password/api_key value. The only literal
  string inserts found anywhere in `packages/db/migrations` are placeholder
  dev-seed data (e.g. `014_seed_dev_tenant.sql`'s fixed dev UUIDs), not
  credentials. **None found.**
- **Committed `.env` files**: a real, non-placeholder `.env` (plus
  `.env.chatwoot`/`.env.listmonk`/`.env.postiz`) exists on the local
  filesystem of the environment this audit ran in, containing genuinely
  generated secret material (an `INTEGRATION_CREDENTIALS_KEY` generated via
  `openssl rand -base64 32`, a `CHATWOOT_WEBHOOK_SECRET` generated via
  `openssl rand -hex 32`, and real `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`
  values) — these are real secrets, not the `devlaunch`/`dev-insecure-...`
  style placeholders used elsewhere. Verified via `git ls-files` and
  `git check-ignore -v .env` that none of `.env`/`.env.chatwoot`/
  `.env.listmonk`/`.env.postiz` are tracked by git — only the `.example`
  variants (`.env.example`, `apps/dashboard/.env.example`,
  `packages/db/.env.example`, and the three `.env.<provider>.example`
  template files) are committed. Per this section's own "committed to a
  migration file / doc" scope, this is **none found** (nothing committed) —
  flagged here only as standard local-secret hygiene: real secret material
  sitting on a local disk should still be rotated before any shared/CI use,
  independent of the git-tracking question this audit was scoped to.
- **`docs/*.md`**: grepped every doc for real-API-key-shaped strings
  (`sk_live_...`, `AKIA...`, long 32+/40+ char hex/base64 runs). The only
  matches were a SHA-256 content-integrity hash of a test artifact in
  `docs/CRAWL4AI_VERIFICATION.md` (not a secret) and ordinary file-path
  text; every other long string already matches the known-fine
  `sk_live_abc123`-style placeholder pattern. **None found.**

**Net result**: no plaintext-secret-logging bug exists in any of the three
integrations' client/route files, no migration stores a literal secret
value, and no doc leaks a real credential. The repo's one real
secret-hygiene item (real generated secrets in a correctly-gitignored local
`.env`) is an operational note, not a committed-code or logging bug.

---

## RLS bypass — critical finding, FIXED (Milestone 3, Phase 1)

**Severity: critical, platform-wide. Status: FIXED and verified against the real running database.**

### The finding

Every migration since `013_enable_rls_policies.sql` carries a comment
claiming `FORCE ROW LEVEL SECURITY` makes tenant isolation safe "even
against the table owner." That claim was never actually true for this
deployment: the application (`apps/api` and `apps/worker`) has always
connected to Postgres as `devlaunch` — the Docker Postgres image's
bootstrap user, which is a real superuser (`rolsuper=true`) with
`rolbypassrls=true`. **Postgres unconditionally bypasses Row-Level
Security for superusers**, regardless of `FORCE ROW LEVEL SECURITY` (FORCE
only changes behavior for a non-superuser table *owner*; superuser status
alone already defeats RLS before ownership is even considered).

Practical consequence: tenant isolation has depended entirely on every
route handler manually scoping queries by `tenant_id` — there has never
been a database-level backstop. Every pre-existing "RLS test" in this
codebase uses a mocked `pg` client, so none of them could ever have caught
this; it only surfaced because Milestone 3 Phase 1 wrote real tests against
the actual running container.

**Independently confirmed four times** during Phase 1 real-world testing:
by the Listmonk agent, the Chatwoot agent, the Postiz agent's delegated
cross-cutting test, and the orchestrator's own direct query:

```
    rolname  | rolsuper | rolbypassrls 
-----------+----------+--------------
 devlaunch | t        | t
```

The Chatwoot agent additionally proved the RLS *policies themselves* are
written correctly by creating a temporary non-superuser role, confirming
real tenant-scoped isolation under it, then dropping it — meaning this was
purely a connection-role problem, not a defective policy.

### The fix

1. **`packages/db/migrations/321_create_app_role.sql`** — creates a
   dedicated, non-superuser, non-bypassrls login role, `devlaunch_app`,
   with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, granted
   `SELECT, INSERT, UPDATE, DELETE` on every existing table/sequence plus
   `ALTER DEFAULT PRIVILEGES` so every future migration's tables are
   automatically covered without a repeat grant. `devlaunch` remains the
   migration-running/table-owning role (a real superuser is genuinely
   needed to run arbitrary DDL) — only the **application's own runtime
   connection** changes.
2. **`docker-compose.yml`** — the `api` and `worker` services' `DATABASE_URL`
   now points at `${APP_DB_USER:-devlaunch_app}` instead of
   `${POSTGRES_USER:-devlaunch}`, with a full explanatory comment at each
   site.
3. **`apps/api/src/db/pool.ts` / `apps/worker/src/db.ts`** — a new
   `assertDatabaseRoleRespectsRls()` check, run once at process startup,
   that queries `pg_roles` for the *actual connected role* (not
   configuration, which could drift from reality) and refuses to start
   silently if it's ever a superuser/bypassrls role again: a loud error log
   in development, a hard process exit in `NODE_ENV=production`. This
   makes the regression impossible to reintroduce unnoticed.

### Verification (real, against the actual running container)

```
# Before the fix:
devlaunch | rolsuper=t | rolbypassrls=t

# After migration 321:
devlaunch_app | rolsuper=f | rolbypassrls=f

# Real two-tenant proof, connected AS devlaunch_app:
SET app.current_tenant_id = '<tenant A>';  → sees tenant A's 1 lead
SET app.current_tenant_id = '<tenant B>';  → sees 0 of tenant A's leads
```

`docker compose build api worker && docker compose up -d api worker` —
both came up healthy, `pg_stat_activity` confirms both now connect as
`devlaunch_app`, no RLS warning logged at boot (the check passed), and the
full API+worker test suites remain green (804/808, 4 pre-existing skips;
101/101) with zero regressions.

### One more real bug found and fixed while restarting the worker

Restarting the worker container for this fix surfaced a second,
independent, pre-existing bug: `apps/worker/src/jobs/sequenceSchedulerCron.ts`
dynamically imports `apps/api/dist/lib/advanceSequences.js` across a
filesystem path that only exists in local dev (both apps' `dist/`
directories on the same disk) — the worker's own Docker image never built
or copied `apps/api` at all, so the cron failed `ERR_MODULE_NOT_FOUND` on
every tick in any real container deployment. This had never been caught
because the worker container hadn't been rebuilt/restarted since that
feature was added. Fixed in `apps/worker/Dockerfile` by building
`@devlaunch/api` in the same build stage and copying its `dist/` and
`package.json` into the worker's runtime image. Confirmed fixed: the error
no longer appears in the worker's logs after rebuild.

## Milestone 3 Phase 2 Selective Reconciliation (2026-11-23)

Reviewed for the two security-relevant requirements this reconciliation was
explicitly bound by:

- **Single credential architecture.** Apollo/Google credential resolution
  (`providerCredentials.ts`) is a thin wrapper over the existing
  `credentialEncryption.ts`/`integrationCredentials.ts` path — no raw API key is
  passed through a public API contract or persisted outside that approved path.
  No second/duplicate credential system was introduced anywhere in this round.
- **Tenant isolation.** New routes (lead-assignment CRUD, general CRM-tasks CRUD,
  qualification-settings CRUD) were each independently tested for cross-tenant
  access denial. Lead-assignment/CRM-tasks tests go further than the existing
  convention of asserting a 403: they also assert the underlying SQL's bind
  parameters are exactly the requesting tenant/project's ids and never contain
  another tenant's id — i.e. isolation is verified structurally, not just as an
  incidental side effect of test setup.

No new finding. No change to RLS policies, the credential-encryption mechanism
itself, or any existing tenant-isolation gate. Full detail of what was reviewed
is in `docs/PHASE_2_SELECTIVE_RECONCILIATION_REPORT.md`.
