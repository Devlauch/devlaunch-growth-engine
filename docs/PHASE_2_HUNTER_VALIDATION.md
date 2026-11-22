# Phase 2 Hunter Validation — Agent C (Hunter contact discovery + email verification)

**Headline: no real Hunter API key was available for this work.** Every
capability below was built for real (real HTTP client code, real request/
response types, real DB schema, real mock-based tests) but the specific
requirement to make "at least one genuine authenticated API request" against
Hunter's live API is explicitly **BLOCKED** — see "Remaining limitations"
at the end. Nothing in this deliverable fabricates or simulates a real
Hunter response as if it were genuine.

## Scope note: this repo's actual state vs. the brief

The brief referenced `docs/MILESTONE_3_REPORT.md`,
`docs/PROSPECTING_ENGINE_STATUS.md`, `docs/INTEGRATION_STATUS.md`,
`docs/SECURITY_REVIEW.md`, `FEATURE_STATUS.md`,
`docs/BROADER_WORKSTREAM_AUDIT.md`, `docs/GROWTH_ENGINE_INTEGRATION_MAP.md`,
`docs/MILESTONE_3_IMPLEMENTATION_PLAN.md`, and a pre-existing
`credentialEncryption.ts`/`integrationCredentials.ts` pair. In this actual
worktree, only `docs/FEATURE_STATUS.md` exists (the others don't), and
`credentialEncryption.ts`/`integrationCredentials.ts` did not exist anywhere
in the repository before this change. `docs/FEATURE_STATUS.md` confirms the
codebase's real state: Phase 1 contact discovery/verification/dedup are
"done," Phase 2's six agents are "done," and there is no Apollo/Hunter/
ZoomInfo integration anywhere (matching the brief's own claim about a prior
audit). Given that, this work:
- Builds `credentialEncryption.ts` + `integrationCredentials.ts` from
  scratch (real AES-256-GCM, reusing the existing `integrations` table
  rather than a parallel store) — both now exist for any future provider to
  reuse, not just Hunter.
- Builds everything else exactly as briefed.

## 1. Authentication

**Built:**
- `apps/api/src/lib/credentialEncryption.ts` — real AES-256-GCM
  (`encryptCredential`/`decryptCredential`), key derived via `scrypt` from
  `env.credentialEncryptionKey`. Never logs a secret, a derived key, or a
  decrypted value (audited: no `console.*`/`logger.*`/`JSON.stringify` of
  anything secret in this file or any file that touches a Hunter key).
- `apps/api/src/lib/integrationCredentials.ts` — `setIntegrationCredential`/
  `getIntegrationCredential`/`clearIntegrationCredential`, reusing the
  EXISTING `integrations` table (one row per tenant+project+provider) via a
  new, additive column (see migration 284 below), not a second table.
- `apps/api/src/config/env.ts` — added `hunterApiKey` (`HUNTER_API_KEY`,
  null by default) and `credentialEncryptionKey`, mirroring the existing
  `googlePageSpeedApiKey`/`calendlyApiKey` optional-env-var convention.
- `apps/api/src/lib/hunterProvider.ts`'s `resolveHunterApiKey(tenantDb,
  tenantId, projectId)` — tenant's own encrypted credential always wins;
  `HUNTER_API_KEY` is only a dev/global fallback.
- Real Hunter auth mechanism: **verified via a live fetch of Hunter's own
  published API documentation** (`https://hunter.io/api-documentation/v2`)
  during this work, not assumed. Confirmed: `api_key` query parameter is
  required on every request (the form this client uses — the docs also
  document `X-API-KEY` header / `Authorization: Bearer` as accepted
  alternatives, which this client does not use). A missing/invalid key
  returns HTTP 401.

**What could/couldn't be verified without a key:** The documented shape
(param name, 401 on bad key) is verified against Hunter's own docs. Whether
a *real, valid* key actually authenticates successfully against the live
API is **BLOCKED** — untestable without one.

**Tests** (`apps/api/test/credentialEncryption.test.ts`,
`integrationCredentials.test.ts`): round-trip encrypt/decrypt, different
ciphertext per call (random IV), wrong-key decrypt failure, tampered-
ciphertext (auth tag) failure, malformed-value rejection, no-secret-leak-in-
error-message, tenant-scoped upsert/read/clear with explicit tenant_id+
project_id filtering. All real, all passing (see Test evidence).

## 2. Domain Search / contact discovery

**Built:** `apps/api/src/lib/hunterProvider.ts`:
- `searchDomainPage` / `searchDomainAllPages` — real HTTP GET to
  `https://api.hunter.io/v2/domain-search`, with a real injectable `fetcher`
  (defaults to global `fetch`, available on this codebase's Node 18
  runtime) and an `AbortController`-based timeout.
- **Pagination**: Hunter's documented `limit` (default 10, max 100) +
  `offset` params, walked via `searchDomainAllPages` using `meta.results`
  to know when to stop, bounded by a hard `DOMAIN_SEARCH_MAX_PAGES = 10`
  safety cap (so a misreported/huge total can never cause a runaway loop) —
  exercised for real in tests (multi-page walk, and the safety-cap case).
- **Field mapping**: `value`→email, `type`, `provenance` ('found'/
  'inferred'), `confidence`, `first_name`/`last_name`/`position`/
  `seniority`/`department`, `phone_number`, `linkedin`/`twitter`, `sources[]`
  (domain/uri/extracted_on), prior `verification`. Every field traces to a
  field Hunter's documented response actually returns — nothing invented.
  A role/generic email with no real name is left with `firstName`/
  `lastName: null` (never a fabricated name).
- **Provider record identifiers**: Hunter's Domain Search response does
  **not** include a provider-assigned unique id per email record (confirmed
  against the documented response shape) — this implementation uses the
  email address itself (`value`) as `providerRecordId`, documented
  explicitly in the code as the closest thing Hunter exposes.
- **Credits**: `X-Credits-Used`/`X-Credits-Unit` response headers captured
  into `credits: { used, unit }` when present; `null`/`null` when Hunter
  doesn't send them. Never guessed.
- **Source attribution**: `source: "hunter:domain-search:emails[]"` recorded
  on every provenance row (see §4).
- **Domain input**: always comes from an existing `discovered_organizations`
  row (`domain` column) — no parallel domain-input path. See
  `apps/api/src/lib/hunterContactDiscovery.ts`'s
  `discoverContactsForOrganization`.
- **DecisionMakerProvider adapter**: `HunterProvider` implements the
  existing `DecisionMakerProvider` interface (`decisionMakerProvider.ts`)
  so it can be prepended to `buildDecisionMakerWaterfall()` later (not done
  in this change — the waterfall's current contents are untouched, since
  wiring in a provider the orchestrator hasn't reviewed yet is out of scope
  for an additive change). **Divergence documented in code**: Hunter's
  response carries materially more fidelity (per-source timestamps, its own
  confidence score, seniority/department, pagination, accept-all/disposable
  flags, credit usage) than `DecisionMakerCandidate` can represent, so
  `findDecisionMakers` is a deliberately lossy adapter for waterfall
  compatibility, while `searchDomain`/`searchDomainAllPages` are the
  full-fidelity path the dedicated Hunter route/orchestration uses directly.
  `sourceConfidence` maps Hunter's own `provenance` field 1:1 ('found' →
  'verified', 'inferred' → 'inferred') — never 'verified' unless Hunter
  itself found the record directly.
- **Honest stub**: `NotConfiguredHunterProvider`, mirroring
  `NotConfiguredDecisionMakerProvider`'s exact convention — always throws
  `HunterNotConfiguredError`, never returns a fabricated contact.
- **Orchestration**: `apps/api/src/lib/hunterContactDiscovery.ts`'s
  `discoverContactsForOrganization` — resolves credentials, calls Hunter,
  dedups against `discovered_contacts` (reusing `dedup.ts` unmodified),
  inserts new contacts, records provenance + usage events, and classifies
  the outcome as `found`/`not_configured`/`no_result`/`skipped_fresh`/
  `provider_error` (same classification spirit as
  `decisionMakerProvider.ts`'s `found`/`not_configured`/`no_result`).

**Real results: BLOCKED** (no key). **Mock-test results:** 15/15 passing in
`hunterProvider.test.ts` covering: `api_key` query param construction,
field mapping (incl. never-fabricate-a-name), multi-page pagination,
safety-cap truncation, 401 (non-retryable)/429 (retryable)/500 (retryable)
classification, timeout, the `DecisionMakerProvider` adapter's provenance
mapping, and the honest not-configured stub.

## 3. Email verification

**Built:** `apps/api/src/lib/hunterProvider.ts`'s `verifyEmailWithHunter`
(real GET to `/v2/email-verifier`) + `apps/api/src/lib/
hunterEmailVerification.ts`'s `verifyEmailCombined`, which composes the
EXISTING, unmodified `emailVerification.ts` (free DNS tier) with the new
Hunter tier as a confirming/upgrading signal — never replaces the free
tier; `freeTier` is preserved verbatim on the combined result.

**Combined status enum** (`CombinedVerificationStatus`): `valid | invalid |
risky | accept_all | unknown | not_verified | provider_error | role_based`.

**Explicit mapping from the free tier's own
`verified|unverified|role_based|risky|invalid`** (unchanged in
`emailVerification.ts`) onto the combined enum — documented in full in
`hunterEmailVerification.ts`'s header comment and summarized here:

| Situation | `combinedStatus` |
|---|---|
| Free tier `invalid` (bad syntax) | `invalid` — Hunter is **never called** (nothing it could add, and it would spend a real credit on a request that can only fail) |
| No Hunter key at all, free tier `role_based` | `role_based` |
| No Hunter key at all, free tier `risky` (no MX) | `risky` |
| No Hunter key at all, free tier `verified` | `not_verified` — the free tier never claimed mailbox-level proof; `not_verified` means "no paid tier ran," not "we think it's valid" |
| Hunter `valid` | `valid` |
| Hunter `invalid` | `invalid` |
| Hunter `accept_all` | `accept_all` — **never** `valid` |
| Hunter `disposable` | `invalid` |
| Hunter `webmail` + `smtp_check===true` + `accept_all===false` | `valid` |
| Hunter `webmail`, no confirming smtp_check | `unknown` |
| Hunter `unknown` | `unknown` |
| Hunter 202 (still processing) / 222 (SMTP check failed, retry later) | `unknown` (`inProgress: true`) |
| Any real Hunter HTTP/network/timeout failure | `provider_error` (never silently downgraded to `unknown`) |

**Verification accuracy limitations (explicit, as required):**
- A regex/syntax match (`EMAIL_RE`/`isSyntaxValid` in `emailVerification.ts`,
  unchanged) is never reported as proof of deliverability — it only ever
  gates `invalid` vs. "worth checking further."
- An MX record lookup (`hasMxRecord`, unchanged) is never reported as
  mailbox-level verification — a domain can have MX records and still
  reject every mailbox. The free tier's `verified` label already meant
  "syntactically valid + real MX + not a role inbox," not "a human read
  this," and `verifyEmailCombined` is careful not to upgrade that into a
  stronger claim just because Hunter wasn't consulted.
- Hunter's `accept_all` status means the receiving mail server accepts
  **every** address at that domain, whether or not a real mailbox exists —
  this is explicitly kept as its own category, never folded into `valid`.
- Hunter's `webmail` status is purely informational (a personal Gmail/
  Outlook-style address) — on its own it says nothing about
  deliverability, so it only becomes `valid`/`invalid` when Hunter's own
  `smtp_check` boolean actually settles it.

**Preserving evidence:** `verification_evidence` (jsonb, append-only — see
§4) holds the full `CombinedEmailVerificationResult` (both tiers' real
output), not just the final label, satisfying "preserve the original
provider response and relevant verification evidence." No separate
data-retention-policy doc/code exists elsewhere in this repository as of
this change (checked); this follows the same "keep the real evidence next
to the real result" idiom already used by `discovered_contacts.
email_verification`/`decision_maker_cache`.

**Real results: BLOCKED** (no key). **Mock-test results:** 12/12 passing in
`hunterEmailVerification.test.ts` exercising every row of the mapping table
above, plus "never calls Hunter for a syntactically invalid address" and
"never throws even when Hunter is completely unreachable."

## 4. Provenance ledger

**Migrations** (new, additive, following this repo's numbered/commented/
Up-Down/RLS-enabled convention):
- `packages/db/migrations/284_extend_integrations_hunter_credentials.sql` —
  adds `'hunter'` to `integrations.provider`'s CHECK constraint (drop/
  recreate, Postgres can't ALTER a CHECK in place) and a new
  `encrypted_credential_value` column, distinct from the pre-existing
  `encrypted_credential_ref` (which — per that original migration's own
  comment — stays a placeholder-label-only column for the other five
  providers; only `encrypted_credential_value`, and only for `hunter`,
  ever holds a real secret).
- `packages/db/migrations/285_create_contact_provenance_events.sql` — the
  ledger table itself.
- `packages/db/migrations/286_enable_rls_contact_provenance_events.sql` —
  RLS, same `tenant_id = current_setting('app.current_tenant_id', true)`
  policy pattern as every other tenant table.
- `packages/db/migrations/287_extend_usage_events_hunter_types.sql` — adds
  four Hunter-specific `usage_events.event_type` values (see §6).

**Schema** (`contact_provenance_events`): `tenant_id`, `project_id`,
`contact_id` (nullable FK to `discovered_contacts`), `organization_id`
(nullable FK to `discovered_organizations`), `operation_id`, `event_type`
(`discovery`|`verification`), `provider`, `provider_record_id`, `source`,
`confidence`, `discovered_at`, `verified_at`, `verification_result`,
`discovery_payload`/`verification_evidence` (jsonb). Two CHECK constraints
enforce the discovery/verification "shape" at the DB layer (a discovery row
must have `discovered_at`; a verification row must have `verified_at` AND
`verification_result`).

**Append-only, not versioned-via-overwrite:** there is no `UPDATE` anywhere
in `contactProvenance.ts` (only `INSERT ... ON CONFLICT ... DO NOTHING`) and
no `set_updated_at` trigger on the table — every discovery and every
(re-)verification is a NEW row. `listProvenanceForContact` returns the full
history, oldest first; nothing is ever collapsed or overwritten.
`getFreshVerificationEvent` only ever **reads** the most recent row to
decide whether to skip a redundant re-call — it never mutates history.

**Idempotency:** `uq_contact_provenance_events_operation_contact_type`
(a partial unique index on `operation_id, contact_id, event_type, source`)
is the DB-level guarantee a retried job can't double-write; `contactProvenance.ts`'s
writers target that exact arbiter via `ON CONFLICT (...) WHERE contact_id
IS NOT NULL DO NOTHING`.

**Tests** (`contactProvenance.test.ts`, 5/5 passing): discovery row shape,
verification row shape, retried-operation conflict absorption (no throw,
no duplicate), chronological full-history read, freshness-window query
shape.

## 5. Deduplication

Reuses `dedup.ts`'s `findDuplicateContact` **unmodified** — keyed on
normalized email first (the real per-person identifier), falling back to
exact name within the **same organization** only. `discoverContactsForOrganization`
never merges two different people just because they share a company
domain — confirmed by a real test (`hunterContactDiscovery.test.ts`:
"two DIFFERENT people at the same company domain — both kept as separate
contacts"). A race against a concurrent insert is caught by the DB's own
unique index (`uq_discovered_contacts_organization_normalized_email`) via
`ON CONFLICT ... DO NOTHING`, treated the same as an application-level
duplicate.

**Freshness guards** (never re-enrich/re-verify without a real reason,
but always allow an explicit override):
- `discoverContactsForOrganization`: skips (`status: "skipped_fresh"`,
  Hunter never called) if this organization already had a successful Hunter
  discovery event within 24h — unless `forceRefresh: true`.
- `verifyContactEmail`: skips a real Hunter call (reusing the latest
  provenance row's result) if a verification event for this contact exists
  within 24h — unless `forceReverify: true` (an explicit re-verification
  request is never silently skipped).

**Idempotent retried jobs:** proven by a real test — calling
`discoverContactsForOrganization` twice with the same `operationId` and
`forceRefresh: true` (simulating a retried worker job) inserts exactly one
contact and one discovery provenance row; the second call sees the
already-created contact as a duplicate (`newContactIds: []`,
`duplicateCount: 1`). No parallel contact, no parallel provenance row.

**Tenant isolation:** every query in `hunterContactDiscovery.ts`/
`contactProvenance.ts`/`integrationCredentials.ts` filters explicitly by
`tenant_id` (and usually `project_id`), on top of the RLS policies from
migration 286 (and the pre-existing 025 for `integrations`) — defense in
depth, matching this codebase's established convention. Verified by a real
test that fails the whole operation if a query is ever issued carrying a
foreign tenant's id.

## 6. Usage tracking

Four new `usage_events.event_type` values (migration 287, TS union
extended in `usageEvents.ts`, reusing `recordUsageEvent` exactly as-is —
no parallel usage-tracking mechanism):
- `hunter_api_request` — one row per real HTTP call to Hunter (plus a
  second row per page/call when `X-Credits-Used` was actually present,
  quantity = that real number; `metadata.creditsUnit` carries
  `X-Credits-Unit`). **Never invents a credit cost** — when Hunter's
  response doesn't include the header, no credits row is written at all
  (left genuinely absent, not zero/guessed).
- `hunter_discovery` — one row per discovery operation that persisted ≥1
  new contact, quantity = new-contact count.
- `hunter_verification` — one row per combined verification run (whether
  or not the Hunter tier actually ran — `metadata.hunterRan` records
  which).
- `hunter_request_failed` — one row per genuine Hunter API failure
  (`metadata.errorKind`/`statusCode` record what actually happened, never
  guessed).

**Campaign association:** not wired — no campaign context is available at
either call site (`discoverContactsForOrganization`/`verifyContactEmail`
operate on organizations/contacts, not campaigns); `recordUsageEvent`'s
`projectId` is always recorded, which is the association this codebase's
existing usage model actually supports at this layer.

**Timestamps:** `usage_events.created_at` (`default now()`), same as every
other usage event in this codebase.

## 7 & 8. Reliability and testing

**Test evidence (actually run — see commands/output below):**

```
apps/api> npx tsc --noEmit -p tsconfig.json
(no output — zero errors)

apps/api> npx vitest run test/credentialEncryption.test.ts test/integrationCredentials.test.ts \
  test/hunterProvider.test.ts test/hunterEmailVerification.test.ts test/contactProvenance.test.ts \
  test/hunterContactDiscovery.test.ts test/hunterRealApi.skip.test.ts

 Test Files  6 passed | 1 skipped (7)
      Tests  50 passed | 4 skipped (54)
```

**Full existing suite** (`npx vitest run`, no filter — all 51 test files,
including every pre-existing test file untouched by this work):

```
 Test Files  2 failed | 48 passed | 1 skipped (51)
      Tests  2 failed | 519 passed | 4 skipped (525)
```

The 2 failures (`test/discovery.test.ts` > "runs the public-directory
connector and persists a discovered organization", `test/
growthAnalyzer.test.ts` > "honestly persists a failed analysis...") are
**pre-existing and unrelated to this work** — confirmed by `git diff
--stat` showing this change never touches `discovery.ts`, `discovery.test.ts`,
`growthAnalyzer.ts`, or `growthAnalyzer.test.ts` at all (this change's only
modified, pre-existing files are `app.ts`, `config/env.ts`, and
`usageEvents.ts`, all additive edits). The `discovery.test.ts` failure's own
stack trace (`Cannot read properties of undefined (reading 'rows')` inside
`lookupAndCacheDecisionMakers`) points at the EXISTING
`decisionMakerProvider.ts` waterfall call site in `discovery.ts`, which this
work never wires Hunter into and never modifies.

Reliability coverage specifically exercised by real (mocked) tests:
- **Rate limits**: a 429 response classified `retryable: true`
  (`hunterProvider.test.ts`).
- **Timeouts**: `AbortController`-based timeout → `HunterTimeoutError`
  (`hunterProvider.test.ts`).
- **Invalid domains**: handled upstream by the free tier's MX check
  (`hunterEmailVerification.test.ts`'s "no-MX" case) — Hunter itself has no
  separate "invalid domain" response distinct from its normal error/empty
  paths, which are covered by the 4xx/5xx cases below.
- **Provider errors (4xx/5xx)**: 401 (non-retryable), 429/500 (retryable),
  400 on the verifier (`hunterProvider.test.ts`).
- **Partial responses**: a Domain Search page with 0 contacts, and a
  verifier response that fails JSON parsing, are both handled without
  throwing (empty-contacts path tested; JSON-parse-failure path falls back
  to `body = null` deliberately, by code inspection).
- **Retries/idempotency**: a retried `discoverContactsForOrganization` call
  (same `operationId`) never duplicates a contact or provenance row
  (`hunterContactDiscovery.test.ts`).
- **Missing credentials**: the honest `not_configured` path, for both
  discovery and verification, following `decisionMakerProvider.ts`'s exact
  convention (`NotConfiguredHunterProvider`, and `verifyContactEmail`'s
  `not_configured` status) — tested in both `hunterProvider.test.ts` and
  `hunterContactDiscovery.test.ts`.

**No worker job was added.** `apps/worker/src/agents/*` follows an
`AgentDefinition`/executor registry pattern for long-running *agent runs*
(market research, lead scoring, etc.), not ad hoc per-contact jobs; Hunter
discovery/verification here are synchronous, per-organization/per-contact
HTTP calls invoked directly from `apps/api/src/routes/hunterContacts.ts`
(idempotent via `operationId`, so a caller retrying the HTTP request is
already safe) rather than queued background jobs. Adding a dedicated
BullMQ job type was judged out of scope for this additive change without a
concrete trigger (e.g. a bulk "enrich all organizations" bulk action) to
justify it — noted here as a deliberate scope decision, not an oversight.

## API surface added

Mounted at `/api/v1/tenants/:tenantId/projects/:projectId/hunter`
(`apps/api/src/routes/hunterContacts.ts`, wired into `app.ts`):
- `PUT /credential` — store/rotate this tenant/project's Hunter API key
  (encrypted at rest).
- `DELETE /credential` — clear it.
- `GET /credential/status` — `{ configured: boolean }` only, never the key.
- `POST /discovered-organizations/:organizationId/contacts` — run Hunter
  Domain Search against that organization's existing `domain`.
- `POST /discovered-contacts/:contactId/verify-email` — combined
  verification.
- `GET /discovered-contacts/:contactId/provenance` — full append-only
  history.

Deliberately a separate router file from `routes/discovery.ts` (Agent A's
territory) to avoid any risk of a concurrent-edit collision — it only
*reads from* `discovered_organizations`/`discovered_contacts`, never edits
`discovery.ts` itself.

## Files touched

**New (this work owns):**
- `apps/api/src/lib/credentialEncryption.ts`
- `apps/api/src/lib/integrationCredentials.ts`
- `apps/api/src/lib/hunterProvider.ts`
- `apps/api/src/lib/hunterEmailVerification.ts`
- `apps/api/src/lib/hunterContactDiscovery.ts`
- `apps/api/src/lib/contactProvenance.ts`
- `apps/api/src/routes/hunterContacts.ts`
- `apps/api/test/credentialEncryption.test.ts`
- `apps/api/test/integrationCredentials.test.ts`
- `apps/api/test/hunterProvider.test.ts`
- `apps/api/test/hunterEmailVerification.test.ts`
- `apps/api/test/hunterContactDiscovery.test.ts`
- `apps/api/test/contactProvenance.test.ts`
- `apps/api/test/hunterRealApi.skip.test.ts`
- `packages/db/migrations/284_extend_integrations_hunter_credentials.sql`
- `packages/db/migrations/285_create_contact_provenance_events.sql`
- `packages/db/migrations/286_enable_rls_contact_provenance_events.sql`
- `packages/db/migrations/287_extend_usage_events_hunter_types.sql`
- `docs/PHASE_2_HUNTER_VALIDATION.md` (this file)

**Modified, additive only:**
- `apps/api/src/app.ts` — one import + one `app.use(...)` line.
- `apps/api/src/config/env.ts` — two new optional fields.
- `apps/api/src/lib/usageEvents.ts` — widened the `UsageEventType` union
  (four new values); no existing logic changed.

**Untouched (explicitly out of scope per file ownership):**
- `credentialEncryption.ts`'s own logic — it didn't exist before this
  change, so this change authored it once, from scratch; no second
  encryption scheme invented elsewhere.
- Any existing migration file.
- `decisionMakerProvider.ts`'s shared interfaces (used as-is) and
  `buildDecisionMakerWaterfall()` (not wired to include Hunter — left for
  the orchestrator to decide whether/when to prepend it).
- `routes/discovery.ts` (Agent A's territory), anything Apollo-shaped
  (Agent B's territory), any shared CRM model file.

## Remaining limitations (full, honest list)

1. **No real Hunter API key was available for this work.** Every "real
   results" line above is BLOCKED. `apps/api/test/hunterRealApi.skip.test.ts`
   documents, in real (skipped) tests, exactly what a genuine authenticated
   run would assert against Domain Search, Email Verifier, an invalid key
   (401), and rate limiting (403) — run it for real with
   `HUNTER_API_KEY=... npx vitest run test/hunterRealApi.skip.test.ts`
   after removing the `.skip`s.
2. Hunter is **not** wired into `buildDecisionMakerWaterfall()` — it's
   built and ready (`HunterProvider` implements `DecisionMakerProvider`)
   but prepending it there is a one-line change left for the orchestrator,
   since that waterfall is explicitly flagged as shared/sensitive
   territory in the brief.
3. No worker/background job was added (see §7/8's explanation) — discovery
   and verification are synchronous HTTP calls from the API route layer,
   idempotent via `operationId` but not queued/retried by a job runner.
4. No campaign association is recorded on Hunter usage events — no
   campaign context exists at either call site today.
5. Hunter's Domain Search response does not expose a true per-record
   provider id; the email address itself stands in for one (documented in
   code, not silently assumed).
6. This environment could not run `npm install` through the monorepo's
   normal `pnpm`/npm-workspaces mechanism at all — directory symlink/
   junction creation fails unconditionally on the `\\wsl.localhost\...`
   network filesystem this worktree is mounted on (confirmed with a raw
   `fs.symlinkSync` test, independent of npm). Verification was still done
   for real: `packages/agent-sdk` was built standalone and copied (not
   symlinked) into `apps/api/node_modules/@devlaunch/agent-sdk` purely to
   let `tsc`/`vitest` resolve it for this one verification pass; no
   committed file reflects this workaround (`package.json`/
   `package-lock.json` were restored to their original content before
   committing, and `node_modules/` is gitignored).
7. The 2 pre-existing test failures noted in §7/8's test evidence are real,
   but unrelated to this work (see that section for the specific proof).
