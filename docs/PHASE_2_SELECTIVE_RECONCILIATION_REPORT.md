# Phase 2 Selective Reconciliation — Final Report

**Branch:** `phase2-integration` (worktree `.claude/worktrees/phase2-integration`), branched
from a snapshot of `master`'s working tree at commit `ce49eaf` (master HEAD `f6c6bc1` +
220 uncommitted files from the live concurrent session, captured without modifying
master itself — real `.env.listmonk`/`.env.chatwoot`/`.env.postiz` secrets excluded from
the snapshot, `.example` variants kept).

**Not merged into master.** Stopping here per the governing instructions' explicit stop
condition, pending approval.

## 1. What this was

A selective port, not a wholesale merge. `milestone3-phase2` (isolated branch, Sections
A+B of the original roadmap) and `master` diverged from a common ancestor and were built
**independently and concurrently** — master raced far ahead on a much broader front
(migrations to `440` vs. phase2's `295`; Listmonk/Chatwoot/Postiz; `credentialEncryption.ts`;
contacts/companies routes; its own independently-built `deals.ts`, `leadPromotion.ts`,
`activityTimeline.ts`, `dedup.ts`, `hunterContactDiscovery.ts`, `prospectingCampaigns.ts`).
7 agents, each scoped to one narrow diff-and-decide area, determined per-file whether
master's existing implementation already covered something, superseded phase2's version,
or genuinely lacked it — and ported only the confirmed gaps.

## 2. Feature-by-feature classification

| Feature | Classification | Notes |
|---|---|---|
| Apollo company/decision-maker connector | **Ported as additive** | `packages/agent-sdk/src/connectors/apolloConnector.ts`, `apps/api/src/lib/apolloDecisionMakerProvider.ts` — master had no Apollo connector at all. Orchestrator additionally wired it into the real `decisionMakerProvider.ts` waterfall (was dead code after A1's port — see §5). |
| Google Search connector hardening | **Ported as additive** | `packages/agent-sdk/src/connectors/googleSearchConnector.ts` — pulled from the already-hardened `milestone3-agentB-apollo` branch (auth-error classification + bounded retry), not phase2's own weaker version. |
| Hunter contact discovery | **Already implemented in master, superior — kept as-is** | Master's independently-built version already has freshness-gating, dedup, provenance, and 4-event-type usage metering (migration 440). Phase2's simpler single-event-type scheme was not reintroduced. |
| Hunter email verification | **Already implemented in master, superior — kept as-is** | Master's `hunterEmailVerification.ts`/`hunterProvider.ts` combo is a richer superset. |
| Contact freshness/provenance | **Ported as additive (rebuilt, not copied)** | `apps/api/src/lib/contactFreshness.ts` — phase2's version read a table (`email_verification_results`) that doesn't exist on master; rewritten against master's actual `contact_provenance_events` table. |
| Hunter usage metering (migration 295) | **Deliberately excluded** | Master's migration `440` (4 event types + real header-derived credits) is a verified strict superset of phase2's `295` (1 coarse type, no credits). Independently re-verified by Agent A2 by reading both migrations plus 295's own predecessor (288). Neither 295 nor 288 was ever applied to any shared database. |
| Apollo/Google credential resolution | **Ported as additive** | `apps/api/src/lib/providerCredentials.ts` — thin wrapper over master's existing `credentialEncryption.ts`/`integrationCredentials.ts`, same convention as Hunter's own `resolveHunterApiKey`. No duplicate credential system introduced. |
| Apollo/Google in REAL_PROVIDERS + health checks | **Ported as additive** | `apps/api/src/routes/integrations.ts`, new `apolloClient.ts`/`googleClient.ts` health-check adapters. Added only after credential resolution + health-check wiring existed; missing credentials report an honest not-configured/blocked status, never "connected". |
| Provider cost/credit reporting | **Ported as additive (rebuilt)** | `apps/api/src/lib/providerCostReporting.ts` — rebuilt from scratch against master's real event-type scheme (`google_search_call`, 4 Hunter types, no Apollo usage-event type found — documented as a real gap, not invented). `estimatedCostCents` only for Google (published list price); Hunter's real `creditsUsed`/`creditsUnit` surfaced separately, never converted to a guessed dollar figure; `creditsRemaining` always null. |
| Fuzzy/Levenshtein org dedup | **Ported as additive** | `apps/api/src/lib/dedup.ts` extended (not replaced) with `levenshteinDistance`/`orgNameSimilarity`/`isFuzzyOrgNameMatch`/`findPossibleDuplicateOrganization`. Flag-only, proven by a test asserting only `SELECT` statements are ever issued — never auto-merges. |
| `possible_duplicate_of` column | **Ported as additive** | Migration `441`. No pre-existing equivalent found on master under any name. |
| `deals.ts` CRUD (general) | **Already implemented in master, superior — kept as-is** | Master's independently-built 304-line version has a richer route surface (customers view, assignments, stalled-deal checks) than phase2's. |
| `lost_reason`/`won_reason` on deals | **Ported as additive** | Migration `442`. Confirmed via migration grep this wasn't already covered under a different name — a genuine gap, not a rename problem. |
| Qualification logic (status/score gating) | **Already implemented in master, superior — kept as-is** | Master's `leadPromotion.ts#evaluateQualification()` already existed with a hardcoded threshold constant. Not replaced. |
| Configurable per-project qualification threshold | **Ported as additive** | `qualification_settings` table (migrations `443`/`444`), CRUD route, `evaluateQualification()` extended with an optional threshold param defaulting to the existing hardcoded constant (byte-identical default behavior verified by test) — master's promotion/gating taxonomy itself untouched. |
| No-auto-deal-creation rule | **Verified intact, not modified** | Explicit regression test confirms no `INSERT INTO deals` is ever issued by qualification/promotion logic, including when driven by a configured (non-default) threshold. No violation found; nothing required escalation. |
| Lead-assignment CRUD | **Ported as additive, byte-for-byte** | `apps/api/src/lib/leadAssignment.ts`, `routes/leadAssignments.ts` — independently re-verified missing (not just taken from the plan doc's grep); master's existing `lead_assignments`/`crm_tasks` schema matched phase2's assumptions exactly, so no adaptation was needed. |
| General CRM-tasks CRUD | **Ported as additive, byte-for-byte** | `apps/api/src/routes/crmTasks.ts` — additional CRUD surface alongside existing internal writers (`replies.ts`, `advanceSequences.ts`), which were left untouched. |
| Prospect quality filters | **Ported as additive** | `discovery.ts` extended, following master's existing `priorityQueue.ts` filtering convention. Employee-count and contact-source-provider filters deliberately omitted — no connector populates the former, no schema column exists for the latter on master. |
| Bulk review / bulk CRM import | **Ported as additive** | `POST /discovered-organizations/bulk-promote`, best-effort per-item (not all-or-nothing). |
| Campaign-level discovery analytics | **Ported as additive (rebuilt against master's real schema)** | `prospectingCampaigns.ts` already existed on master (not the "much bigger gap" the audit plan had flagged as a risk) but with a materially different schema — no junction table, no budget/spend columns. Analytics endpoint rebuilt against what master actually has; spend/budget stats honestly omitted rather than fabricated. |
| Activity timeline | **Merged (union), not replaced** | Master's existing `activityTimeline.ts` (216 lines) extended with 5 genuinely-missing event types (`lead_created`, `lead_scored`, `deal_created`, `crm_task_created`, `discovery_sourced`); master's existing 6 types kept unchanged. `deal_stage`-with-reasons deliberately deferred (depends on this round's own `lost_reason`/`won_reason` port — see §6 follow-up). |
| Workflow stepper UI | **Ported as additive** | Reuses master's existing `.steps`/`.step-done` CSS pattern (previously used only for onboarding) rather than inventing new styles; wired into master's existing `LeadDetailPage.tsx`. |
| `apps/dashboard/src/hooks/useLeadActivity.ts` | **Fixed in passing (pre-existing bug, in this feature's own chain)** | `ActivityTimeline.tsx` imported a hook that didn't exist anywhere in the repo; created it as part of wiring the stepper in. |
| `apps/dashboard/src/hooks/useNotes.ts` | **Still incomplete — pre-existing blocker, out of scope, not fixed** | `NotesPanel.tsx` has the identical missing-hook bug. Confirmed via `git show` against the pre-agent snapshot (`ce49eaf`) that this predates all 7 agents' work entirely — it is the live concurrent session's own in-progress gap. It is currently the **only** reason `apps/dashboard`'s production build fails end-to-end (see §7). |

## 3. Migration lane (final, verified no collisions)

Three agents (A2, B1, C1) each independently chose migration numbers starting at `441`
inside their own isolated worktrees (the only number any of them could safely assume was
free, since master's tip was `440` in every worktree's snapshot). All three collided
numerically at merge time, as anticipated in the original reconciliation plan. Resolved
by the orchestrator during the merge pass — renumbered, never renamed in place without
checking, no file deleted, no tracking row touched (none of these had ever been applied
to any database):

| Final # | File | Originally from |
|---|---|---|
| 441 | `add_possible_duplicate_to_discovered_organizations.sql` | Agent C1 (kept as first-merged, no renumber needed) |
| 442 | `add_outcome_reasons_to_deals.sql` | Agent B1 (renumbered from its own `441`) |
| 443 | `create_qualification_settings.sql` | Agent B1 (renumbered from its own `442`) |
| 444 | `enable_rls_qualification_settings.sql` | Agent B1 (renumbered from its own `443`) |
| 445 | `add_apollo_and_google_to_integrations.sql` | Agent A2 (renumbered from its own `441`) |
| 446 | `add_google_search_call_to_usage_event_types.sql` | Agent A2 (renumbered from its own `442`) |

Every in-code doc-comment reference to an old number was updated to match (verified by
grep after each renumber — see the two "Renumber ... to avoid collision" commits). No
functional code depends on a migration's number, only its content and relative order, so
renumbering carried zero behavior risk. `ls packages/db/migrations | sort -t_ -k1 -n`
confirms a clean, gapless, non-duplicated sequence through `446`.

## 4. Files ported vs. excluded (summary — see each track's own report for full detail)

Each agent's own deliverable, committed in this merge, has the complete file list:
`docs/PHASE_2_PROVIDER_PORT_REPORT.md` (A1), `docs/PHASE_2_CREDENTIAL_AND_COST_REPORT.md`
(A2), `docs/PHASE_2_CRM_PORT_REPORT.md` (B1), `docs/PHASE_2_LEAD_ASSIGNMENT_CRM_TASKS_REPORT.md`
(B2), `docs/PHASE_2_DEDUP_PORT_REPORT.md` (C1), `docs/PHASE_2_QUALITY_BULK_ANALYTICS_REPORT.md`
(C3), `docs/PHASE_2_ACTIVITY_TIMELINE_STEPPER_REPORT.md` (C2).

Deliberately excluded in full: phase2's `hunterContactDiscovery.ts`, `emailVerificationProvider.ts`,
`deals.ts` (general CRUD), `leadPromotion.ts`'s own gating logic, `activityTimeline.ts` (as a
replacement — merged instead), `providerCostReporting.ts`'s original event-type scheme, migration
`295`.

## 5. Orchestrator-level follow-up (beyond the 7 agents' own scopes)

1. **Migration renumbering** (§3).
2. **Apollo credential wiring into the real waterfall** — Agent A1 ported
   `apolloDecisionMakerProvider.ts`, but nothing in master ever constructed it; Agent A2
   built `providerCredentials.ts#resolveApolloApiKey` for exactly this purpose, but had no
   scope to connect the two (correctly flagged by both agents in their own reports rather
   than reaching across scope boundaries). Fixed post-merge: `buildDecisionMakerWaterfall()`
   is now async, accepts optional `(tenantDb, tenantId, projectId)`, and prepends a real
   `ApolloDecisionMakerProvider` ahead of the honest stub when a tenant's Apollo credential
   resolves (tenant's own stored integration row first, `env.apolloApiKey` fallback
   second — identical precedence to every other real provider in this codebase). With no
   tenant context, or no resolvable credential, behavior is byte-identical to before (stub
   only) — verified by test. `discoveryRun.ts`/`routes/discovery.ts` now thread `projectId`
   through to make this resolution possible. Fixed 5 existing tests whose mocked query
   sequences didn't anticipate the one new `SELECT` this introduces (`getIntegrationCredential`),
   and added 2 new tests proving the real-provider path is actually exercised now — it was
   previously untested, since the function it depends on was unused.
3. **`GoogleSearchConnector` left unwired to the credential system** (documented, not fixed)
   — it lives in `packages/agent-sdk`, which cannot import `apps/api`'s credential system
   (the file's own comment already documents this constraint); `registry.ts` constructs it
   with its own `process.env` fallback, unchanged. Fixing this honestly needs a registry/
   dependency-injection redesign, which is out of this reconciliation's scope — flagged as
   a follow-up, not attempted as a workaround.
4. **Hunter HTTP retries are classified but never actually retried** (documented, not
   fixed, flagged by Agent A1) — `HunterApiError.retryable` exists but no caller applies
   backoff on a retryable failure, unlike the Apollo/Google connectors. Out of A1's scoped
   file list (`hunterProvider.ts` wasn't in it); not touched here either, since it's an
   independent pre-existing gap in master's own code, not something this reconciliation
   introduced or was asked to fix.

## 6. Known follow-ups flagged by individual agents (not acted on, intentionally)

- 5 other hardcoded `QUALIFIED_SCORE_THRESHOLD=50` copies exist in analytics/reporting
  files, still not wired to the new per-project `qualification_settings` table — only
  `leadPromotion.ts`'s `evaluateQualification()` was in scope for this pass.
- `activityTimeline.ts`'s `deal_stage` event doesn't yet surface the new `lost_reason`/
  `won_reason` columns (migration 442) — Agent C2 built its timeline union before B1's
  port landed in the same worktree snapshot and correctly declined to guess at an
  interface that didn't exist yet. Small, well-scoped follow-up for a future pass.
- `lostDealAnalysis.ts`/`dealHealth.ts` could eventually use the new `lost_reason` text
  alongside existing reply-classification objection themes — a suggestion, not a gap.
- A possible-duplicate-flag endpoint/UI surfacing `findPossibleDuplicateOrganization`'s
  result isn't wired into any route yet (the function exists and is tested in isolation
  only) — Agent C1 built the detection, left the surfacing to a future pass since it would
  have meant editing `discovery.ts` concurrently with Agent C3's own work there.

## 7. Verification (full, after all merges + the orchestrator's own follow-up commit)

| Suite | Result |
|---|---|
| `apps/api` (`npx vitest run`) | **1110 passed, 8 skipped, 0 failed** (112 test files passed, 1 skipped — the skipped file, `hunterRealApi.skip.test.ts`, is a pre-existing, deliberately-skipped real-API test requiring live credentials, unrelated to this work) |
| `apps/worker` (`npx vitest run`) | **97 passed, 0 failed** (14 files) |
| `packages/agent-sdk` (`npx vitest run`) | **33 passed, 0 failed** (3 files) |
| `apps/api` `tsc --noEmit` | Clean, 0 errors |
| `apps/dashboard` build (`tsc --noEmit && vite build`) | **Fails** — 2 errors, both in `NotesPanel.tsx` (missing `../hooks/useNotes` module + one resulting implicit-`any`). Independently reproduced against the pre-agent snapshot (`ce49eaf`) by two separate agents (C2, C3) via `git stash`/`git show` — confirmed pre-existing in the live concurrent session's own uncommitted work, not introduced by this reconciliation or by any of its 7 tracks. Every dashboard file this reconciliation touched produces zero new `tsc` errors of its own (verified identically before/after by Agent C3). |

No migration was run against a real database (no live Postgres instance was targeted —
all verification is via mocked `pg` Pool/PoolClient, consistent with this codebase's
established test convention). No real external HTTP call was made to Apollo, Google,
Hunter, Listmonk, Chatwoot, or Postiz — no real credentials exist in this environment for
any of them (confirmed repeatedly throughout this entire engagement). Every "connected"/
health-check claim in the ported code is gated on an honestly-resolved credential;
nothing here claims live-provider validation.

## 8. Remaining blockers

1. `apps/dashboard`'s production build cannot complete end-to-end until whoever owns the
   live concurrent session's `NotesPanel.tsx`/notes feature adds the missing
   `hooks/useNotes.ts` — unrelated to this reconciliation, not fixed here per the explicit
   instruction not to modify unrelated concurrent work.
2. No Apollo-specific `usage_events` event type exists on master at all (Agent A2 verified
   this directly) — Apollo calls are made but not metered anywhere yet. Documented honestly
   in `providerCostReporting.ts`'s output (`notTracked`), not invented.
3. `GoogleSearchConnector`'s credential resolution (§5.3) and Hunter's un-retried
   retryable-error classification (§5.4) are both real, scoped gaps for a future pass.
4. This branch (`phase2-integration`) itself is still not merged into master, and master's
   own working tree continues to change concurrently (confirmed moving between audit and
   execution — master's uncommitted file count changed from 226 to 233 to 242 over the
   course of this engagement). A final diff against master's actual eventual commit is
   still needed before any real merge, exactly as the original reconciliation plan
   anticipated.

## 9. Recommended next milestone

Given the scale mismatch this reconciliation surfaced (master had already independently
built most of Sections A+B and parts of what the original 7-section roadmap called later
sections — `growthAdvisor.ts`, `dealHealth.ts` already exist), the highest-leverage next
step is **not** starting Sections C-G fresh. It's (a) getting this branch actually merged
into master once the live session's own work settles, (b) closing the small, well-scoped
follow-ups in §6 (qualification-threshold wiring into the remaining 5 hardcoded copies,
`deal_stage` reasons in the timeline, the dedup-flag UI surfacing), and (c) auditing
whether master's own independent work already covers some of Sections C-G before planning
any new build — the same "audit before building" discipline this entire reconciliation was
built around.
