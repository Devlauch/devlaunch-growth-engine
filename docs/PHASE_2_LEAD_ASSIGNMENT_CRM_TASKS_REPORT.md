# Phase 2 port: lead-assignment CRUD + general crm_tasks CRUD (Agent B2)

## Scope

Ported from `milestone3-phase2` into master's current tree (snapshot branch
`phase2-integration-b2-assignment`):

1. `apps/api/src/lib/leadAssignment.ts` (`assignLead` / `getCurrentAssignment` /
   `getAssignmentHistory`)
2. `apps/api/src/routes/leadAssignments.ts` (assign/reassign + current/history
   endpoints)
3. `apps/api/src/routes/crmTasks.ts` (general CRUD for `crm_tasks`)
4. Router registration in `apps/api/src/app.ts`
5. Tests: `apps/api/test/leadAssignment.test.ts` (ported unit test, unchanged),
   `apps/api/test/leadAssignmentsRoute.test.ts` (new, route-level),
   `apps/api/test/crmTasks.test.ts` (new, route-level)

No migration was written — both tables already exist on master.

## Independent verification (did NOT trust the plan doc's grep alone)

- `grep -rln 'lead_assignments' apps/api/src` on master's current tree: hits in
  `leadPromotion.ts`, `growthAdvisor.ts`, `activityTimeline.ts`,
  `routes/deals.ts`, `routes/leadPromotion.ts`, `routes/growthAdvisor.ts` — all
  of these only *read* `lead_assignments` (e.g. "who is this lead currently
  assigned to" for display/analytics). None of them expose assign/reassign/
  history as a CRUD surface. Confirmed no `routes/leadAssignments.ts` or
  equivalent file exists anywhere on master.
- `grep -rln 'crm_tasks' apps/api/src`: hits in
  `workflow/stages/approvalAndExecution.ts`, `lib/advanceSequences.ts`,
  `lib/activityTimeline.ts`, `lib/crmDashboard.ts`, `lib/salesPipeline.ts`,
  `routes/dealHealth.ts`, `routes/replies.ts` — every one of these only
  `INSERT`s or `SELECT`s `crm_tasks` rows for its own narrow internal purpose
  (sequence call/LinkedIn tasks, stalled-deal follow-ups, reply-handling
  review tasks, dashboard aggregates). None expose a general list/create/
  complete surface. Confirmed no `routes/crmTasks.ts` exists anywhere on
  master.
- Specifically checked the four files flagged in the task brief
  (`dealHealth.ts`, `replies.ts`, `leadPromotion.ts`, `growthAdvisor.ts`) —
  none contain assignment or generic-task CRUD logic beyond what's described
  above.

**Conclusion: the plan doc's finding holds.** Both pieces are genuinely
missing on master and cleanly additive. Nothing was replaced or removed.

## Schema verification

- `packages/db/migrations/279_create_lead_assignments.sql` already exists on
  master (history table: `id, tenant_id, project_id, lead_id,
  assigned_user_id, assigned_by, assigned_at, created_at`). Column names are
  an exact match for what phase2's `leadAssignment.ts` assumes — no
  adaptation needed.
- `packages/db/migrations/049_create_crm_tasks.sql` already exists on master
  (`id, tenant_id, project_id, lead_id, task_type, title, instructions,
  status, due_at, assigned_user_id, sequence_enrollment_id, created_at,
  updated_at`, with the same `task_type`/`status` CHECK constraints phase2's
  `crmTasks.ts` assumes). Column names and constraints are an exact match —
  no adaptation needed.
- Also found `281_create_follow_up_tasks.sql`, a master-native table that
  wraps `crm_tasks` rows with sales-pipeline trigger metadata
  (`stage_stalled`/`meeting_outcome`/`manual`). Left untouched — it is a
  separate, additive concept on top of `crm_tasks`, not a competing
  implementation of general task CRUD, and nothing in the new `crmTasks.ts`
  route touches it.

## Dependency/pattern verification

- `assertActiveTenantMember(tenantDb, tenantId, userId)` still exists in
  `apps/api/src/lib/salesPipeline.ts` with the exact signature phase2's
  `leadAssignment.ts` expects (checks `memberships` for an active row,
  throws `Errors.badRequest` otherwise). No adaptation needed — imported
  as-is.
- `requireAuth` / `requireTenantMembership` middleware signatures,
  `req.tenantDb` / `req.tenantId` / `req.userId` request properties, and the
  `Errors.notFound/badRequest/conflict` helper shape are all unchanged from
  what phase2's routes assume. No adaptation needed.
- Router-registration pattern in `apps/api/src/app.ts`: import the router,
  then `app.use("<path>", mainCors, router)` grouped with the other
  tenant/project-scoped CRM routes. Added:
  - `app.use(".../leads/:leadId/assignments", mainCors, leadAssignmentsRouter)`
  - `app.use(".../crm-tasks", mainCors, crmTasksRouter)`
  both placed immediately after `leadActivityRouter`'s registration, before
  `crmDashboardRouter`.

Net result: both `lib/leadAssignment.ts` and `routes/leadAssignments.ts` /
`routes/crmTasks.ts` were ported **byte-for-byte unchanged** from
`milestone3-phase2` — every dependency they reach for already exists on
master with an identical shape. This is the cleanest of the "cleanly
additive" pieces in the whole reconciliation.

## Compatibility with existing internal writers of `crm_tasks`

`replies.ts` (creates `review_reply` tasks), `advanceSequences.ts` (creates
`call`/`linkedin_message`/`follow_up` tasks from sequence steps), and
`salesPipeline.ts` (creates `follow_up` tasks for stalled deals/meeting
outcomes) all continue to `INSERT`/`SELECT` `crm_tasks` directly and were
**not modified**. The new `crmTasksRouter` is purely an additional surface
(`GET /`, `POST /`, `GET /:taskId`, `PATCH /:taskId/complete`) that reads/
writes the same table with the same columns — a task created internally by
`replies.ts` is fully visible and completable through the new route, and
vice versa. No shared mutable state or column was changed.

## Test results

- Baseline (before this port, full suite): 103 test files passed, 1 skipped;
  999 tests passed, 8 skipped.
- After this port (full suite, `cd apps/api && npx vitest run`):
  **105 test files passed, 1 skipped; 1017 tests passed, 8 skipped.**
  (+2 test files, +18 tests — `leadAssignment.test.ts`'s 5 tests existed in
  the baseline count already as part of this port's staged files before the
  "before" run was taken as a sanity check; the net new route-level test
  files are `leadAssignmentsRoute.test.ts` (7 tests) and `crmTasks.test.ts`
  (11 tests).)
- `npx tsc --noEmit -p .` — clean, no new type errors.
- Zero failures, zero regressions in any pre-existing test file.

## Cross-tenant isolation test evidence

Followed the existing convention from `dealHealth.test.ts`/`deals.test.ts`
(mocked `pg` pool client via `vi.mock("../src/db/pool.js", ...)`, queued
query responses, asserted HTTP status) plus the dedicated
`tenantMiddleware.test.ts` pattern for the membership-denial case:

- `leadAssignmentsRoute.test.ts`:
  - `"denies access with 403 when the caller has no active membership for
    the requested tenant"` — simulates a user from tenant B hitting tenant
    A's assignment endpoint; `requireTenantMembership`'s membership lookup
    returns 0 rows, request is rejected with 403 before any assignment logic
    runs.
  - `"404s on GET /current when the lead does not exist in this
    tenant/project"` — a lead-existence check scoped by `tenant_id`/
    `project_id` returns 0 rows (simulating the lead actually belonging to a
    different tenant), yields 404, not a leak of another tenant's data.
  - `"the lead-existence query scopes by tenant_id..."` — directly asserts
    the SQL bind parameters passed to the `FROM leads` query are exactly
    `[LEAD_1, TENANT_A, PROJECT_1]` and never include `TENANT_B`, i.e. the
    isolation is structural (every query is parameterized on the caller's
    own `req.tenantId`), not just incidentally enforced by test setup.
  - Additional coverage: rejecting assignment to a non-tenant-member user
    (`assertActiveTenantMember`), successful assign + audit log, UUID
    validation, full history retrieval.

- `crmTasks.test.ts`:
  - `"denies access with 403 when the caller has no active membership..."` —
    same membership-denial pattern as above.
  - `"404s on GET /:taskId when the task belongs to a different
    tenant/project"` — scoped query returns 0 rows.
  - `"every task query scopes by tenant_id..."` — asserts the `FROM
    crm_tasks WHERE id` query's bind parameters are exactly `[TASK_1,
    TENANT_A, PROJECT_1]`, never `TENANT_B`.
  - Additional coverage: list with status filter + invalid-filter
    rejection, create + lead-ownership check (404 if `leadId` isn't in the
    caller's tenant/project), invalid `taskType` rejection, complete
    (success/conflict-if-already-completed/404-if-foreign-tenant).

All of the above pass. Combined with the pre-existing, unmodified
`tenantMiddleware.test.ts` (which independently covers
`requireTenantMembership`'s 403 behavior at the middleware level, reused by
every route including these two new ones), tenant isolation for both new
surfaces is verified both structurally (parameterized queries scoped to
`req.tenantId`) and behaviorally (HTTP-level 403/404 assertions).

## Out of scope / not touched

- `deals.ts`, `leadPromotion.ts`, `qualification_settings` — Agent B1's
  scope, untouched.
- `dedup.ts`, `discovery.ts`, `activityTimeline.ts`, dashboard files,
  provider files, `credentialEncryption.ts`, `integrations.ts` — untouched.
- No migration added or renumbered (none needed).
- No merge into `phase2-integration` or `master`.

## Commit

Committed on branch `phase2-integration-b2-assignment`. Work stops here per
instructions — no merge performed.
