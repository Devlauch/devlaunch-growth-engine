-- workflow_automation_library.sql
--
-- Workstream B, item 4: built-in library workflows for the native
-- lifecycle-workflow automation engine (apps/api/src/lib/workflowEngine.ts),
-- as DATA (seedable workflow_definitions rows), not application code. Four
-- ready-to-customize templates: inactive-lead reactivation, demo
-- follow-up, trial conversion nudge, and customer retention check-in. Each
-- one's `nodes` is a real DAG built entirely out of workflowEngine.ts's
-- existing action executors (send_sequence_email / create_task /
-- update_lead_stage / notify) — nothing here is a fabricated action type.
--
-- Every row is seeded with status = 'draft' on purpose: "demo follow-up"
-- and "trial conversion nudge" both reference a send_sequence_email action
-- whose config.sequenceId is a per-tenant `sequences` row id that cannot be
-- known at seed time (there is no "the" demo-follow-up sequence — each
-- tenant authors its own via POST .../sequences). Seeding these 'active'
-- would mean workflowTriggerCron silently tries to run an action with a
-- sequenceId that doesn't exist in that tenant's `sequences` table, which
-- fails honestly per node (see workflowEngine.ts's per-node try/catch) but
-- is still pure noise, not a working automation. 'draft' makes every
-- library row visible immediately in WorkflowAutomationPage.tsx as a
-- starting template a project can review, fill in the real sequenceId
-- (PATCH .../workflow-automation/:id), and switch to 'active' itself —
-- exactly the same "never fabricate a working integration, make the real
-- gap visible instead" convention this codebase follows everywhere else
-- (see e.g. listmonkClient.ts's NotConfiguredListmonkClient).
--
-- Usage (run once per project that wants these starting templates;
-- assumes migrations through 615_enable_rls_workflow_execution_steps.sql
-- have already been applied):
--
--   psql "$DATABASE_URL" \
--     -v tenant_id="'<tenant-uuid>'" \
--     -v project_id="'<project-uuid>'" \
--     -f packages/db/seeds/workflow_automation_library.sql
--
-- Re-running for the same tenant/project is safe (idempotent): each
-- INSERT is guarded by a NOT EXISTS check on (tenant_id, project_id, name)
-- so re-running this script never creates duplicate template rows.

DO $$
DECLARE
  v_tenant_id  uuid := :tenant_id;
  v_project_id uuid := :project_id;
BEGIN
  -- Same RLS posture as packages/db/seed.sql: workflow_definitions has
  -- FORCE ROW LEVEL SECURITY (611_enable_rls_workflow_definitions.sql), so
  -- app.current_tenant_id must be set before inserting, exactly as the API
  -- layer does per request.
  PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);

  -- 1. Inactive lead reactivation: leads still 'new' after 14+ days with
  -- no activity get a follow-up task and the project's owners/admins are
  -- notified. Fully functional out of the box (create_task/notify need no
  -- per-tenant configuration) — still seeded as 'draft' for consistency
  -- with the other three; a project can flip it straight to 'active'.
  IF NOT EXISTS (
    SELECT 1 FROM workflow_definitions
    WHERE tenant_id = v_tenant_id AND project_id = v_project_id AND name = 'Inactive lead reactivation'
  ) THEN
    INSERT INTO workflow_definitions (tenant_id, project_id, name, trigger_type, trigger_config, nodes, status)
    VALUES (
      v_tenant_id, v_project_id, 'Inactive lead reactivation', 'condition',
      '{"entity": "leads", "statusEquals": "new", "inactiveField": "created_at", "inactiveDays": 14}'::jsonb,
      '[
        {"key": "create_followup_task", "type": "action",
         "config": {"actionType": "create_task", "taskType": "follow_up",
                    "title": "Re-engage inactive lead",
                    "instructions": "No activity in 14+ days. Reach out with a fresh value proposition before this lead goes fully cold."},
         "next": "notify_owner"},
        {"key": "notify_owner", "type": "action",
         "config": {"actionType": "notify", "type": "lead.captured",
                    "title": "Inactive lead flagged for reactivation",
                    "body": "A lead with no activity for 14+ days was flagged; a follow-up task was created."},
         "next": null}
      ]'::jsonb,
      'draft'
    );
  END IF;

  -- 2. Demo follow-up: qualified leads with no movement for 2+ days get a
  -- follow-up task, then (once the tenant fills in a real sequenceId) a
  -- real follow-up email via the existing sequence/Listmonk send path.
  IF NOT EXISTS (
    SELECT 1 FROM workflow_definitions
    WHERE tenant_id = v_tenant_id AND project_id = v_project_id AND name = 'Demo follow-up'
  ) THEN
    INSERT INTO workflow_definitions (tenant_id, project_id, name, trigger_type, trigger_config, nodes, status)
    VALUES (
      v_tenant_id, v_project_id, 'Demo follow-up', 'condition',
      '{"entity": "leads", "statusEquals": "qualified", "inactiveField": "updated_at", "inactiveDays": 2}'::jsonb,
      '[
        {"key": "create_demo_followup_task", "type": "action",
         "config": {"actionType": "create_task", "taskType": "follow_up",
                    "title": "Follow up after demo",
                    "instructions": "Check in with this qualified lead to see if they have questions after their demo/evaluation."},
         "next": "send_followup_email"},
        {"key": "send_followup_email", "type": "action",
         "config": {"actionType": "send_sequence_email", "sequenceId": null,
                    "_todo": "Replace null with a real sequences.id from POST .../sequences before activating."},
         "next": null}
      ]'::jsonb,
      'draft'
    );
  END IF;

  -- 3. Trial conversion nudge: leads approved for outreach that have
  -- stalled for 5+ days get a nudge task and a real nudge email once
  -- configured.
  IF NOT EXISTS (
    SELECT 1 FROM workflow_definitions
    WHERE tenant_id = v_tenant_id AND project_id = v_project_id AND name = 'Trial conversion nudge'
  ) THEN
    INSERT INTO workflow_definitions (tenant_id, project_id, name, trigger_type, trigger_config, nodes, status)
    VALUES (
      v_tenant_id, v_project_id, 'Trial conversion nudge', 'condition',
      '{"entity": "leads", "statusEquals": "approved_for_outreach", "inactiveField": "updated_at", "inactiveDays": 5}'::jsonb,
      '[
        {"key": "create_nudge_task", "type": "action",
         "config": {"actionType": "create_task", "taskType": "follow_up",
                    "title": "Nudge trial lead toward conversion",
                    "instructions": "This lead has been approved for outreach for 5+ days without progressing. Offer help closing the loop."},
         "next": "send_nudge_email"},
        {"key": "send_nudge_email", "type": "action",
         "config": {"actionType": "send_sequence_email", "sequenceId": null,
                    "_todo": "Replace null with a real sequences.id from POST .../sequences before activating."},
         "next": null}
      ]'::jsonb,
      'draft'
    );
  END IF;

  -- 4. Customer retention check-in: a weekly reminder (no specific lead
  -- involved, so only the notify action is used — create_task/
  -- update_lead_stage/send_sequence_email all require a leadId, which a
  -- 'scheduled' trigger's context does not have) for the team to review
  -- active accounts for retention risk.
  IF NOT EXISTS (
    SELECT 1 FROM workflow_definitions
    WHERE tenant_id = v_tenant_id AND project_id = v_project_id AND name = 'Customer retention check-in'
  ) THEN
    INSERT INTO workflow_definitions (tenant_id, project_id, name, trigger_type, trigger_config, nodes, status)
    VALUES (
      v_tenant_id, v_project_id, 'Customer retention check-in', 'scheduled',
      '{"intervalMinutes": 10080}'::jsonb,
      '[
        {"key": "notify_retention_review", "type": "action",
         "config": {"actionType": "notify", "type": "lead.captured",
                    "title": "Weekly customer retention check-in",
                    "body": "Review active customer accounts for retention risk signals this week."},
         "next": null}
      ]'::jsonb,
      'draft'
    );
  END IF;
END $$;
