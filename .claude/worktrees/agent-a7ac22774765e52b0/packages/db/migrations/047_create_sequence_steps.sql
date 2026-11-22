-- Up Migration
--
-- sequence_steps: the individual, ordered steps of a sequence (046_create_
-- sequences.sql) — e.g. step_order 0 / day_offset 0 "email", step_order 1 /
-- day_offset 3 "call_task", step_order 2 / day_offset 7 "follow_up_email",
-- step_order 3 / day_offset 14 "final_note".
--
-- day_offset is "days after enrollment this step fires" (not an absolute
-- date): apps/api/src/lib/advanceSequences.ts compares
-- now() >= sequence_enrollments.enrolled_at + day_offset * interval '1 day'.
--
-- message_draft_variant_channel names which message_draft_variants.channel
-- (see the message_drafts/message_draft_variants contract introduced
-- alongside roadmap items 9/12) this step's copy should be pulled from, when
-- the step has pre-drafted copy (e.g. an 'email' step pulls from the
-- 'email' channel variant). It is nullable because a pure task step
-- (call_task/linkedin_task) has no pre-drafted message copy of its own —
-- task_instructions covers what the human should do instead.
CREATE TABLE sequence_steps (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  sequence_id                     uuid NOT NULL REFERENCES sequences (id) ON DELETE CASCADE,
  step_order                      integer NOT NULL CHECK (step_order >= 0),
  day_offset                      integer NOT NULL CHECK (day_offset >= 0),
  step_type                       text NOT NULL CHECK (step_type IN ('email', 'call_task', 'linkedin_task', 'follow_up_email', 'final_note')),
  message_draft_variant_channel   text CHECK (message_draft_variant_channel IN ('email', 'whatsapp', 'call_script', 'linkedin_note')),
  task_instructions               text,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sequence_steps_sequence_order_key UNIQUE (sequence_id, step_order)
);

CREATE INDEX idx_sequence_steps_sequence_id ON sequence_steps (sequence_id);

-- Down Migration

DROP TABLE IF EXISTS sequence_steps;
