-- Up Migration
--
-- Phase 2 reconciliation port (Agent C1, dedup track): dedup.ts's
-- exact-normalized matching (domain, then name) already catches a lot of
-- near-miss cases "for free" via normalizeOrgName()'s suffix/punctuation
-- stripping, but it cannot catch two real gaps: a genuinely different
-- domain for the same company (e.g. "acme.com" vs "acme.io"), or a name
-- that differs by more than a legal suffix (a dropped/added word, a
-- leading article, a minor typo). A new fuzzy name-similarity tier
-- (dedup.ts's findPossibleDuplicateOrganization, Levenshtein + token-overlap
-- based) flags these for human review rather than auto-merging — per
-- explicit product rule, only an exact match may ever auto-dedupe; a fuzzy
-- match is always a human decision, never written automatically by this
-- migration or by dedup.ts itself.
--
-- Renumbered from milestone3-phase2's migration 294 (same column, same
-- intent) to the next free slot on master as of this port — master's own
-- lineage had already used 294 for unrelated content, and had independently
-- advanced migrations up to 440 by the time this was ported. Confirmed via
-- `ls packages/db/migrations | sort -t_ -k1 -n | tail -5` immediately before
-- writing this file (see PHASE_2_DEDUP_PORT_REPORT.md for the exact
-- tail output at that time). Confirmed apps/api/src/routes/discovery.ts has
-- no pre-existing equivalent column/flag under a different name as of this
-- port (grepped for "possible_duplicate"/"duplicate" — only the existing
-- exact-match "duplicate": true/false response field and the "duplicate"
-- status enum value were found, neither of which is this column).
--
-- Nullable self-reference, SET NULL on delete of the referenced row (never
-- cascades a delete across two otherwise-independent organizations just
-- because one flagged the other). NULL means "no possible duplicate
-- flagged" (the overwhelming majority of rows, including every existing row
-- as of this migration — backfilled to NULL, never guessed).
ALTER TABLE discovered_organizations
  ADD COLUMN possible_duplicate_of uuid REFERENCES discovered_organizations (id) ON DELETE SET NULL;

COMMENT ON COLUMN discovered_organizations.possible_duplicate_of IS
  'Set when the fuzzy name-similarity tier (dedup.ts findPossibleDuplicateOrganization) found a close-but-not-exact match to another discovered_organizations row at insert time. Flags for human review only — never auto-merged, never used to skip insertion.';

CREATE INDEX idx_discovered_organizations_possible_duplicate_of
  ON discovered_organizations (possible_duplicate_of)
  WHERE possible_duplicate_of IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_discovered_organizations_possible_duplicate_of;
ALTER TABLE discovered_organizations DROP COLUMN IF EXISTS possible_duplicate_of;
