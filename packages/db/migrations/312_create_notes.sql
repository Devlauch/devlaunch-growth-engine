-- Up Migration
--
-- notes: freeform CRM notes attachable to a lead, deal, company or contact
-- (CRM module list item "Notes"). Tenant/project-scoped like every other
-- table in this schema. A note is never a floating, unattached record —
-- the CHECK constraint below enforces that at least one of
-- lead_id/deal_id/company_id/contact_id is set, same "attach to something
-- real" discipline as follow_up_tasks_reason_target
-- (281_create_follow_up_tasks.sql).
--
-- A single note MAY be attached to more than one of these at once (e.g. a
-- note written during a meeting that is naturally "about" both the deal
-- and the contact who attended) — the CHECK only requires at least one,
-- not exactly one.
--
-- company_id/contact_id reference tables (`companies`, `contacts`) being
-- built concurrently by a separate effort (not yet present when this
-- migration was written). To avoid this migration failing/blocking if
-- those tables don't exist yet when migrations run, the FK constraints to
-- companies/contacts are NOT created here — they are added as a separate,
-- later, independently-retryable migration: 316_add_notes_company_contact_fk.sql.
-- The columns themselves (plain uuid, no FK yet) are created here so the
-- API/tests can rely on the column shape immediately.
CREATE TABLE notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id     uuid REFERENCES leads (id) ON DELETE CASCADE,
  deal_id     uuid REFERENCES deals (id) ON DELETE CASCADE,
  company_id  uuid,
  contact_id  uuid,
  body        text NOT NULL CHECK (char_length(body) > 0),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notes_has_target CHECK (
    lead_id IS NOT NULL OR deal_id IS NOT NULL OR company_id IS NOT NULL OR contact_id IS NOT NULL
  )
);

CREATE TRIGGER trg_notes_set_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_notes_tenant_id ON notes (tenant_id);
CREATE INDEX idx_notes_project_id ON notes (project_id);
CREATE INDEX idx_notes_lead_id ON notes (lead_id);
CREATE INDEX idx_notes_deal_id ON notes (deal_id);
CREATE INDEX idx_notes_company_id ON notes (company_id);
CREATE INDEX idx_notes_contact_id ON notes (contact_id);
-- Activity timeline's primary access pattern: all notes for a lead, newest
-- first (see apps/api/src/lib/activityTimeline.ts).
CREATE INDEX idx_notes_lead_created_at ON notes (lead_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS notes;
