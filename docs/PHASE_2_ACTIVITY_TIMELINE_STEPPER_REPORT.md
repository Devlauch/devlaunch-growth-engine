# Phase 2 Activity Timeline + Workflow Stepper — Agent C2 Report

Branch: `phase2-integration-c2-timeline` (worktree
`.claude/worktrees/phase2-integration-c2-timeline`), branched from the
`ce49eaf` snapshot of master's working tree. Commit: `a4f35fc`.

## 1. Event-type union table

Master's `apps/api/src/lib/activityTimeline.ts` (216 lines, already committed)
and phase2's independently-built version (403 lines) were diffed in full
before any edit. Result:

| Event | Master (before) | Phase2 | Disposition |
|---|---|---|---|
| `assignment` (lead_assignments) | Yes | Yes, as `lead_assigned` | **Kept master's**, same table/columns, same semantics. Not duplicated. |
| `stage_change` (deals, latest transition) | Yes | Yes, as `deal_stage` | **Kept master's**. Phase2's `deal_stage` additionally carried `wonReason`/`lostReason` — **not ported**, see §3. |
| `meeting` | Yes | No (phase2 has no meetings table/concept) | Unchanged, master-only. |
| `task` (crm_tasks, latest status) | Yes | Yes, as `crm_task_status` (completed/skipped only) | **Kept master's** single "current status" item; did not also add a separate `crm_task_status` kind — same single real column (`updated_at`), would have been the same fact under two labels. |
| `note` | Yes | No | Unchanged, master-only. |
| `reply` (lead_replies) | Yes | No | Unchanged, master-only. |
| `lead_created` | **No** | Yes | **Added.** Genuine gap — master never surfaced the lead's own creation. |
| `lead_scored` (lead_scores) | **No** | Yes | **Added.** `lead_scores` table exists on master (032_create_lead_scores.sql) with matching columns; was never queried by this file. |
| `deal_created` (deals, creation) | **No** (only latest-stage existed) | Yes | **Added**, as a second item alongside the existing `stage_change` item — not a replacement. |
| `crm_task_created` (crm_tasks, creation) | **No** (only latest-status existed) | Yes | **Added**, as a second item alongside the existing `task` item — not a replacement. |
| `discovery_sourced` | **No** | Yes | **Added**, but query rewritten against master's actual schema (see §3 — phase2's version referenced a junction table and a column that don't exist here). |

Net: master's 6 original types are all retained unchanged; 5 new types added
(`lead_created`, `lead_scored`, `deal_created`, `crm_task_created`,
`discovery_sourced`); 0 phase2 types were dropped as pure duplicates
(`lead_assigned`/`deal_stage`/`crm_task_status` map onto master's existing
`assignment`/`stage_change`/`task` and were not re-added under new names).

## 2. Exactly what was added vs. left alone

**Left alone, verbatim:** the `assignment`, `meeting`, `note`, `reply` query
blocks and the base `stage_change`/`task` query blocks (only `created_at` was
added to each `SELECT`, the existing columns/logic are untouched).

**Added** (all additive, inside the same function, same `Promise.all`
pattern):
- A new sequential `leadResult` query (before the `Promise.all`) reading
  `leads.source/origin/custom_fields/created_at` — backs `lead_created` and
  detects discovery provenance. Tolerant of 0 rows (never throws; the route
  already does its own existence check, this is defense-in-depth per the
  file's existing convention).
- A 7th parallel query for `lead_scores` — backs `lead_scored`.
- `deals` and `crm_tasks` queries gained `created_at` in their `SELECT`; each
  loop now pushes both the pre-existing item and a new `*_created` item.
- A conditional, sequential discovery-provenance query, issued only when
  `leads.custom_fields.discoveredOrganizationId` is present (same convention
  `apps/api/src/routes/discovery.ts`'s promote-to-lead endpoint uses — verified
  by reading that route, not assumed).

**Schema adaptation for `discovery_sourced`** (important divergence from
phase2's version): phase2's query joined through a
`prospecting_campaign_organizations` junction table and read
`discovered_contacts.source_provider`. **Neither exists on this tree.**
Master's actual schema (326_create_prospecting_campaigns.sql) links a
discovered org to its campaign via a direct
`discovered_organizations.prospecting_campaign_id` FK, and
`discovered_contacts` has no `source_provider` column at all. The ported query
was rewritten to join `discovered_organizations` -> `discovery_sources` (for
`name`/`connector_type`) -> `prospecting_campaigns` (for `name`) using the real
columns, and drops the fabricated `source_provider` field entirely rather than
guessing at one.

Full rationale for every decision is documented in the file's own header
comment (`apps/api/src/lib/activityTimeline.ts`), under "Phase 2
reconciliation additions (Agent C2)".

## 3. Flagged as dependent on B1/B2's unmerged work (not ported)

- **`deal_stage` won/lost reason**: phase2's `deal_stage` item reads
  `deals.lost_reason`/`deals.won_reason`. **Neither column exists** on this
  tree's `deals` table (`278_create_deals.sql` has no such columns — verified
  by reading the migration directly). Per the reconciliation plan, this is
  exactly the kind of column Agent B1/B2's deals/qualification work may or may
  not add via their own migration. **Not referenced anywhere in this file.**
  Follow-up: once all 7 branches land, check whether `deals` gained these
  columns and, if so, extend the existing `stage_change` item's `detail` to
  include them — do not add a new item kind for it.
- **`qualification_settings`-driven events**: no such table exists in this
  worktree snapshot (Agent B1's work). Nothing in this file references it.
- **Lead assignment / `crm_tasks` CRUD routes**: the underlying tables
  (`lead_assignments`, `crm_tasks`) already exist on master and were already
  read by this file before my pass — no dependency there. If Agent B2's CRUD
  work changes column names/shapes, a follow-up diff against this file's
  `SELECT`s is the only thing that would need revisiting.

## 4. Workflow stepper UI port

Master's dashboard **already has** a stepper pattern — `.steps`/`.step`/
`.step-done`/`.step-check` CSS classes and a live usage in
`apps/dashboard/src/pages/ProjectPage.tsx` (a vertical onboarding checklist:
"Project created" -> "Embed snippet ready" -> ...). This was checked before
assuming the stepper was purely new.

- Added `apps/dashboard/src/components/WorkflowStepper.tsx`: a new component
  for the lead-specific narrative (Prospect -> Scored Lead -> CRM Assignment
  -> Qualified Lead -> Opportunity -> Customer), reusing master's existing
  `.step`/`.step-done`/`.step-check` classes as-is, via a new
  `.steps-horizontal` layout modifier added to `styles.css` (row/wrap instead
  of ProjectPage's column layout) rather than introducing a second, competing
  stepper style or phase2's older CSS.
- Each step's "done" flag is one independent, real signal (not a cascade — see
  the component's header comment): `hasScore` (a `lead_scored` entry present
  in this lead's own activity timeline — i.e. the exact feature this same
  report just extended), `hasAssignment` (an `Assignment` already loaded by
  `LeadDetailPage.tsx`), `qualified` (`lead.status === "qualified"`), `hasDeal`
  (`deals.length > 0`, already loaded), `isCustomer` (`deals.some(stage ===
  "won")` — the same condition that puts a lead in the real `customers` VIEW
  from `278_create_deals.sql`, computed from data already in hand instead of a
  second call to `deals.ts`'s `GET /deals/customers` — `deals.ts` is
  B1/B2-owned and was not touched).
- Wired into **master's existing** `LeadDetailPage.tsx` (master already had
  this page, plus an `ActivityTimeline` component embedded in it) — extended
  rather than building a competing page, per instructions.

## 5. Pre-existing gaps found and handled

While reading the files I was asked to extend, two latent issues surfaced
that were directly in this feature's own dependency chain:

- `apps/dashboard/src/components/ActivityTimeline.tsx` imported
  `../hooks/useLeadActivity`, but **no `hooks/` directory existed anywhere in
  the dashboard app** — `npm run build` failed on this before I touched
  anything. Created `apps/dashboard/src/hooks/useLeadActivity.ts` (the hook
  the component always expected), since this is squarely the file I'm
  extending.
- `ActivityTimeline.tsx`'s `TYPE_LABELS` record was missing a `"reply"` key
  despite `"reply"` being a valid `ActivityItemType` — fixed in passing while
  adding the 5 new labels (same record, same edit).
- Also found and fixed: the component rendered `badge-${item.type}` CSS
  classes (e.g. `badge-assignment`) for which **no CSS rule has ever
  existed** (only the tone-based `badge-neutral/info/success/warn/danger`
  exist) — every item rendered an uncolored badge. Replaced with a
  `TYPE_TONE` map reusing the existing tone classes, extended for all 11
  types. Added matching `.activity-timeline`/`.activity-item*` CSS (also
  previously absent).

**Not fixed, out of scope:** `apps/dashboard/src/components/NotesPanel.tsx`
has the identical problem — it imports `../hooks/useNotes`, which also does
not exist — and this is **not** part of the activity-timeline/stepper feature
(a separate, unrelated notes component). This file is untouched. **This is
the one remaining `npm run build` failure** in the dashboard app; see §6.

## 6. Test / build results

**Before my changes** (baseline, confirmed by running both before editing):
- `cd apps/api && npx vitest run`: 102 test files passed, 1 skipped (995
  tests passed, 8 skipped) — baseline was already green.
- `cd apps/dashboard && npm run build`: **failed**, 3 pre-existing TS errors,
  none caused by me:
  - `ActivityTimeline.tsx(4,75)`: `Cannot find module '../hooks/useLeadActivity'`
  - `NotesPanel.tsx(6,43)`: `Cannot find module '../hooks/useNotes'`
  - `NotesPanel.tsx(95,23)`: implicit `any` on `note` parameter

**After my changes:**
- `cd apps/api && npx vitest run`: **102 test files passed, 1 skipped (995
  tests passed, 8 skipped)** — identical pass count to baseline, no
  regressions. Updated `apps/api/test/leadActivity.test.ts` (new query-count
  assertions for the lead row + `lead_scores` query, plus a new dedicated test
  for `lead_scored`/`discovery_sourced`) and `apps/api/test/meetingPrep.test.ts`
  (inserted the two new queued mock responses `getLeadActivityTimeline` now
  issues) to match the extended query sequence.
- `cd apps/dashboard && npm run build`: **still fails**, but now for exactly
  **one** pre-existing, out-of-scope reason:
  - `NotesPanel.tsx(6,43)`: `Cannot find module '../hooks/useNotes'`
  - `NotesPanel.tsx(95,23)`: implicit `any` on `note` parameter
  - The `useLeadActivity` module-not-found error is **resolved** (the hook
    now exists). Everything this report's files touch — `activityTimeline.ts`,
    `ActivityTimeline.tsx`, `WorkflowStepper.tsx`, `useLeadActivity.ts`,
    `LeadDetailPage.tsx`, `styles.css` — type-checks cleanly; the remaining
    two errors are entirely inside `NotesPanel.tsx`, a file this task's scope
    never included.
  - **Action for the orchestrator**: whichever agent owns `NotesPanel.tsx` /
    notes needs to add its own `hooks/useNotes.ts` (same missing-hooks-dir
    pattern this report already fixed for activity) before
    `apps/dashboard`'s build goes fully green across all 7 branches merged.

## 7. Files touched

- `apps/api/src/lib/activityTimeline.ts` — extended (not replaced).
- `apps/api/test/leadActivity.test.ts` — updated + 1 new test.
- `apps/api/test/meetingPrep.test.ts` — updated mock sequences.
- `apps/dashboard/src/components/ActivityTimeline.tsx` — extended labels/tones, fixed pre-existing gaps.
- `apps/dashboard/src/components/WorkflowStepper.tsx` — new.
- `apps/dashboard/src/hooks/useLeadActivity.ts` — new (fills a pre-existing gap).
- `apps/dashboard/src/pages/LeadDetailPage.tsx` — extended (stepper wired in).
- `apps/dashboard/src/styles.css` — additive CSS only (`.steps-horizontal`, `.step-hint`, `.activity-timeline`/`.activity-item*`).

Not touched (per scope): `apps/api/src/lib/dedup.ts`, `discovery.ts`,
`prospectingCampaigns.ts`, `DiscoveryPage.tsx`, `deals.ts`, `leadPromotion.ts`,
qualification_settings, lead assignment/crm_tasks backend logic, provider
files, `credentialEncryption.ts`, `integrations.ts`, `NotesPanel.tsx`/`useNotes`.

Stopping here per instructions — no merge into `phase2-integration` or
`master` was performed.
