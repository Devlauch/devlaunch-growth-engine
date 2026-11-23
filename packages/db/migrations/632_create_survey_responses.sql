-- Up Migration
--
-- Second table for Workstream D: one row per respondent per survey,
-- supporting partial/abandoned saves (so form-abandonment funnels are
-- measurable — see apps/api/src/lib/formAbandonmentTracking.ts) as well as
-- fully completed NPS/CSAT submissions.
--
-- `lead_id` is nullable and OPTIONAL by design: a survey response is not a
-- second lead-capture system. When a response legitimately identifies a
-- person who should become/update a lead, the route calls the EXISTING
-- apps/api/src/lib/leadIngestion.ts's ingestLead() to do that write — this
-- column only ever stores the resulting id for correlation, it is never
-- populated by a direct INSERT INTO leads.
--
-- `visitor_id` is nullable text (same shape/length convention as
-- leads.visitor_id, 505_add_visitor_session_to_leads.sql) for anonymous
-- responses from a visitor who isn't (yet) a lead.
--
-- Consent/retention: no IP address column exists here at all (raw IP is
-- never persisted for a survey response, consistent with
-- packages/embed-widget/analytics.js's Do-Not-Track convention honored at
-- the public route/widget layer — see publicSurveys.ts).
CREATE TABLE survey_responses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id      uuid NOT NULL REFERENCES surveys (id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  lead_id        uuid REFERENCES leads (id) ON DELETE SET NULL,
  visitor_id     text,
  answers        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NPS (0-10) or CSAT (typically 1-5) numeric score, when this survey's
  -- type is 'nps'/'csat'; null for a plain multi_step_form/qualification
  -- response with no single scalar score.
  score          int,
  completed      boolean NOT NULL DEFAULT false,
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_survey_responses_set_updated_at
  BEFORE UPDATE ON survey_responses
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_survey_responses_tenant_id ON survey_responses (tenant_id);
CREATE INDEX idx_survey_responses_survey_id ON survey_responses (survey_id);
CREATE INDEX idx_survey_responses_lead_id ON survey_responses (lead_id);
CREATE INDEX idx_survey_responses_completed ON survey_responses (completed);

-- Down Migration

DROP TABLE IF EXISTS survey_responses;
