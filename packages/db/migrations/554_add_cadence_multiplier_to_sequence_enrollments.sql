-- Up Migration
--
-- Closes a real gap flagged for Phase 6a (AI sales engine: lead
-- qualification + personalized follow-ups): qualification scoring
-- (scoring_rubrics/lead_scores, 032_create_lead_scores.sql) and sequence
-- cadence (sequence_steps.day_offset, 047_create_sequence_steps.sql) had no
-- link between them at all — a highly-qualified lead and a barely-qualified
-- one waited the exact same number of days for every step. `cadence_multiplier`
-- is set once, at enrollment time (see routes/sequences.ts's POST
-- .../enrollments, which calls the same evaluateQualification() concept
-- promote-to-CRM already uses via lib/leadPromotion.ts's new
-- computeCadenceMultiplier()) from the lead's CURRENT lead_scores /
-- leads.status at the moment of enrollment — it is a snapshot, not
-- recomputed automatically as the lead's score changes later, since
-- re-pacing an in-flight enrollment on every future score change is a
-- separate product decision intentionally left open, not solved here.
--
-- advanceSequences.ts's "due" check becomes
-- `now() >= enrolled_at + (day_offset * cadence_multiplier) days`: a
-- multiplier < 1 fires steps sooner than the sequence's authored cadence
-- (more frequent follow-ups for better-qualified leads), 1 (the default,
-- applied to every existing row) leaves existing/unscored leads' pacing
-- completely unchanged.
ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS cadence_multiplier numeric NOT NULL DEFAULT 1
  CONSTRAINT sequence_enrollments_cadence_multiplier_positive CHECK (cadence_multiplier > 0);

-- Down Migration

ALTER TABLE sequence_enrollments
  DROP COLUMN IF EXISTS cadence_multiplier;
