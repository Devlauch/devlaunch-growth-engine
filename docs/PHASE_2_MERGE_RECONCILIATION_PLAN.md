# Phase 2 Merge Reconciliation Plan

**Status: DRAFT — audit complete, reconciliation NOT started.** Per the governing
instructions' explicit stop condition, this plan stops here for review before any
file is touched in an isolated worktree. No merge, no migration renumbering, no
code port has happened yet.

## 1. What was actually audited

```
Branch tip (milestone3-phase2):  c227614
Worktree:                        .claude/worktrees/milestone3-phase2
Shared tree (master):            f6c6bc1 + 226 modified/untracked files, uncommitted
Merge base (phase2 vs master):   8be097d
master is 1 commit ahead of the merge base (f6c6bc1 itself)
phase2 is 21 commits ahead of the merge base
milestone3-prospecting is NOT an ancestor of master (separate lineage)
```

**This is the single most important finding:** `master`'s committed history and
`milestone3-phase2`'s history diverged from a common ancestor and were built
**independently and concurrently**, not sequentially. Master is not "behind" phase2
in the normal sense — it raced ahead on a different, much larger front (Listmonk,
Chatwoot, Postiz, contacts/companies tables, credential encryption, deal health,
lead promotion, and what looks like an early AI Growth Advisor) while Phase 2 was
being built in isolation on an older snapshot (`81f3dc4`).

Master's working tree currently has **226 uncommitted modified/untracked files**
(`.env.listmonk`, `.env.chatwoot`, `.env.postiz` and real `.ts`/`.sql` work) — this
is itself in-flight work from a concurrent session, not a stable commit to branch
from. Any worktree created for reconciliation must be based on master's current
**working tree state**, not just its last commit, and must never run `git clean`,
`git checkout .`, or `git stash` against it.

## 2. Scale mismatch

| | master (committed + working tree) | milestone3-phase2 |
|---|---|---|
| Migrations | 160 files, numbered up to `440` | 124 files, numbered up to `295` |
| Hunter contact discovery | Already exists, committed (`f6c6bc1`) | Exists, built independently |
| Credential encryption | Exists (`credentialEncryption.ts`, real encrypt/decrypt) | Does not exist in this branch |
| Listmonk/Chatwoot/Postiz | Exist (clients + integration routes + webhook migrations) | Do not exist |
| contacts/companies routes | Exist | Do not exist |
| deals.ts route | Exists, 304 lines, committed | Exists, built independently in Track 3 |
| activityTimeline.ts | Exists, 216 lines, committed | Exists, built independently in Track 4 |
| Qualification concept | Exists (`leadPromotion.ts`) — **hardcoded** `QUALIFIED_SCORE_THRESHOLD` constant | Exists — **configurable** `qualification_settings` table, per-project |
| Lead assignment CRUD | Not found anywhere on master | New in Track 3 |
| General `crm_tasks` CRUD route | Not found (only `replies.ts`/`dealHealth.ts` touch the table internally) | New in Track 3 |
| Provider cost/credit reporting | Not found | New in Track 1 |
| Dedup | `dedup.ts`, 227 lines, **exact/normalized matching only** | `dedup.ts`, 390 lines, adds **fuzzy/Levenshtein matching**, flag-only |
| Hunter usage metering | Richer: 4 distinct event types (`hunter_api_request`, `hunter_discovery`, `hunter_verification`, `hunter_request_failed`, migration `440`), with real `creditsUsed` captured from Hunter's response headers when present | Simpler: 1 event type (`hunter_api_call`, migration `295`) |

**Conclusion:** this is not a conflict-resolution merge of two branches building the
same thing at roughly the same pace. It is a **selective port**: most of what
Track 3/4 built has a more mature, already-committed counterpart on master that
should win. The genuinely new, non-duplicated value in `milestone3-phase2` is
narrower than the branch's full diff.

## 3. Per-track reconciliation disposition

### Track 1 — provider hardening + cost reporting
- **Google Search / Hunter hardening** (auth-error classification, bounded retry,
  configurable filters): no equivalent exists on master for Google. For Hunter,
  master's `hunterContactDiscovery.ts` (committed independently) needs a side-by-side
  diff before assuming phase2's hardening is additive rather than duplicative.
- **`providerCostReporting.ts`**: genuinely new, nothing on master. Must be
  **rebuilt against master's richer Hunter event-type scheme** (`hunter_api_request`
  / `hunter_discovery` / `hunter_verification` / `hunter_request_failed`), not
  against phase2's own `hunter_api_call`. Migration `295` is **superseded** by
  master's `440_extend_usage_events_hunter_types.sql` — migration 295 must be
  dropped, not renumbered-and-kept, once confirmed no environment has ever applied it
  (it only ever existed in an isolated worktree, never run against a shared DB).
- **Credential resolution**: phase2's `ApolloDecisionMakerProvider` /
  `HunterContactDiscoveryProvider` take a raw `apiKey: string | null` constructor
  argument, with the caller expected to source it from `env` directly. Master
  already has a real `credentialEncryption.ts` and an `integrations.ts` registry
  (`REAL_PROVIDERS` includes `"hunter"`, not yet `"apollo"`/`"google"`). **Action
  required:** rewire Apollo/Google/Hunter to resolve their key through master's
  existing credential system instead of a bare env lookup — do not introduce a
  second credential path.

### Track 2 — dedup, quality filters, bulk review, analytics
- **Fuzzy/Levenshtein org-name dedup**: genuinely new (master's `dedup.ts` is
  exact-normalized-match only). Portable as an addition to master's existing file,
  not a replacement of it.
- **Quality filters / bulk-promote / campaign analytics**: `discovery.ts` and
  `prospectingCampaigns.ts` both appear in master's own dirty working tree (modified,
  uncommitted) — needs a real three-way diff (merge-base / master's working copy /
  phase2) before any decision, since the concurrent session may have touched the
  exact same functions.

### Track 3 — deals, lead assignment, qualification, CRM tasks
- **`deals.ts`**: master's version (304 lines, committed) is almost certainly more
  complete than phase2's independently-built one — **needs line-by-line diff**,
  default assumption is master's wins, phase2's stage-transition/`lost_reason`
  validation logic gets ported in only if genuinely missing from master's.
  Migration `292` (`lost_reason`/`won_reason` columns) needs a check against
  master's `deals` schema — if master already added equivalent columns under
  different names, this is a rename/alias problem, not a straight port.
- **Qualification**: master's `leadPromotion.ts` already implements "lead crosses
  threshold -> eligible for CRM promotion," but with a single hardcoded
  `QUALIFIED_SCORE_THRESHOLD` constant, not phase2's per-project configurable
  `qualification_settings` table. **This is phase2's one clearly-additive,
  non-duplicated contribution here**: port `qualification_settings` (migration,
  table, CRUD route) and wire `leadPromotion.ts`'s `evaluateQualification()` to read
  the per-project threshold instead of the hardcoded constant — do not replace
  master's promotion/gating logic, extend its threshold source.
- **Lead assignment CRUD**: nothing equivalent found on master. Appears cleanly
  additive, pending confirmation no in-flight uncommitted file on master already
  covers it under an unexpected name.
- **General `crm_tasks` CRUD route**: nothing equivalent found on master (only
  internal writes from `replies.ts`/`dealHealth.ts`). Appears cleanly additive.

### Track 4 — activity timeline, workflow stepper
- **`activityTimeline.ts`**: master already has one, committed, 216 lines — needs a
  full diff against phase2's version to see which event types each surfaces that the
  other doesn't (e.g. does master's include Listmonk/Chatwoot events that phase2's
  obviously can't, and does phase2's include lead-assignment/qualification events
  that master's can't). Likely outcome: **merge the two source lists into master's
  file**, not keep phase2's file wholesale.
- **Workflow stepper UI**: dashboard-side, lower collision risk, but `App.tsx` and
  `api/types.ts` are both independently modified on both sides (as they were in
  phase2's own internal merges) — expect the same style of trivial additive
  conflicts as before.

## 4. Migration renumbering

Phase2's migrations `288`-`295` occupy numbers that master's own independent
lineage already used for unrelated content (Chatwoot/Listmonk webhooks, RLS). None
of phase2's migrations have ever been applied to any shared/production database —
they exist only inside the `milestone3-phase2` worktree. Renumbering them is safe
*in that specific sense*, but still governed by the "do not blindly renumber" rule,
so each one gets handled individually, not batch-renamed:

| Phase2 migration | Disposition |
|---|---|
| `292_add_outcome_reasons_to_deals.sql` | Verify against master's current `deals` schema first — may be partially/fully redundant |
| `293_create_qualification_settings.sql` | New table, additive, renumber to next free slot after `440` |
| `294_add_possible_duplicate_to_discovered_organizations.sql` | New column, additive, renumber after `440` |
| `295_add_hunter_to_usage_event_types.sql` | **Drop.** Superseded by master's `440_extend_usage_events_hunter_types.sql`, which is both earlier-merged and strictly more complete |

Exact target numbers (`441`, `442`, ...) will be assigned at execution time by
re-running `ls packages/db/migrations | sort -t_ -k1 -n | tail -5` against
master's current state immediately before writing each file, per the project's
existing migration-coordination convention — not reserved speculatively here, since
master's working tree is still changing.

## 5. Proposed execution structure (for after this plan is approved)

Given the scale-mismatch finding in §2, "3 parallel tracks" porting independent
pieces is the wrong shape for this specific job — the work is overwhelmingly
*diff-and-decide per overlapping file*, which has sequential dependencies (e.g.
qualification-settings wiring depends on first confirming what `leadPromotion.ts`
currently does). Proposed split, still parallelizable but along audit boundaries
rather than build boundaries:

1. **Agent 1 — Provider layer**: diff Google/Apollo/Hunter implementations and
   credential resolution between the two trees; rebuild `providerCostReporting.ts`
   against master's Hunter event-type scheme; drop migration 295; rewire credential
   resolution through master's `credentialEncryption.ts`/`integrations.ts`.
2. **Agent 2 — CRM/qualification layer**: diff `deals.ts` and `leadPromotion.ts`
   between trees; port only `qualification_settings` (table + CRUD + threshold
   wiring) and lead-assignment CRUD and general `crm_tasks` CRUD, confirmed
   non-duplicated; do **not** replace master's `deals.ts`/`leadPromotion.ts`
   wholesale.
3. **Agent 3 — Dedup + timeline + dashboard**: port fuzzy-match dedup as an addition
   to master's `dedup.ts`; merge `activityTimeline.ts` event sources (master's ∪
   phase2's, not a replacement); resolve the dashboard-side additive conflicts
   (`App.tsx`, `api/types.ts`, workflow stepper, discovery quality-filter UI).

Each agent works in its own worktree branched from master's current state (snapshot
committed first so the worktree has something to branch from — master's working
tree is dirty and uncommitted, so this snapshot step itself needs explicit handling
and will be proposed, not assumed, at execution time), touches only the files listed
above, and reports findings/diffs before writing anything, consistent with how
Phase 2's own tracks operated.

## 6. Explicitly out of scope / explicitly not done

- No code has been ported, no migration renumbered, no file modified.
- No merge into master, no commit on master, no `git` state-changing command run
  against the primary working tree.
- Sections C-G of the original roadmap: not assessed here, not touched, not
  started.
- No claim about Listmonk/Chatwoot/Postiz integration correctness — this audit only
  establishes that those files exist and are relevant to credential-system
  reconciliation, not that they work.

## 7. Request

This plan surfaces a finding bigger than originally scoped: master likely already
supersedes most of Phase 2 Section B's CRM work. Before execution starts, please
confirm:

1. Proceed with the narrower "diff-and-port-only-the-gaps" plan in §3/§5 (not a
   full merge of all Phase 2 code)?
2. OK to drop migration `295` in favor of master's `440` (means phase2's own
   `providerCostReporting.ts` tests will need updating to the 4-event-type scheme)?
3. OK for Agent 1 to touch `integrations.ts`'s `REAL_PROVIDERS` set (adding
   `"apollo"`/`"google"`) to finish credential-system unification, or should that
   stay out of scope for this pass?
