-- Up Migration
--
-- crm_tasks: real, trackable human tasks in the CRM (roadmap item 11,
-- "Calls and manual LinkedIn messages as tasks in the CRM, not automation").
-- This is the stable contract a parallel reply-handling effort also relies
-- on, so the column names below are final.
--
-- task_type 'call' / 'linkedin_message' are the manual-channel tasks from
-- roadmap item 11; 'follow_up' and 'review_reply' cover generic CRM
-- follow-ups (e.g. a reply that needs a human look); 'other' is an escape
-- hatch. sequence_enrollment_id links a task back to the sequence step that
-- created it (apps/api/src/lib/advanceSequences.ts), when applicable — it
-- is nullable because not every CRM task originates from a sequence.
CREATE TABLE crm_tasks (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id              uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id                 uuid REFERENCES leads (id) ON DELETE CASCADE,
  task_type               text NOT NULL CHECK (task_type IN ('call', 'linkedin_message', 'follow_up', 'review_reply', 'other')),
  title                   text NOT NULL,
  instructions            text,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'skipped')),
  due_at                  timestamptz,
  assigned_user_id        uuid REFERENCES users (id),
  sequence_enrollment_id  uuid REFERENCES sequence_enrollments (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_crm_tasks_set_updated_at
  BEFORE UPDATE ON crm_tasks
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_crm_tasks_tenant_id ON crm_tasks (tenant_id);
CREATE INDEX idx_crm_tasks_project_id ON crm_tasks (project_id);
CREATE INDEX idx_crm_tasks_lead_id ON crm_tasks (lead_id);
CREATE INDEX idx_crm_tasks_tenant_status ON crm_tasks (tenant_id, status);
CREATE INDEX idx_crm_tasks_assigned_user_id ON crm_tasks (assigned_user_id);

-- Down Migration

DROP TABLE IF EXISTS crm_tasks;
