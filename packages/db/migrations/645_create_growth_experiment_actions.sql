-- Up Migration
--
-- Same convention as 434_create_growth_advisor_actions.sql: the ONE
-- consequential, approval-gated action a growth_experiments row can
-- trigger (today: 'apply_winning_variant' -- rewriting the target
-- entity's live copy/content to match the winning variant once a human
-- approves it). experimentEngine.ts's applyWinningVariant() creates a
-- row here in status 'pending_approval', paired 1:1 with a new
-- 'approvals' row (see
-- 647_add_growth_experiment_action_id_to_approvals.sql) -- nothing in
-- payload is ever applied to the real target entity until a human
-- approves it via the EXISTING, unmodified POST
-- .../approvals/:approvalId/decision endpoint. Because that endpoint
-- (apps/api/src/routes/approvals.ts) is off-limits this round and only
-- resolves the subject types it already knows about (campaign_id,
-- growth_advisor_action_id), the actual apply-on-approval execution for
-- THIS subject type is instead picked up by a new worker poll
-- (apps/worker/src/jobs/experimentActionExecutor.ts), which watches for
-- approvals.status = 'approved' rows pointing at a 'pending_approval'
-- growth_experiment_actions row and then performs the real entity
-- update -- same approval-decided-implies-real-effect guarantee, just
-- resolved asynchronously instead of inline, since the decision endpoint
-- itself cannot be extended this round.
CREATE TABLE growth_experiment_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES growth_experiments (id) ON DELETE CASCADE,
  action_type   text NOT NULL CHECK (action_type IN ('apply_winning_variant')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  result        jsonb,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_growth_experiment_actions_set_updated_at
  BEFORE UPDATE ON growth_experiment_actions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_growth_experiment_actions_tenant_id ON growth_experiment_actions (tenant_id);
CREATE INDEX idx_growth_experiment_actions_project_id ON growth_experiment_actions (project_id);
CREATE INDEX idx_growth_experiment_actions_experiment_id ON growth_experiment_actions (experiment_id);

-- Down Migration

DROP TABLE IF EXISTS growth_experiment_actions;
