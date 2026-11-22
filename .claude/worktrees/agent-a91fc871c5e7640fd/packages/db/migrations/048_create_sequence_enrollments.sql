-- Up Migration
--
-- sequence_enrollments: a real lead's live progress through a sequence
-- (046_create_sequences.sql / 047_create_sequence_steps.sql).
-- current_step_order tracks the next step still to fire (0-based, matching
-- sequence_steps.step_order); apps/api/src/lib/advanceSequences.ts moves it
-- forward as due steps fire.
--
-- Stop reasons (roadmap item 10: "Stop the sequence automatically on a
-- reply, an unsubscribe, a bounce, or a booked meeting"): status captures
-- exactly which of those happened, or a manual stop. Reaching 'completed'
-- means every step fired; a stopped_* status means the sequence halted
-- early and will not advance further
-- (see POST .../enrollments/:id/stop in routes/sequences.ts).
--
-- The unique constraint enforces "a lead can't be enrolled twice in the
-- same sequence concurrently" at the DB layer; re-enrollment after
-- completion/stop (i.e. inserting a second, independent enrollment row once
-- the first is no longer 'active') is a product decision intentionally left
-- open, not solved here.
CREATE TABLE sequence_enrollments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  sequence_id         uuid NOT NULL REFERENCES sequences (id) ON DELETE CASCADE,
  lead_id             uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped_replied', 'stopped_unsubscribed', 'stopped_bounced', 'stopped_meeting_booked', 'stopped_manual', 'completed')),
  current_step_order  integer NOT NULL DEFAULT 0,
  enrolled_at         timestamptz NOT NULL DEFAULT now(),
  stopped_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sequence_enrollments_sequence_lead_key UNIQUE (sequence_id, lead_id)
);

CREATE TRIGGER trg_sequence_enrollments_set_updated_at
  BEFORE UPDATE ON sequence_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_sequence_enrollments_tenant_id ON sequence_enrollments (tenant_id);
CREATE INDEX idx_sequence_enrollments_sequence_status ON sequence_enrollments (sequence_id, status);
CREATE INDEX idx_sequence_enrollments_lead_id ON sequence_enrollments (lead_id);

-- Down Migration

DROP TABLE IF EXISTS sequence_enrollments;
