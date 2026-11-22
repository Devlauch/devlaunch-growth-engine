# Agent B1 — CRM/Qualification Selective Port Report

Branch: `phase2-integration-b1-crm`
Worktree: `.claude/worktrees/phase2-integration-b1-crm`
Scope: deals.ts diff vs. master, port of `qualification_settings`, no-auto-deal-creation verification.

## 1. deals.ts diff verdict

Master's `apps/api/src/routes/deals.ts` (304 lines, committed) wins overall, as expected — it has a richer route surface (`GET /customers` over the `customers` view, `POST /assignments`, `GET /assignments/:leadId`, `POST /check-stalled`) that phase2's independently-built version doesn't have at all. **Not replaced.**

One genuinely missing piece was found and ported (narrowly, not the whole file):

- **`lost_reason` / `won_reason` columns.** Verified via `packages/db/migrations` that the only migrations touching the `deals` table are `278_create_deals.sql` (initial create) and `283_enable_rls_sales_conversion.sql` (RLS only) — master never added equivalent columns under a different name. This is a genuine gap, not a rename problem, so phase2's migration 292 was ported (renumbered, see §2).
- Ported the validation phase2's deals.ts had: moving a deal to `stage: 'lost'` now requires `lostReason` in the PATCH body (rejected with 400 otherwise); moving to `'won'` accepts an optional `wonReason`. This does **not** add a transition-adjacency restriction (master's deals.ts explicitly documents that any stage can move to any other stage) — it only requires a reason alongside these two specific target stages, exactly like phase2's version did.
- Everything else in phase2's deals.ts (separate `PATCH /:dealId/stage` endpoint, `TERMINAL_DEAL_STAGES` import, its own `createDealSchema`/`updateDealSchema` shapes) was **not** ported — master's single `PATCH /:id` handler already covers stage + value + close date + owner in one call, and folding lostReason/wonReason into that existing schema was the narrower, non-disruptive change.

Files touched: `apps/api/src/routes/deals.ts` (DEAL_COLUMNS, updateDealSchema, PATCH SQL), `packages/db/migrations/441_add_outcome_reasons_to_deals.sql`.

Checked `dealHealth.ts`'s lost-deal analysis (`GET /lost-analysis`, `computeLostDealAnalysis`) — it derives "objection themes" from reply classification, not from a `lost_reason` column, so this addition doesn't conflict with it. It could be a nice future enhancement to correlate `lost_reason` text with reply-classification objection themes, but that's out of this pass's scope and `lostDealAnalysis.ts` was left untouched.

## 2. qualification_settings port (main deliverable)

### Migrations chosen

Ran `ls packages/db/migrations | sort -t_ -k1 -n | tail -5` immediately before writing — highest existing was `440_extend_usage_events_hunter_types.sql`. Chose:

- **`441_add_outcome_reasons_to_deals.sql`** — ported/renumbered from phase2's `292` (see §1).
- **`442_create_qualification_settings.sql`** — ported/renumbered from phase2's `293`. Same shape: one row per `(tenant_id, project_id)` (`UNIQUE(project_id)`), `min_score_to_qualify integer CHECK (0-100)`, `updated_by`, timestamps + `set_updated_at` trigger.
- **`443_enable_rls_qualification_settings.sql`** — new, not in phase2 (phase2 never had this table RLS-protected in the same way master's other tenant tables are). Follows the exact pattern of `439_enable_rls_contact_provenance_events.sql` (`ENABLE`/`FORCE ROW LEVEL SECURITY` + tenant-isolation policy on `tenant_id = current_setting('app.current_tenant_id', true)::uuid`).

**Re-verified immediately before finishing:** `ls packages/db/migrations | sort -t_ -k1 -n | tail -8` still shows `441`/`442`/`443` as the top three with no gaps — no new migration landed on master's working tree during this session's work that would collide. **Agent B2 note:** if you also need a migration slot, re-run that `ls | sort | tail` yourself before writing — don't assume `444` is free without checking, since master's tree is still described as actively changing elsewhere.

### Route

`apps/api/src/routes/qualificationSettings.ts` — ported from phase2's file nearly verbatim (its original design was already clean: `GET` returns `{ qualificationSettings: null }` when unconfigured rather than fabricating a number, `PUT` is a single upsert via `ON CONFLICT (project_id) DO UPDATE`). Mounted in `app.ts` at `/api/v1/tenants/:tenantId/projects/:projectId/qualification-settings`, same tenant/project-scoping and `requireAuth`/`requireTenantMembership` middleware convention as every other route in this file.

### Wiring into leadPromotion.ts (the actual gap-closing change)

- `evaluateQualification(lead, score, threshold = QUALIFIED_SCORE_THRESHOLD)` — added a third, optional parameter. **Default behavior for any caller that omits it is byte-for-byte identical to before** (verified by a dedicated test: "defaults to QUALIFIED_SCORE_THRESHOLD when no explicit threshold is passed"). The `status_qualified` / `score_threshold` / `not_qualified` reason taxonomy and all its branching logic are unchanged — only the number compared against moved from a literal to a parameter.
- Added `getQualificationThreshold(tenantDb, tenantId, projectId): Promise<number>` — looks up `qualification_settings.min_score_to_qualify` for the project; returns `QUALIFIED_SCORE_THRESHOLD` when no row exists. This is the only new DB read; it does not write anything.
- `apps/api/src/routes/leadPromotion.ts`'s `POST .../promote-to-crm` handler now calls `getQualificationThreshold(...)` right after loading the lead's score, and passes the result as `evaluateQualification`'s third argument. One new SELECT per promote-to-crm call; no change to the rest of the handler's logic (company/contact/assignment creation, audit event).

**Deliberately NOT changed:** the five other files that each keep their own local copy of `QUALIFIED_SCORE_THRESHOLD = 50` (`apps/api/src/lib/funnelDropoff.ts`, `growthRevenueAnalytics.ts`, `reportGenerator.ts`, `apps/api/src/routes/analytics.ts`, and a comment reference in `nextBestAction.ts`) — these compute analytics/reporting numbers, not the CRM-promotion gate, and wiring them to the configurable per-project threshold too was out of this pass's scope (the task spec named `leadPromotion.ts`'s `evaluateQualification()` specifically). **Flagging for the orchestrator/B2:** if "configurable qualification threshold" is meant to be reflected consistently in analytics/reporting as well as the CRM gate, that's a separate, larger follow-up — those five call sites would need the same `getQualificationThreshold()` lookup threaded through, which none of this pass's acceptance criteria asked for.

## 3. No-auto-deal-creation rule — verified intact

Read `apps/api/src/lib/leadPromotion.ts` and `apps/api/src/routes/leadPromotion.ts` in full before touching them. Confirmed:

- `findOrCreateCompanyForLead`, `findOrCreateContactForLead`, `assignLeadToUser`, `autoAssignLeadRoundRobin` — none of these issue `INSERT INTO deals` or touch the `deals` table at all. The only writes from a promote-to-crm call are to `companies`, `contacts`, `lead_assignments`, and `audit_events`.
- `requireQualifiedOrOverride` only throws/doesn't-throw; it performs no writes.
- Grepped the whole `apps/api/src` tree for `evaluateQualification`/`requireQualifiedOrOverride`/`QUALIFIED_SCORE_THRESHOLD` call sites — all five other references are in analytics/reporting files that only ever `SELECT`, never `INSERT`.

**Rule holds: qualification alone — whether met via `status = 'qualified'`, the hardcoded default threshold, or a project's configured `qualification_settings` threshold — never creates a `deals` row.** Added an explicit regression test for this (`apps/api/test/leadPromotion.test.ts`, "promotes against a project-configured threshold instead of the hardcoded default") asserting `queryMock.mock.calls.some(([sql]) => sql.includes("INSERT INTO deals"))` is `false` for a promotion driven entirely by crossing a configured threshold. No approval-required finding here — master's existing code already respects this invariant; this port doesn't change it.

## 4. Contacts/companies compatibility (item 4 in the brief)

`findOrCreateCompanyForLead`/`findOrCreateContactForLead` in `leadPromotion.ts` already target the current `companies`/`contacts` schema (real FK columns, `company_id`/`lead_id`, not phase2-era assumptions) — this predates my changes and needed no adjustment. The qualification_settings port doesn't touch `companies`/`contacts`/`deals` row shapes at all, only reads one new config table, so nothing here was at risk of a schema mismatch.

## 5. Test results

- **Before any change:** `102 files passed | 1 skipped (103)`, `994 tests passed | 8 skipped (1002)`.
- **After all changes:** `103 files passed | 1 skipped (104)`, `1009 tests passed | 8 skipped (1017)`.
- Net new: +15 tests (3 in `deals.test.ts` for lost/won reason validation, 7 in `leadPromotion.test.ts` for configurable-threshold behavior + the no-auto-deal-creation regression test, 5 in new `qualificationSettings.test.ts`).
- `npx tsc --noEmit` in `apps/api`: clean, no errors.
- Ran the three directly-touched files in isolation too: `deals.test.ts` (13 tests), `leadPromotion.test.ts` (26 tests), `qualificationSettings.test.ts` (5 tests) — all passing.

## 6. Files changed/added

Modified:
- `apps/api/src/app.ts` — mounted `qualificationSettingsRouter`.
- `apps/api/src/lib/leadPromotion.ts` — `evaluateQualification` threshold param + `getQualificationThreshold`.
- `apps/api/src/routes/deals.ts` — `lost_reason`/`won_reason` columns, validation, PATCH SQL.
- `apps/api/src/routes/leadPromotion.ts` — calls `getQualificationThreshold` before `evaluateQualification`.
- `apps/api/test/deals.test.ts` — 3 new tests.
- `apps/api/test/leadPromotion.test.ts` — inserted the new qualification_settings query mock into every existing test that reaches `evaluateQualification`, plus 7 new tests.

Added:
- `apps/api/src/routes/qualificationSettings.ts`
- `apps/api/test/qualificationSettings.test.ts`
- `packages/db/migrations/441_add_outcome_reasons_to_deals.sql`
- `packages/db/migrations/442_create_qualification_settings.sql`
- `packages/db/migrations/443_enable_rls_qualification_settings.sql`

## 7. Left for Agent B2 / orchestrator

- **Migration numbering:** I claimed `441`, `442`, `443`. Please re-check for collisions against whatever B2 adds before merging — I did not coordinate live with B2.
- **Lead-assignment CRUD and general `crm_tasks` CRUD route** are explicitly B2's job; I did not touch them. (`leadPromotion.ts`'s `assignLeadToUser`/`autoAssignLeadRoundRobin` already exist on master and I didn't modify them, only added one extra query ahead of them in the promote-to-crm handler.)
- **Analytics/reporting threshold consistency** (see §2) — the five other `QUALIFIED_SCORE_THRESHOLD` copies in analytics/reporting files are still hardcoded at 50 and not wired to `qualification_settings`. Flagging as a scoping question for whoever owns the overall qualification-settings feature decision, not something I changed unilaterally.
- **`lostDealAnalysis.ts` / `dealHealth.ts`** could eventually use `lost_reason` text as an additional signal alongside reply-classification objection themes — not done here, out of scope, noted as a possible follow-up only.

No merge performed into `phase2-integration` or `master`. Work committed on `phase2-integration-b1-crm` only.
