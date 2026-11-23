-- Up Migration
--
-- Adds 'whatsapp' as a valid sequence_steps.step_type (047_create_sequence_
-- steps.sql originally only allowed 'email'/'call_task'/'linkedin_task'/
-- 'follow_up_email'/'final_note'). This is the real wiring for the
-- WhatsApp Business Cloud API client in apps/api/src/lib/whatsAppProvider.ts
-- (a genuine HTTP client, verified against Meta's published Cloud API docs)
-- into the sequence engine's per-channel dispatch (advanceSequences.ts),
-- which previously had zero caller anywhere for that provider.
--
-- A 'whatsapp' step's task_instructions column (already free-text, already
-- reused per-step-type — see that column's header comment) holds the
-- WhatsApp message TEMPLATE NAME to send (WhatsApp's Cloud API can only
-- send pre-approved template messages to a lead outside an open 24-hour
-- customer-service window, never arbitrary free text — see Meta's
-- documented send-message-templates guide, already cited in
-- whatsAppProvider.ts's header comment). The step's
-- message_draft_variant_channel = 'whatsapp' points at the matching,
-- human-approved message_draft_variants row (channel already supported
-- since 047/053) whose `body` supplies the single templateVariable this
-- step's chosen template name expects — never fabricated, exactly the same
-- "must be an approved draft or the step does not fire" rule the existing
-- email step type enforces.
ALTER TABLE sequence_steps DROP CONSTRAINT sequence_steps_step_type_check;
ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_step_type_check
  CHECK (step_type IN ('email', 'call_task', 'linkedin_task', 'follow_up_email', 'final_note', 'whatsapp'));

-- Down Migration

ALTER TABLE sequence_steps DROP CONSTRAINT sequence_steps_step_type_check;
ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_step_type_check
  CHECK (step_type IN ('email', 'call_task', 'linkedin_task', 'follow_up_email', 'final_note'));
