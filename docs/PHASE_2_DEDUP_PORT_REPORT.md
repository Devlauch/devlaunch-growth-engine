# Phase 2 Dedup Port Report (Agent C1)

Branch: `phase2-integration-c1-dedup`
Worktree: `.claude/worktrees/phase2-integration-c1-dedup`
Base snapshot: commit `ce49eaf` ("Snapshot of master working tree at reconciliation start")

## Scope actually touched

- `apps/api/src/lib/dedup.ts` — added the fuzzy/Levenshtein dedup tier.
- `apps/api/test/dedup.test.ts` — added fuzzy-tier tests, including an
  explicit flag-only/never-auto-merge contract test.
- `packages/db/migrations/441_add_possible_duplicate_to_discovered_organizations.sql`
  — new migration (renumbered from phase2's `294`).

No other file was modified. `discovery.ts`, `prospectingCampaigns.ts`,
`DiscoveryPage.tsx`, and all dashboard files were read-only (one grep pass
over `discovery.ts`) or not touched at all.

## 1. dedup.ts port details

Master's `dedup.ts` (227 lines at snapshot time) already contains the
exact-match tier: `normalizeDomain`, `normalizeOrgName`, `normalizeEmail`,
`normalizeContactName`, `findDuplicateOrganization`, `findDuplicateContact`.
Notably, master's `findDuplicateContact` is **already better** than
phase2's own version of the same function — master's name-fallback query
normalizes case/whitespace via SQL (`lower(regexp_replace(trim(name), '\s+',
' ', 'g'))`), with a regression test proving it; phase2's version does a
verbatim `name = $2` comparison. I did not touch `findDuplicateContact` at
all — master's version wins outright, per the reconciliation plan's "master
usually wins on overlapping functions" guidance, and this function isn't
even in my port scope (only the fuzzy additions are).

Ported as pure **additions**, inserted between `findDuplicateOrganization`
and the (pre-existing) `normalizeContactName`/`findDuplicateContact` section
so the exact-tier code block stays contiguous and untouched:

- `levenshteinDistance(a, b)` — exported, classic O(a·b) time / O(b) space
  rolling-row edit distance.
- `levenshteinSimilarity` (internal) — distance normalized to 0-1.
- `tokenOverlapSimilarity` (internal) — Jaccard similarity over whitespace
  tokens, catches word-reordering/dropped-word cases Levenshtein scores
  poorly.
- `orgNameSimilarity(a, b)` — exported, max of the two signals above.
- `isFuzzyOrgNameMatch(normalizedA, normalizedB)` — exported, gates on
  `FUZZY_ORG_NAME_MATCH_THRESHOLD = 0.82` and
  `FUZZY_ORG_NAME_MIN_LENGTH = 4`, explicitly false for identical strings
  (that's the exact tier's job) and for too-short names.
- `findPossibleDuplicateOrganization(tenantDb, projectId, org, excludeOrganizationId?)`
  — exported, tier-2 check: pulls up to `FUZZY_CANDIDATE_SCAN_LIMIT = 500`
  same-project candidates (newest-first), scores each in JS, returns the
  single best-scoring match above threshold or `null`.

This is a byte-for-byte port of phase2's logic (I diffed it against
`.claude/worktrees/milestone3-phase2/apps/api/src/lib/dedup.ts` — identical
algorithm, thresholds, and comments), dropped into master's file structure
unchanged. No behavior was altered from what Track 2 originally built.

### Flag-only / never-auto-merge — hard requirement, test evidence

`findPossibleDuplicateOrganization` only ever **reads** (`tenantDb.query`
with a `SELECT`) and returns a plain `{ id, name, domain }` object; it has
no code path that writes, updates, deletes, or merges anything. This was
true in phase2's original and is unchanged here. I added a dedicated test
(`apps/api/test/dedup.test.ts`, describe block "findPossibleDuplicateOrganization",
test `"never auto-merges or writes on a fuzzy match — flag-only contract"`)
that:

1. Passes a mock DB object typed as `Pick<PoolClient, "query">` with
   **only** a `query` method present (no `insert`/`update`/transaction
   helper exists on the mock at all, so any attempt to write would throw).
2. Feeds in a candidate that clearly clears the fuzzy threshold (so the
   function *does* find a match — this isn't a vacuous "nothing happened"
   test).
3. Asserts every SQL string issued matches `/^\s*SELECT/i` and does **not**
   match `/\b(INSERT|UPDATE|DELETE|MERGE)\b/i`.
4. Asserts the returned match is a plain data object with exactly the keys
   `id`/`name`/`domain` — not a handle, promise, or anything with
   write-capable methods attached.

This test passed (see test results below). Any future change that tried to
make this function or a same-call caller auto-merge would fail this test
immediately.

The actual **write** of `possible_duplicate_of` (when a caller decides to
act on a flagged match) is left entirely to the route layer — see §3 below
for what I'm leaving for Agent C3.

## 2. Migration: `possible_duplicate_of` column

- Checked current tail immediately before writing:
  `ls packages/db/migrations | sort -t_ -k1 -n | tail -5` →
  `437_add_hunter_to_integrations.sql`,
  `438_create_contact_provenance_events.sql`,
  `439_enable_rls_contact_provenance_events.sql`,
  `440_extend_usage_events_hunter_types.sql`. Next free number: **441**.
  Re-ran the same command again right before finalizing this report —
  still topped out at `440` plus my own new `441` file, no collision from a
  concurrent writer.
- Checked `apps/api/src/routes/discovery.ts` for a pre-existing equivalent
  column/flag under a different name: grepped for `possible_duplicate` and
  `duplicate` (case-insensitive). Found only the existing exact-match
  response shape (`{ organization, duplicate: true }` / `{ duplicate: false }`)
  and the `discovered_organizations.status` enum's `'duplicate'` value
  (from migration `027_create_discovered_organizations.sql`, unrelated —
  that's a status the org itself can be set to, not a pointer to which row
  it duplicates). **No collision** — master has no equivalent
  `possible_duplicate_of`-style column or flag anywhere.
- New file:
  `packages/db/migrations/441_add_possible_duplicate_to_discovered_organizations.sql`.
  Same column/index/comment as phase2's migration `294`
  (`ADD COLUMN possible_duplicate_of uuid REFERENCES discovered_organizations (id)
  ON DELETE SET NULL`, partial index `WHERE possible_duplicate_of IS NOT NULL`),
  renumbered and with an updated header comment explaining the renumbering
  and the discovery.ts collision check performed.
- Did not run this migration against any database (no live DB available in
  this worktree task); it is additive/backward-compatible (nullable column,
  `DROP COLUMN IF EXISTS` in the down migration) and should be safe to apply
  whenever the orchestrator runs the full migration set.

## 3. Left for Agent C3 / the orchestrator

I did **not** touch `discovery.ts` beyond reading it to check for a column
collision (step above). Per my scope, I'm flagging rather than doing this
myself since C3 is actively working in that file:

- **No route currently calls `findPossibleDuplicateOrganization` or writes
  `possible_duplicate_of`.** The function exists and is tested in
  isolation, but nothing wires it into the discovery flow yet. Agent C3 (or
  whoever owns `discovery.ts` next) needs to, at the point where a new
  organization is inserted (near the existing `findDuplicateOrganization`
  call around line 606 of `discovery.ts` in this worktree's snapshot):
  1. After `findDuplicateOrganization` returns `null` (i.e. no exact
     match — only then, never instead of it) and after the row is
     inserted, call `findPossibleDuplicateOrganization(tenantDb, projectId,
     { name }, newOrgId)` to get a candidate.
  2. If non-null, `UPDATE discovered_organizations SET possible_duplicate_of
     = $1 WHERE id = $2` on the **new** row (not the candidate) — this is
     the one explicit, deliberate write that turns a flag into a persisted
     column value; it is not something `dedup.ts` does itself.
  3. Optionally surface a new read endpoint (e.g.
     `GET /projects/:projectId/discovered-organizations/possible-duplicates`
     or a `possibleDuplicateOf`/`possibleDuplicate` field added to the
     existing list/detail response) so the dashboard can show a "possible
     duplicate — review" affordance. I have not built this endpoint myself
     since it lives in `discovery.ts`, which is C3's file.
- The dashboard UI to actually display/resolve a flagged possible-duplicate
  (approve-as-duplicate / dismiss) is entirely C3's scope per the original
  task split (quality filters/bulk-import/analytics/dashboard UI) — not
  attempted here.

## 4. Snapshot instability note (per the audit warning)

The task brief warned that master's own `dedup.ts` may have been mid-edit
in a concurrent live session at audit time, and that the version frozen
into this worktree's snapshot (`ce49eaf`) might differ from what Phase 2
last saw and from whatever the live session eventually commits.

What I found: the snapshot's `dedup.ts` (227 lines) matches the
reconciliation plan's description exactly ("exact/normalized matching
only") and its `findDuplicateContact` contains a specific, deliberate fix
(SQL-side case/whitespace normalization on the name-fallback query, with a
matching regression test already in `dedup.test.ts`) that is **more
advanced** than phase2's own independently-built equivalent. This reads as
genuine, intentional, already-tested work, not a half-finished edit — i.e.
there's no sign of truncation, syntax breakage, or an obviously-mid-edit
state in the functions I touched or read.

That said, I did **not** modify `normalizeDomain`, `normalizeOrgName`,
`normalizeEmail`, `normalizeContactName`, `findDuplicateOrganization`, or
`findDuplicateContact` at all — only inserted new, independent
functions/constants between `findDuplicateOrganization` and
`normalizeContactName`. If the live session's eventual commit changes any
of those six pre-existing functions (e.g. further tweaks the suffix list,
the domain regex, or the name-fallback query), my addition should merge
cleanly as a non-overlapping insertion — but a human should still re-diff
`apps/api/src/lib/dedup.ts` against the live session's final commit before
trusting this port is still a clean superset, specifically checking that:
  - The insertion point (immediately after `findDuplicateOrganization`,
    immediately before `normalizeContactName`) wasn't itself where the live
    session was mid-edit.
  - No duplicate symbol names were introduced (I confirmed only one
    `DuplicateOrganizationMatch` and one `DuplicateContactMatch` interface
    exist post-port; phase2's own file had drifted into defining
    `DuplicateContactMatch` differently in `discovery.ts`'s usage, but that
    wasn't an issue here since I didn't touch `discovery.ts`'s types).

## 5. Test results

Baseline (`npx vitest run`, before any change), full suite:
```
Test Files  102 passed | 1 skipped (103)
     Tests  994 passed | 8 skipped (1002)
```

After the port, full suite:
```
Test Files  102 passed | 1 skipped (103)
     Tests  1009 passed | 8 skipped (1017)
```

`dedup.test.ts` alone, after the port:
```
✓ test/dedup.test.ts (22 tests) 69ms
Test Files  1 passed (1)
     Tests  22 passed (22)
```

Net: +15 tests, all passing (7 → 22 in `dedup.test.ts`), zero regressions
anywhere else in the suite. `npx tsc --noEmit -p .` also ran clean (no
output) after the change.

## Commit

Committed on branch `phase2-integration-c1-dedup`. Per instructions, I have
not merged into `phase2-integration` or `master`.
