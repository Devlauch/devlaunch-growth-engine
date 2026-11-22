# Phase 2 Reconciliation — Agent A2: Credential Unification + Provider Cost Reporting

Branch: `phase2-integration-a2-credentials` (branched from a snapshot of master's current state).
Scope: unify Apollo/Google credential resolution onto master's existing credential-encryption
architecture, extend `REAL_PROVIDERS`, and rebuild `providerCostReporting.ts` against master's
richer Hunter usage-metering scheme. No merge performed; this branch is not merged into
`phase2-integration` or `master`.

## 1. Migration 295 exclusion — independent verification evidence

This was verified directly against the actual SQL files, not taken on the orchestrator's word.

**Files read:**
- `packages/db/migrations/440_extend_usage_events_hunter_types.sql` (this worktree — master's lineage)
- `.claude/worktrees/milestone3-phase2/packages/db/migrations/295_add_hunter_to_usage_event_types.sql` (reference only)
- `.claude/worktrees/milestone3-phase2/packages/db/migrations/288_add_provider_usage_event_types.sql` (295's own base — read because 295's "up" migration only makes sense relative to it)

**What 295 actually does.** Migration 295's up-migration is:

```sql
CHECK (event_type IN ('agent_run', 'api_request', 'lead_captured', 'ai_tokens', 'google_search_call', 'apollo_api_call', 'hunter_api_call'));
```

This is **not** a standalone `+hunter_api_call` delta — it's a full constraint replacement that
only adds one new value (`hunter_api_call`) relative to its own predecessor, migration 288, whose
up-migration was:

```sql
CHECK (event_type IN ('agent_run', 'api_request', 'lead_captured', 'ai_tokens', 'google_search_call', 'apollo_api_call'));
```

So in phase2's own lineage, **288** is what actually introduced `google_search_call` and
`apollo_api_call` (plus `discovery_sources.connector_type` values `'google_search'`/`'apollo'` —
not a usage_events concern at all), and **295** is what later added `hunter_api_call` on top of
that.

**What master's lineage actually has.** Master's migration numbers 280–287 are unrelated
(meetings, follow-up tasks, campaign spend, RLS, chatwoot, integration webhook events — confirmed
by listing and reading `packages/db/migrations/28{0..7}_*.sql` in this worktree). Master has
**no migration anywhere** that ever added `google_search_call` or `apollo_api_call` to
`usage_events`, and `usage_events_event_type_check`'s only pre-440 definition
(`230_create_usage_events.sql`) was `('agent_run', 'api_request', 'lead_captured', 'ai_tokens')`.
Migration 440 (master, already committed) widens that same constraint to add exactly:
`hunter_api_request`, `hunter_discovery`, `hunter_verification`, `hunter_request_failed`.

**Conclusion on the Hunter-specific question the orchestrator asked me to verify:** migration
295's only *incremental* effect over its own predecessor was adding `hunter_api_call` — a single,
coarse Hunter event type with no credit-usage capture. Master's 440 covers Hunter usage with
**four** distinct event types (request/discovery/verification/failure) plus real
`creditsUsed`/`creditsUnit` capture from Hunter's own response headers when present (verified by
reading `hunterContactDiscovery.ts`'s actual `recordUsageEvent` call sites — see §4 below). This
is a strict superset of what `hunter_api_call` could represent. **295's Hunter-specific
contribution has no unique effect master's 440 doesn't already cover — safe to exclude, confirmed
independently, not just restated from the background brief.**

**Important nuance the background brief did not fully spell out, found during verification:**
295's *base* constraint (inherited from 288) also carried `google_search_call` and
`apollo_api_call` — values master's lineage never got **at all**, from any migration, Hunter or
otherwise. Dropping 295 wholesale (correct, since neither any environment nor any shared/
production database ever applied it) does not by itself give master a `google_search_call` type —
that gap pre-existed 295 and traces back to the never-ported migration 288, which is a different
exclusion than the one I was asked to re-verify. Since Google's own connector code (owned by
Agent A1) and this agent's cost-reporting work both need `google_search_call` to exist, and since
my scope explicitly covers "any new migration genuinely required... or any CHECK constraint
widening," I added `packages/db/migrations/446_add_google_search_call_to_usage_event_types.sql`
to add that one value. I did **not** add `apollo_api_call` — see §3.

**No environment-application risk.** Confirmed via `git log`/worktree inspection that migration
295 (and 288) exist only inside the `milestone3-phase2` worktree's own migration directory; they
were never copied into master's `packages/db/migrations/`, so no shared/production database has
ever run them. Dropping 295 changes nothing for any real database.

## 2. REAL_PROVIDERS change justification

Master's `apps/api/src/routes/integrations.ts` already had a provider-agnostic path: `PROVIDERS`
(the full registry), `REAL_PROVIDERS` (an informational "this one builds a genuinely real
connection" flag), a generic `POST /:provider/connect` (encrypts a secret via
`credentialEncryption.ts`, regardless of provider), and a generic `POST /:provider/health-check`
that dynamically imports `../lib/${provider}Client.js` and calls its `checkHealth` export if
present — honestly reporting `integration_not_yet_implemented` when that module doesn't exist yet
(by design, for exactly this kind of concurrent multi-agent build).

Verified before changing anything:
- `apollo` and `google` were **not** in `PROVIDERS` at all (so `/connect`/`/health-check` 400'd
  on an unknown-provider zod-enum check).
- The `integrations` table's own `provider` CHECK constraint (`024_create_integrations.sql`,
  previously widened by migrations 285/437) **also** did not allow `'apollo'`/`'google'` — so even
  with the route-level registry fixed, a real `/connect` call would have failed at the DB layer.
  Added `packages/db/migrations/445_add_apollo_and_google_to_integrations.sql` to fix this; it was
  not mentioned in the original brief but is a hard blocker without it.
- Neither `apolloDecisionMakerProvider.ts` (Phase 2 reference) nor any `googleSearchConnector.ts`
  / `apolloClient.ts` / `googleClient.ts` existed in this worktree at the start of this work —
  confirmed via `find`. Phase 2's own `ApolloDecisionMakerProvider` takes a bare
  `apiKey: string | null` constructor argument sourced from raw `env` — exactly the bypass this
  reconciliation pass is supposed to fix.

What I built so `apollo`/`google` can honestly join `REAL_PROVIDERS` (i.e., actually have a real
credential path + health-check, not just the flag flipped):
- `apps/api/src/lib/providerCredentials.ts` — `resolveApolloApiKey` /
  `resolveGoogleSearchCredential`, thin wrappers over the **existing**
  `integrationCredentials.ts#getIntegrationCredential` (itself the only consumer of
  `credentialEncryption.ts` outside the connect route), with an `env.*` fallback — same resolution
  order as `hunterProvider.ts#resolveHunterApiKey`. No parallel credential system introduced.
  Google additionally needs a non-secret Programmable Search Engine ID (`cx`); this is resolved
  from the integration row's plain `config.engineId` (or `env.googleSearchEngineId`), never
  encrypted (it isn't a secret), mirroring listmonk's `config.baseUrl` convention.
- `apps/api/src/lib/apolloClient.ts` / `googleClient.ts` — `checkHealth` adapters matching the
  exact contract `routes/integrations.ts` already expects (same shape as `hunterClient.ts`).
  **Deliberately self-contained**: rather than importing Agent A1's forthcoming
  `apolloDecisionMakerProvider.ts` / `packages/agent-sdk/.../googleSearchConnector.ts` (neither
  existed in this worktree, and importing a not-yet-existing module would have broken the build
  for every other concurrent agent), each file makes its own minimal real HTTP call (Apollo
  People Search with `per_page: 1`; Google Custom Search with `num: 1`) purely for the
  connectivity/auth check. This is intentionally documented as a coordination point: once A1's
  modules land, the orchestrator may choose to have these delegate to them instead, to remove the
  one-time duplication — not hidden, called out in both files' doc comments.
- `apps/api/src/config/env.ts` — added `apolloApiKey`, `googleSearchApiKey`,
  `googleSearchEngineId` fallbacks, same convention/comment style as the existing `hunterApiKey`.
- `apps/api/src/routes/integrations.ts` — added `{ key: "apollo", ... }` / `{ key: "google", ... }`
  to `PROVIDERS` and both keys to `REAL_PROVIDERS`; updated the module/route doc comments and the
  `GET /` response's `note` string accordingly.

**Mandatory-rule compliance, re-verified:** no code here performs a real external HTTP call in
this environment (no real Apollo/Google API keys exist anywhere in this codebase's test
environment); every `checkHealth` honestly returns `not_configured` when a credential is missing
and `error` (never a fabricated `connected`) on any non-2xx/network failure; no raw API key is
echoed in any response (`hasSecret: Boolean(row)` only, same as every other provider); the
existing `/health-check` route's own collapsing of any non-`connected` `checkHealth` status to
`"error"` at the DB/response-status level (pre-existing behavior, confirmed identical for Hunter)
means `not_configured` surfaces via `detail`, not `status` — this was wrong in my first test draft
and corrected after running the suite (see §4).

## 3. Cost-reporting event-type mapping

`apps/api/src/lib/providerCostReporting.ts` was rebuilt from scratch (not line-edited from Phase
2's version) against master's actual schema, verified by reading `hunterContactDiscovery.ts`'s
real `recordUsageEvent` call sites rather than assuming the migration 440 doc comment's
description was the full story.

| Event type | Tracked? | `estimatedCostCents` | `realCreditsUsed` |
|---|---|---|---|
| `google_search_call` | Yes (new, migration 442) | $0.005/call estimate (Google Custom Search published list price) | n/a — not credit-metered |
| `hunter_api_request` | Yes (migration 440) | `null` — no uniform published $/call price across Hunter's quota plans | **Real**, when present (see below) |
| `hunter_discovery` | Yes (migration 440) | `null` | `null` (not a credit-metered event in this codebase's actual recordUsageEvent calls) |
| `hunter_verification` | Yes (migration 440) | `null` | `null` |
| `hunter_request_failed` | Yes (migration 440) | `null` | `null` |
| Apollo (any) | **No — real gap, documented, not invented** | n/a | n/a |

**Apollo gap, confirmed independently:** Apollo now has real credential resolution
(`providerCredentials.ts`) and is in `REAL_PROVIDERS`, but there is still no `usage_events` event
type recording a real Apollo call anywhere in master — because Apollo's actual People Search
business logic (`apolloDecisionMakerProvider.ts`) hasn't landed yet (Agent A1's scope) and no
migration ever introduced one. Per the explicit instruction not to invent an Apollo event type, I
did **not** add `apollo_api_call` (or any name) to the CHECK constraint, and
`PROVIDER_CALL_EVENT_TYPES` does not include it. This is surfaced honestly via
`ProviderCostReport.notTracked`, distinct from a "tracked but unpriced" row.

**Hunter real-credits finding (the specific thing the task asked me to re-check):** I re-verified
whether master's richer Hunter breakdown changes the "no reliable cost" conclusion. It does, but
not in the way a naive read of the migration doc comment suggests. The doc comment on migration
440 says credit headers are captured in `metadata` — true, but **not** as `metadata.creditsUsed`.
Reading `hunterContactDiscovery.ts` directly: the real credits-used figure is recorded as the
**`quantity`** of a **separate** `hunter_api_request` row, emitted only when Hunter's response
actually included a credits header, and flagged by that row's `metadata.creditsUnit` being
non-null (e.g. lines 161–170 and 343–351 of `hunterContactDiscovery.ts`). An ordinary
"an API call happened" row never sets `creditsUnit`. `providerCostReporting.ts`'s SQL distinguishes
the two with `FILTER (WHERE metadata->>'creditsUnit' IS NULL)` for `callCount` and
`FILTER (WHERE metadata->>'creditsUnit' IS NOT NULL)` summing `quantity` for `realCreditsUsed`, so
a credit-marker row is never double-counted as a second API call. This real figure is reported as
`realCreditsUsed`/`realCreditsUnit` on every `ProviderCostRow`, clearly distinguished from (and
preferred over, per the task's instruction) `estimatedCostCents`, which stays `null` for every
Hunter event type — Hunter still has no published credits-to-dollars conversion, so "N real
credits consumed" and "no honest dollar estimate" are both true at once and are reported as such,
never conflated.

`creditsRemaining` stays `null` unconditionally — no provider integration in this codebase exposes
a reliable "remaining balance" figure.

## 4. Test results

Full `apps/api` suite, before my changes (baseline not separately re-run — this worktree is a
fresh snapshot with no pre-existing failures reported by the orchestrator) and after:

**After (final, this agent's full diff applied):**
```
Test Files  106 passed | 1 skipped (107)
     Tests  1026 passed | 8 skipped (1034)
```
Zero failures, zero regressions. (One intermediate run during this work had 2 failing assertions
in `test/integrations.test.ts` — my own first-draft tests wrongly expected the HTTP response's
`status` field to read `"not_configured"`; the existing generic health-check route collapses any
non-`"connected"` `checkHealth` result to `"error"` at that layer — same pre-existing behavior
Hunter's own `not_configured` case already has — and only preserves the honest reason in `detail`.
Fixed by correcting the test expectations to match the system's actual, pre-existing contract, not
by changing route behavior.)

New/changed test files:
- `apps/api/test/providerCostReporting.test.ts` — rebuilt against the new event-type scheme
  (google_search_call + 4 hunter types), including dedicated cases for the real-credits-vs-estimate
  distinction and the Apollo `notTracked` gap.
- `apps/api/test/integrations.test.ts` — added apollo/google registry-listing and health-check
  cases (not_configured-via-missing-secret, not_configured-via-missing-engine-id).
- `apps/api/test/apolloClient.test.ts`, `apps/api/test/googleClient.test.ts` — new, cover
  not_configured / connected / 401-403 / 429 / network-error paths via mocked `fetch`.
- `apps/api/test/providerCredentials.test.ts` — new, covers tenant-credential-first /
  env-fallback-second / null-when-neither resolution for both helpers.

## 5. Coordination notes for other agents

- **Agent A1** (`apolloDecisionMakerProvider.ts`, `googleSearchConnector.ts`,
  `hunterContactDiscovery.ts` — untouched by me): please use
  `apps/api/src/lib/providerCredentials.ts`'s `resolveApolloApiKey(tenantDb, tenantId, projectId)`
  and `resolveGoogleSearchCredential(tenantDb, tenantId, projectId)` instead of reading
  `process.env.APOLLO_API_KEY` / `GOOGLE_SEARCH_API_KEY` directly, so a tenant's own stored
  credential (via the now-real `POST /integrations/apollo/connect` / `.../google/connect`) takes
  priority. When Apollo's real business logic lands and starts recording usage, it will need a new
  `usage_events` event type (this agent deliberately did not invent one) and should be added to
  `PROVIDER_CALL_EVENT_TYPES` in `providerCostReporting.ts` at that point.
- `apps/api/src/lib/apolloClient.ts` / `googleClient.ts` currently make their own minimal,
  self-contained real HTTP calls for health-check purposes only (documented in both files) to
  avoid a build-time dependency on A1's not-yet-landed modules. Once those modules exist, the
  orchestrator may want these two files simplified to delegate to them instead.
- Discovery-side wiring (`discovery_sources.connector_type` needing `'google_search'`/`'apollo'`
  values, actually calling `recordUsageEvent({ eventType: "google_search_call", ... })` from
  wherever Google search is invoked) is out of this agent's scope and was not touched.

## 6. Files changed

- `apps/api/src/config/env.ts` — added apolloApiKey/googleSearchApiKey/googleSearchEngineId
- `apps/api/src/lib/providerCredentials.ts` — new
- `apps/api/src/lib/apolloClient.ts` — new
- `apps/api/src/lib/googleClient.ts` — new
- `apps/api/src/lib/usageEvents.ts` — added `google_search_call`
- `apps/api/src/lib/providerCostReporting.ts` — rebuilt
- `apps/api/src/routes/integrations.ts` — PROVIDERS/REAL_PROVIDERS + doc comments
- `packages/db/migrations/445_add_apollo_and_google_to_integrations.sql` — new
- `packages/db/migrations/446_add_google_search_call_to_usage_event_types.sql` — new
- `apps/api/test/providerCostReporting.test.ts` — rebuilt
- `apps/api/test/integrations.test.ts` — extended
- `apps/api/test/apolloClient.test.ts` — new
- `apps/api/test/googleClient.test.ts` — new
- `apps/api/test/providerCredentials.test.ts` — new
