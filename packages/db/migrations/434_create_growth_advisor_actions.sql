-- Up Migration
--
-- AI Growth Advisor: growth_advisor_actions is the one real, approval-gated
-- action the advisor can prepare (today: 'auto_assign_leads', round-robin
-- assigning a real set of currently-unassigned leads — see
-- apps/api/src/lib/leadPromotion.ts's autoAssignLeadRoundRobin, reused
-- unchanged, not reimplemented). A row here is created in status
-- 'pending_approval' by POST .../growth-advisor/recommendations/:id/
-- prepare-action, paired 1:1 with a new `approvals` row (see
-- 436_add_growth_advisor_action_id_to_approvals.sql) — exactly the same
-- "draft a row, gate it behind the existing approvals table" convention
-- already used for campaigns/message_drafts/postiz_social_posts. Nothing
-- in this table is ever executed until a human approves it via the
-- existing POST .../approvals/:approvalId/decision endpoint (extended,
-- not replaced, to also resolve this subject type).
--
-- payload is the real, concrete action to perform once approved (e.g.
-- { "leadIds": [...] } — the exact unassigned-lead ids this recommendation
-- was computed from, re-verified as still unassigned at execution time,
-- never a vague description). result is populated once the decision
-- endpoint actually executes it, recording what really happened per lead
-- (assigned / already_assigned / no_active_members) — never fabricated.
CREATE TABLE growth_advisor_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  recommendation_id uuid NOT NULL REFERENCES growth_advisor_recommendations (id) ON DELETE CASCADE,
  action_type       text NOT NULL CHECK (action_type IN ('auto_assign_leads')),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  result            jsonb,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_growth_advisor_actions_set_updated_at
  BEFORE UPDATE ON growth_advisor_actions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_growth_advisor_actions_tenant_id ON growth_advisor_actions (tenant_id);
CREATE INDEX idx_growth_advisor_actions_project_id ON growth_advisor_actions (project_id);
CREATE INDEX idx_growth_advisor_actions_recommendation_id ON growth_advisor_actions (recommendation_id);

-- Down Migration

DROP TABLE IF EXISTS growth_advisor_actions;
