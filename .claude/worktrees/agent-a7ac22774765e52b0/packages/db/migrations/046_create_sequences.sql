-- Up Migration
--
-- sequences: an editable, multi-step outreach plan (roadmap item 10,
-- "Multi-step sequences" — e.g. Day 0 email, Day 3 call task, Day 7
-- follow-up email, Day 14 final note). Project-scoped, same shape as
-- campaigns (020_create_campaigns.sql). The individual steps live in
-- sequence_steps (047_create_sequence_steps.sql); a lead is attached to a
-- sequence via sequence_enrollments (048_create_sequence_enrollments.sql).
--
-- is_active lets a tenant pause a sequence (no new enrollments/advancement)
-- without deleting it; it does not affect enrollments already stopped.
CREATE TABLE sequences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_sequences_set_updated_at
  BEFORE UPDATE ON sequences
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_sequences_tenant_id ON sequences (tenant_id);
CREATE INDEX idx_sequences_project_id ON sequences (project_id);

-- Down Migration

DROP TABLE IF EXISTS sequences;
