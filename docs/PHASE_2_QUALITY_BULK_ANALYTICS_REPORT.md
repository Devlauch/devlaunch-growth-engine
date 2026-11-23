# Phase 2 Reconciliation — Agent C3 Report: Quality Filters, Bulk Review, Campaign Analytics

Scope (per orchestrator assignment): prospect quality filters, bulk review/CRM
import, campaign-level discovery analytics, plus the corresponding dashboard
UI, in worktree `phase2-integration-c3-quality` (branch of the same name),
branched from snapshot commit `ce49eaf`. Dedup (`apps/api/src/lib/dedup.ts`)
is explicitly out of scope (Agent C1's). `activityTimeline.ts`, workflow
stepper UI, `App.tsx`, `api/types.ts` ownership boundaries (Agent C2) were
respected — see "api/types.ts" note below.

## 1. What master already had vs. what was ported

Master's `discovery.ts` (926 lines, pre-change) and `prospectingCampaigns.ts`
(333 lines, pre-change) both already existed, committed, and already more
advanced than the isolated `milestone3-phase2` worktree's versions in most
respects (multi-provider waterfall runs, ICP targeting, Hunter-backed
contact discovery/verification, ranked promote-to-lead, ICP-driven campaign
runs via `lib/prospectingCampaigns.ts`'s `startCampaignRun`/
`getCampaignResultsSummary`). **Master did NOT have**, and this change adds:

1. **Prospect quality filters** on `GET /discovered-organizations` and a new
   `GET /discovered-organizations/contacts` cross-organization contact
   listing with its own quality filters.
2. **Bulk prospect review → CRM import**: `POST
   /discovered-organizations/bulk-promote`.
3. **Campaign-level discovery analytics**: `GET
   /prospecting-campaigns/:id/analytics`.
4. Dashboard UI for all of the above in `DiscoveryPage.tsx` and
   `ProspectingCampaignsPage.tsx`.

Confirming the orchestrator's biggest open question: **`prospectingCampaigns.ts`
already existed on master**, as a real, committed, independently-built
feature (`packages/db/migrations/323_create_prospecting_campaigns.sql`) —
not the "much bigger gap" scenario flagged as a risk. However its **schema
differs substantially** from the isolated `milestone3-phase2` worktree's
version it was being compared against (see §3) — this was not a simple
"add one endpoint to an identical table" job.

## 2. Quality filters ported into `discovery.ts`

Followed `priorityQueue.ts`'s existing query-param pattern exactly (zod
schema with `z.coerce` for numeric query params, a `conditions`/`values`
array built up only for filters actually supplied, parameterized SQL) rather
than inventing a new convention, per the task instructions. No new migration
was needed — every filter maps to a column or join that already exists on
master.

**`GET /discovered-organizations`** (`listDiscoveredOrganizationsQuerySchema`,
`discovery.ts` lines ~478–565 post-change) gained:
- `status` (already existed, unchanged)
- `sourceConfidence` — `o.source_confidence` (`268_add_prospect_discovery_fields.sql`)
- `provider` — `discovery_sources.connector_type`, via `LEFT JOIN discovery_sources ds ON ds.id = o.discovery_source_id`
- `minLeadScore` — a promoted lead's `lead_scores.total_score`, via `LEFT JOIN leads l ON l.custom_fields ->> 'discoveredOrganizationId' = o.id::text` then `LEFT JOIN lead_scores ls ON ls.lead_id = l.id` (same provenance-key join `promote-to-lead` itself writes; an org with no promoted/scored lead never matches, by design, same honesty convention as `priorityQueue.ts`'s `minScore`)

**New `GET /discovered-organizations/contacts`** (`listDiscoveredContactsQuerySchema`)
— a cross-organization contact listing for bulk quality review, since the
only prior contact-listing route was per-organization. Filters:
`verificationStatus`, `sourceConfidence`, `organizationStatus`, `minLeadScore`
(same `discoveredContactId`-keyed join pattern).

**Deliberately NOT implemented, matching the isolated worktree's own
documented reasoning** (verified directly against
`packages/agent-sdk/src/connectors/*.ts` in this tree, not assumed):
- **Employee-count filter**: no connector in this codebase (public-directory/
  Overpass, Apollo) ever writes an employee count into `raw_metadata`.
  Building a filter against a column that's never populated would silently
  return zero results forever — left out rather than faked, per this repo's
  honesty rules.
- **`hasPossibleDuplicate` / `possible_duplicate_of`**: this belongs to Agent
  C1's fuzzy-dedup work on `dedup.ts`, not this change. **The orchestrator
  should check that C1's eventual `possible_duplicate_of` column/filter (if
  it lands) merges cleanly alongside this file's other changes** — I did not
  touch `dedup.ts` or add any dedup-related column/filter.
- **`sourceProvider` filter on contacts**: unlike the isolated worktree
  (which assumed a `discovered_contacts.source_provider` column), master's
  actual `028_create_discovered_contacts.sql` schema has no such column —
  confirmed by reading the migration directly. The organization-level
  `provider` filter (via `discovery_sources.connector_type`) is the closest
  real equivalent and already covers this use case.

## 3. Bulk prospect review → CRM import

Refactored the existing single-item `POST
/discovered-organizations/:id/promote-to-lead` route's body into a shared
`promoteOrganizationToLead(req, projectId, organizationId, discoveredContactId?)`
function (preserves 100% of its existing logic/behavior — verified by the
pre-existing single-item tests still passing unchanged), then added:

**`POST /discovered-organizations/bulk-promote`** — accepts `{ items: [{
organizationId, discoveredContactId? }], 1..200 }`, calls
`promoteOrganizationToLead` per item in a loop, best-effort (not one wrapped
transaction — a bad item doesn't roll back the others), returns `{ results:
[{organizationId, success, leadId? | error?}], succeeded, failed }`. This
*is* "bulk review" in this codebase's own vocabulary — I confirmed there is
no separate "bulk review" endpoint distinct from "bulk promote" in the
isolated worktree either; they're the same feature.

## 4. Campaign-level discovery analytics — schema mismatch found and resolved

This is the part of the task flagged as needing "real diff-and-decide," and
it was necessary: **the isolated `milestone3-phase2` worktree's
`prospectingCampaigns.ts` analytics endpoint was written against a
completely different schema than master's actual, committed one.**

| | isolated worktree | master (this tree) |
|---|---|---|
| Org↔campaign link | separate `prospecting_campaign_organizations` join table | `discovered_organizations.prospecting_campaign_id` column directly (migration 323) |
| Campaign columns | `provider_ids`, `target_prospect_count`, `budget_cents`, `spend_cents_to_date` | `goal`, `icp_profile_id`, `started_at`, `completed_at` — **no budget/spend/target-count columns at all** |
| Campaign status enum | draft/discovering/scoring/ready/sending/completed/cancelled | draft/running/paused/completed |

Porting the isolated endpoint's SQL verbatim would have been silently wrong
(querying a table and columns that don't exist on master). Instead I
rewrote the analytics endpoint's queries against master's real schema:

**New `GET /prospecting-campaigns/:id/analytics`**
(`apps/api/src/routes/prospectingCampaigns.ts`) returns:
- `organizations: { total, byStatus }` — grouped `discovered_organizations.status` count, filtered by `prospecting_campaign_id`
- `contacts: { total, byVerificationStatus }` — joined through the campaign's organizations
- `leads: { promotedCount, scoredCount, averageScore, minScore, maxScore, scoreDistribution }` — same `leads.custom_fields ->> 'discoveredOrganizationId'` provenance join `lib/prospectingCampaigns.ts`'s own `getCampaignResultsSummary` already uses, plus a `lead_scores` join for score stats/bucketed histogram (0-25/25-50/50-75/75-100)

**No `spend` section** in the response — master's schema simply doesn't
track `budget_cents`/`spend_cents_to_date`/`target_prospect_count`, so
fabricating one would violate this codebase's honesty rules. This is a
genuine capability gap relative to the isolated worktree's vision, not an
oversight; documented in the endpoint's own doc comment for whoever looks at
this later.

This is additive alongside the existing `GET /:id` → `resultsSummary` (flat
totals, from `getCampaignResultsSummary`) — the new `/analytics` route is a
finer-grained breakdown, not a replacement.

## 5. Dashboard UI

**`DiscoveryPage.tsx`**: added the quality-filter form (status, source
confidence, provider — populated from the project's actually-configured
discovery sources' `connector_type`s, never an invented list — and min lead
score), a checkbox column + "select all eligible" + "Promote selected to
lead (N)" bulk action calling the new bulk-promote endpoint, a
source-confidence badge column, and a bulk-result summary line ("N
promoted, M failed: ..."). Filter changes re-fetch only the organizations
list (`loadOrganizations`), not the whole page.

**`ProspectingCampaignsPage.tsx`** (master has no separate
`ProspectingCampaignDetailPage.tsx` — it's a single list+inline-detail page;
I extended that existing pattern rather than inventing a new route/page):
added a "Discovery analytics" section to the selected campaign's detail
panel — stat cards for promoted/scored/average-score, plus organization
status, contact verification, and lead-score-bucket breakdown lists, loaded
alongside the existing results summary and refreshed after starting a run.

**`Badge.tsx`**: added `sourceConfidenceTone()` and `contactVerificationTone()`
tone-mapping helpers, following the existing `discoveredOrgStatusTone()`/
`statusTone()` pattern exactly.

**`api/types.ts`** (C2-adjacent, minimal/additive only, per instructions):
added `SourceConfidence` type and a `source_confidence` field to the already
-exported `DiscoveredOrganization`/`DiscoveredContact` interfaces (the API
already returned this column via `o.*`/`c.*`; the type was just missing it),
plus one new additive block — `ProspectingCampaignAnalytics` and its two
small row types — placed directly after the existing
`ProspectingCampaignResultsSummary`. No existing field/type was renamed or
removed. **No changes to `App.tsx`** — no new route was needed since the
analytics UI extends the existing inline-detail panel rather than requiring
a new page/route.

## 6. Tests added

- `apps/api/test/discovery.test.ts`: +5 tests — bulk-promote (mixed
  success/failure in one batch, empty-items rejection), quality-filter SQL
  shape (`sourceConfidence`/`provider`/`minLeadScore` conditions + params,
  out-of-range `minLeadScore` rejection), and the new cross-organization
  contacts listing route.
- `apps/api/test/prospectingCampaigns.test.ts`: +3 tests — analytics with
  real data (asserts no fabricated `spend` key), analytics on a
  zero-activity campaign (all-zero/null, not fabricated), 404 for a
  campaign in a different tenant/project.

## 7. Test and build results

**Before my changes** (baseline, confirmed by `git stash` + re-running):
- `apps/api`: 994 tests passed, 8 skipped (102 files passed, 1 skipped) — all passing already.
- `apps/dashboard` build: **already failing**, unrelated to this scope —
  `tsc` errors in `src/components/ActivityTimeline.tsx` and
  `src/components/NotesPanel.tsx` (`Cannot find module '../hooks/useLeadActivity'`,
  `'../hooks/useNotes'`, plus an implicit-any). These are Agent C2's files
  (activity timeline), not touched by me, and were broken in the snapshot
  before I made any change — confirmed by stashing my diff and re-running
  `tsc` on the clean snapshot, which reproduces the identical 3 errors.

**After my changes**:
- `apps/api`: `npx vitest run` → **1002 tests passed, 8 skipped** (102 test
  files passed, 1 skipped). Exact delta: +8 tests (5 in discovery.test.ts, 3
  in prospectingCampaigns.test.ts), all passing, zero regressions.
- `apps/api`: `npx tsc --noEmit -p .` → clean, no errors.
- `apps/dashboard` build (`npm run build` = `tsc --noEmit && vite build`):
  **still fails on the same pre-existing 3 errors**, unchanged from
  baseline, all in files I did not touch
  (`ActivityTimeline.tsx`/`NotesPanel.tsx`). I verified my own 4 changed/new
  dashboard files (`DiscoveryPage.tsx`, `ProspectingCampaignsPage.tsx`,
  `Badge.tsx`, `api/types.ts`) introduce no new type errors: running the
  same `tsc -p tsconfig.json --noEmit` before and after my changes produces
  byte-identical error output (the same 3 lines), so none of my edits
  contributed to the failure and the dashboard cannot be built end-to-end
  by me without touching C2's files, which is out of scope. **The
  orchestrator should flag to Agent C2 (or whoever owns `ActivityTimeline.tsx`
  /`NotesPanel.tsx`) that the dashboard build is currently broken
  independent of this change**, so it doesn't get missed when C2's own
  track reports in.

## 8. On master's discovery.ts snapshot instability (per the audit warning)

The audit flagged that master's own `discovery.ts` was itself
uncommitted/modified in the live concurrent session at audit time, so the
version frozen into this worktree's snapshot (`ce49eaf`) might not match
what the live session ends up committing. **Functions I touched in
`discovery.ts`**, for a human to specifically re-diff against the live
session's eventual commit:
- `listDiscoveredOrganizationsQuerySchema` and the `GET /` handler
  (added filters + two new LEFT JOINs — `discovery_sources`, `leads`/`lead_scores`)
- New: `contactVerificationStatusSchema`, `listDiscoveredContactsQuerySchema`,
  and the new `GET /contacts` handler (inserted directly before the
  pre-existing `POST /` manual-create route)
- Extracted new `promoteOrganizationToLead()` function (body moved
  unchanged from the old single-item route handler — logic itself was not
  modified, only lifted into a reusable function)
- The single-item `POST /:id/promote-to-lead` handler (now calls the
  extracted function; behavior unchanged, verified by its pre-existing
  tests still passing against the refactor)
- New: `bulkPromoteToLeadSchema`, `BulkPromoteItemResult` interface, and the
  new `POST /bulk-promote` handler

Everything else in `discovery.ts` (discovery-source CRUD, waterfall run,
decision-maker lookup, CSV export, manual-create routes, contact
verify/create) is untouched. If the live session's eventual commit changes
any of the five areas above in a conflicting way, those are the exact spots
to re-diff; everywhere else in the file should merge cleanly since it was
never touched here.

`prospectingCampaigns.ts` was not flagged in the audit as independently
modified in the live session (only `discovery.ts` was named), but the same
general caution applies: the new `/:id/analytics` route was inserted
immediately after the pre-existing `GET /:id` handler, touching nothing
else in the file.

## 9. Out of scope / explicitly not touched

- `apps/api/src/lib/dedup.ts` — not read for editing purposes beyond
  confirming (via its existing exports used by `discovery.ts`) that no
  `possible_duplicate_of`-related filter exists yet to port.
- `activityTimeline.ts`, workflow stepper UI, `deals.ts`, `leadPromotion.ts`,
  `qualification_settings`, lead assignment, `crm_tasks`, provider files,
  `credentialEncryption.ts`, `integrations.ts` — not touched.
- No new migration was written (none was needed — every quality filter in
  this scope maps to an already-existing column/join on master).
- `App.tsx` — not touched (no new route needed).

## 10. Commit

All changes committed on branch `phase2-integration-c3-quality`. Not merged
into `phase2-integration` or `master`, per instructions.
