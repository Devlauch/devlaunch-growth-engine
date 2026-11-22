-- Up Migration
--
-- follow_up_tasks: sales-pipeline follow-up AUTOMATION METADATA, not a
-- second task-row model. The actual trackable human task (title,
-- instructions, status open/completed/skipped, assignment, due date) lives
-- in the existing `crm_tasks` table (049_create_crm_tasks.sql) — the same
-- real task-row shape apps/api/src/lib/advanceSequences.ts already uses
-- for call_task/linkedin_task sequence steps, and crm_tasks.task_type
-- already has a 'follow_up' value reserved for exactly this. Every
-- follow_up_tasks row MUST point at a real crm_tasks row (crm_task_id,
-- NOT NULL, ON DELETE CASCADE) rather than duplicating its columns.
--
-- What this table adds on top is the one thing crm_tasks has no column
-- for: WHY a follow-up was automatically created, and what sales-pipeline
-- entity it relates to — so apps/api/src/lib/salesPipeline.ts can both (a)
-- avoid creating a duplicate follow-up for the same stalled deal/meeting
-- outcome every time its check runs, and (b) let the dashboard show "this
-- task exists because deal X sat in 'proposal' for 11 days" instead of a
-- bare crm_tasks row with no sales context.
--
-- trigger_reason:
--   - 'stage_stalled'    -> deals.stage_changed_at older than the stall
--                           threshold (deal_id set, meeting_id null).
--   - 'meeting_outcome'  -> a completed/no_show meeting whose outcome
--                           requires a next step (meeting_id set, deal_id
--                           optional — meetings.deal_id may itself be null).
--   - 'manual'           -> created directly via POST .../follow-up-tasks
--                           rather than by the automatic stalled-deal/
--                           meeting-outcome checks.
CREATE TABLE follow_up_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  deal_id         uuid REFERENCES deals (id) ON DELETE CASCADE,
  meeting_id      uuid REFERENCES meetings (id) ON DELETE CASCADE,
  crm_task_id     uuid NOT NULL REFERENCES crm_tasks (id) ON DELETE CASCADE,
  trigger_reason  text NOT NULL CHECK (trigger_reason IN ('stage_stalled', 'meeting_outcome', 'manual')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A given deal should only ever have one OPEN auto-created stall
  -- follow-up outstanding at a time (re-checked via crm_tasks.status, not
  -- enforceable in a plain CHECK — see salesPipeline.ts's
  -- createStalledDealFollowUpIfNeeded, which queries for an existing open
  -- one before inserting another).
  CONSTRAINT follow_up_tasks_reason_target CHECK (
    (trigger_reason = 'stage_stalled' AND deal_id IS NOT NULL)
    OR (trigger_reason = 'meeting_outcome' AND meeting_id IS NOT NULL)
    OR (trigger_reason = 'manual')
  )
);

CREATE INDEX idx_follow_up_tasks_tenant_id ON follow_up_tasks (tenant_id);
CREATE INDEX idx_follow_up_tasks_project_id ON follow_up_tasks (project_id);
CREATE INDEX idx_follow_up_tasks_lead_id ON follow_up_tasks (lead_id);
CREATE INDEX idx_follow_up_tasks_deal_id ON follow_up_tasks (deal_id);
CREATE INDEX idx_follow_up_tasks_meeting_id ON follow_up_tasks (meeting_id);
CREATE INDEX idx_follow_up_tasks_crm_task_id ON follow_up_tasks (crm_task_id);

-- Down Migration

DROP TABLE IF EXISTS follow_up_tasks;
