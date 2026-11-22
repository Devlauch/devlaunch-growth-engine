# Phase 2 Provider-Layer Port Report (Agent A1)

Branch: `phase2-integration-a1-providers`
Final commit: `6d68da9` ("Port hardened Apollo/Google connectors and Apollo decision-maker provider; add contact-freshness readout")
Scope: packages/agent-sdk connectors + apps/api provider libs, per
`docs/PHASE_2_MERGE_RECONCILIATION_PLAN.md` §5, Agent 1.

## 1. Per-file verdict table

| File | Verdict | Notes |
|---|---|---|
| `packages/agent-sdk/src/connectors/apolloConnector.ts` | **Port-as-new** | Did not exist on master. Ported from `milestone3-agentB-apollo` (byte-identical to `milestone3-phase2`'s copy — both branches carry the same file). Already has configurable filters, bounded transient retry, and 401/403 → `AuthenticationError` classification. |
| `packages/agent-sdk/src/connectors/googleSearchConnector.ts` | **Port-as-new (hardened variant)** | Did not exist on master. Two versions exist across the reference branches: `milestone3-phase2`'s is the original, `milestone3-agentB-apollo`'s adds bounded retry + nuanced 401/signature-matched-403 auth classification (while still correctly keeping genuine 403 quota-exhaustion as `RateLimitedError`, and refusing to guess on an ambiguous 403). Ported the `agentB-apollo` version as the superset. |
| `apps/api/src/lib/apolloDecisionMakerProvider.ts` | **Port-as-new, unmodified** | Did not exist on master. Identical across both reference branches. Implements master's existing `DecisionMakerProvider` interface (`decisionMakerProvider.ts`) with zero interface changes required — a clean drop-in. |
| `apps/api/src/lib/googleSearchConnector.ts` (as literally named in the task brief) | **Path correction, not a separate file** | The task brief lists this under `apps/api/src/lib/`, but the real file — on both reference branches and after this port — lives at `packages/agent-sdk/src/connectors/googleSearchConnector.ts`, as a `SourceConnector` sibling of `apolloConnector.ts`, not an `apps/api/src/lib` provider. Ported to that actual location; no file was created at the `apps/api/src/lib` path since nothing there ever existed in either tree. |
| `apps/api/src/lib/hunterContactDiscovery.ts` | **Master-is-superior, keep as-is (no changes)** | See §2 below for the full diff reasoning. Master's version already has freshness-gated skip logic, dedup, provenance, 4-event-type usage metering (`hunter_api_request`/`hunter_discovery`/`hunter_verification`/`hunter_request_failed`, migration 440), and delegates HTTP mechanics to `hunterProvider.ts`, which already has auth/retryable-status classification (`HunterApiError.retryable`) and real per-call credit capture from response headers. Phase 2's simpler, single-event-type (`hunter_api_call`, migration 295) version was **not** reintroduced, per explicit instruction. |
| `apps/api/src/lib/emailVerificationProvider.ts` | **Master-is-superior, keep as-is (no port)** | Phase 2's module (a generic `providerWaterfall`-based Hunter/baseline waterfall) has no analog on master by that name because master solved the same problem differently and, on balance, better: `hunterEmailVerification.ts`'s `verifyEmailCombined` + `hunterProvider.ts`'s `verifyEmailWithHunter`/`HunterApiError`. Master's combined-status model (`valid/invalid/risky/accept_all/unknown/not_verified/provider_error/role_based`) is richer than phase2's (`verified/risky/unknown/invalid/catch_all`) — it correctly distinguishes a `webmail` address's `smtp_check`/`accept_all` nuance and a true `provider_error` from a merely-unknown result, and captures real Hunter credit usage from response headers. Nothing from phase2's version is additive here. |
| `apps/api/src/lib/contactFreshness.ts` | **Port-as-new, rebuilt against master's schema** | Genuinely missing: a reusable, display-oriented "last verified at X (N days ago), by which provider, is it stale" readout. Master's `hunterContactDiscovery.ts` has an internal freshness **skip-check** (`getFreshVerificationEvent` from `contactProvenance.ts`) used to avoid re-billing Hunter credits, but nothing reusable for e.g. a dashboard badge. Phase 2's original read a `email_verification_results` ledger that does not exist on master (master uses `contact_provenance_events` instead, from its own independently-built Hunter track, migrations 438-440). Ported the pure `computeContactFreshness` day-math function unchanged, and rewrote the DB-reading `getContactVerificationFreshness` to query `contact_provenance_events` by `contact_id` only — that table has no `lead_id` column at all, so phase2's lead-id-or-contact-id dual lookup could not be preserved honestly; this is documented in the file's own doc comment rather than silently dropped. |

## 2. hunterContactDiscovery.ts — line-by-line diff findings (not ported)

Master's `apps/api/src/lib/hunterContactDiscovery.ts` (370 lines) vs. phase2's
(343 lines) are structurally different programs solving overlapping problems.
Master's:

- Orchestrates against an **existing** `discovered_organizations` row (never a
  parallel domain-input path).
- Has a freshness guard (`hasFreshDiscovery`, `DEFAULT_DISCOVERY_FRESHNESS_MS`
  = 24h) that skips a re-run within the window unless `forceRefresh` is set —
  functionally equivalent to what phase2's hardening would have added, just
  architected as an inline skip rather than a separate reusable connector-level
  retry wrapper.
- Dedupes via `dedup.ts`'s `findDuplicateContact` (email-first, name-fallback,
  same-organization-only).
- Writes append-only provenance via `contactProvenance.ts`.
- Meters usage via 4 distinct event types against migration 440's schema,
  with real `creditsUsed` captured from Hunter's `X-Credits-Used` header
  (see `hunterProvider.ts`'s `hunterGet`).
- Delegates the actual HTTP call to `hunterProvider.ts`'s `searchDomainAllPages`
  / `hunterGet`, which already has `HunterApiError` with a `.retryable` flag
  (`403 | 429 | >=500`) distinguishing those from a non-retryable 400/401/404/422,
  `HunterTimeoutError`, and `HunterNetworkError` — a different, arguably more
  nuanced classification than phase2's simple 401/403 → `AuthenticationError`
  (master's documented reasoning: Hunter's own docs describe 403 as a
  per-second/minute rate limit, genuinely distinct from a bad key, so treating
  it as retryable rather than a hard auth failure is a deliberate, not
  accidental, choice).

**One real, narrow gap found and NOT fixed in this pass:** master classifies
retryable Hunter HTTP failures (`HunterApiError.retryable`) but no caller
actually re-attempts a classified-retryable request with backoff — there is no
bounded-retry *loop* anywhere in the Hunter HTTP path, unlike phase2's (and
this port's) Apollo/Google connectors, which do retry transient 5xx/network
failures up to twice with exponential backoff. Fixing this would mean adding a
retry loop to `hunterGet`/`searchDomainAllPages` in `hunterProvider.ts` — a
file that is **not** in this agent's scoped file list (only
`hunterContactDiscovery.ts` is), and that underlies both the discovery and
verification paths used throughout master's independently-built Hunter track.
Per the "do not touch anything outside scope without flagging it" instruction,
this is reported here rather than patched: **recommend a follow-up task
(owner TBD by orchestrator) to add a bounded-retry loop to `hunterGet` for
`HunterApiError.retryable` responses**, mirroring the exact policy already
used in `apolloConnector.ts`/`googleSearchConnector.ts` in this same port
(2 retries, exponential backoff from a 300ms base, never retrying a
classified-non-retryable failure).

No other changes were made to `hunterContactDiscovery.ts`, `hunterProvider.ts`,
`contactProvenance.ts`, or any migration.

## 3. What was explicitly excluded, and why

- **Migration 295** (`295_add_hunter_to_usage_event_types.sql`, phase2's single
  `hunter_api_call` event type): not reintroduced. Superseded by master's
  already-committed migration 440 (4 event types with real credit capture).
  This agent did not touch any migration file, per scope.
- **Phase2's `providerCostReporting.ts`**: not touched — explicitly Agent A2's
  file.
- **Credential resolution for Apollo/Google**: left as a raw
  `apiKey: string | null = process.env.APOLLO_API_KEY ?? null` /
  `GOOGLE_SEARCH_API_KEY` / `GOOGLE_SEARCH_ENGINE_ID` constructor default on
  both connectors and on `ApolloDecisionMakerProvider`, exactly as phase2 had
  it. Master's `REAL_PROVIDERS` set in `apps/api/src/routes/integrations.ts`
  (confirmed read-only, line 52) currently contains only
  `["listmonk", "chatwoot", "postiz", "hunter"]` — `apollo`/`google` are not
  yet members. **Agent A2 needs to**:
  1. Add `"apollo"` and `"google"` to `REAL_PROVIDERS`.
  2. Rewire `ApolloConnector`, `GoogleSearchConnector`, and
     `ApolloDecisionMakerProvider`'s credential lookups through
     `credentialEncryption.ts`/`integrationCredentials.ts` (the same pattern
     `hunterProvider.ts`'s `resolveHunterApiKey` already uses: tenant
     credential first, `env.*ApiKey` as a dev-mode/global fallback), instead
     of the bare `process.env` read these three classes currently fall back
     to by default.
  3. `ApolloDecisionMakerProvider` is also not yet wired into
     `decisionMakerProvider.ts`'s `buildDecisionMakerWaterfall()` — that
     function currently returns only `[new NotConfiguredDecisionMakerProvider()]`.
     Prepending a real, credentialed Apollo provider there is natural
     follow-up work once step 2 exists, but doing it now would mean this
     agent inventing its own interim credential path, which the task
     instructions explicitly forbid.
- **env.ts**: not touched. No `apolloApiKey`/`googleSearchApiKey`/
  `googleSearchEngineId` fields exist there yet (only `googlePageSpeedApiKey`,
  an unrelated key, is present). Both new connectors are self-contained and
  read `process.env` directly by design (matching
  `OverpassDirectoryApiClient`'s existing convention), so this is not a hard
  blocker, but Agent A2 will likely want to add these three fields to
  `env.ts` as part of the credential-resolution rewire for consistency with
  how `hunterApiKey` is exposed there today.

## 4. Test results

Before this port, these files/tests did not exist on master (no baseline to
compare against for the new files). The pre-existing suite was not modified
and was re-run in full after the port to confirm nothing broke:

- `packages/agent-sdk`: `npx vitest run` → **3 files passed, 33/33 tests
  passed** (`registry.test.ts` 3, `googleSearchConnector.test.ts` 13,
  `apolloConnector.test.ts` 17). `registry.test.ts` passing confirms the new
  connectors register cleanly alongside the existing CSV/public-directory
  connectors.
- `apps/api`: `npx vitest run` → **104 files passed, 1 skipped (105 total);
  1014 tests passed, 8 skipped (1022 total)**. This includes the two new test
  files (`apolloDecisionMakerProvider.test.ts`: 13/13,
  `contactFreshness.test.ts`: 7/7) running alongside every pre-existing test
  file (`hunterEmailVerification.test.ts`, `contactProvenance.test.ts`,
  `decisionMakerProvider.test.ts`, `dedup.test.ts`, etc.) with zero
  regressions. The 1 skipped file (`hunterRealApi.skip.test.ts`, 4 tests) was
  already skipped before this port — a pre-existing, intentionally-disabled
  live-API test requiring a real `HUNTER_API_KEY` this environment doesn't
  have; untouched by this port.
- `npx tsc -p tsconfig.json --noEmit` passes cleanly for both
  `packages/agent-sdk` and `apps/api` with no new type errors.

All tests use mocked `fetch`/injectable `sleep`/`clock` and a fake
`{ query: vi.fn(...) }` `PoolClient` stand-in — no real network call and no
real database connection anywhere in this port's test code, matching this
codebase's existing convention throughout (`apolloConnector.test.ts`,
`googleSearchConnector.test.ts`, `apolloDecisionMakerProvider.test.ts`,
`contactFreshness.test.ts`). No claim is made anywhere that any of these
providers have been exercised against a real Apollo/Google/Hunter API key —
none exists in this environment.

## 5. Summary for the orchestrator

- Branch: `phase2-integration-a1-providers`
- Final commit: `6d68da9`
- 4 new source files, 4 new test files, 2 files modified (connector
  registry/index wiring) — all within this agent's scoped file list.
- No migration written or renumbered. No file outside this agent's scope
  (`credentialEncryption.ts`, `providerCostReporting.ts`, `integrations.ts`'s
  `REAL_PROVIDERS`, any route, any migration) was touched.
- Two follow-up items flagged for other owners:
  1. Agent A2: wire Apollo/Google credential resolution through
     `credentialEncryption.ts`/`integrationCredentials.ts` and add
     `"apollo"`/`"google"` to `REAL_PROVIDERS` (§3).
  2. Orchestrator/unassigned: consider adding a bounded-retry loop to
     `hunterProvider.ts`'s `hunterGet` for `HunterApiError.retryable`
     responses — a genuine, narrow gap found during the
     `hunterContactDiscovery.ts` diff, but out of this agent's scoped file
     list to fix directly (§2).
- No merge performed into `phase2-integration` or `master`; branch left as
  committed, ready for the orchestrator's own integration step.
