-- Up Migration
--
-- Workstream D ("Forms, surveys and feedback intelligence"): the first of
-- two new tables backing dynamic multi-step forms, NPS/CSAT surveys, and
-- post-demo feedback. This is a DISTINCT feature from the existing
-- lead-capture system (leads / lead_magnets / landing_pages,
-- apps/api/src/routes/publicLeads.ts, publicLandingPages.ts,
-- leadMagnetUploads.ts) rather than a second competing one: a survey
-- response MAY feed an existing lead (via lib/leadIngestion.ts's
-- ingestLead(), never a direct INSERT INTO leads — see 632's own comment)
-- but a survey is its own first-class entity, scoped to a project the same
-- way seo_campaigns (551_create_seo_campaigns.sql) and landing_pages are.
--
-- `questions` is a jsonb array of {key, type, label, options?, conditionalOn?}
-- objects — see apps/api/src/lib/surveyEngine.ts's QuestionSchema for the
-- exact shape consumed/produced by evaluateConditionalQuestions(). Modeled
-- loosely on the branching concept in the sibling Formbricks repo's
-- packages/types/surveys/logic.ts (NOT copied — that file's licensing is
-- AGPLv3 outside packages/surveys|survey-ui|js|android|ios|api per its
-- LICENSE, and in any case the shape here is a small bespoke subset: no
-- jump-to-page/variable-substitution engine, just "does question X's
-- answer show question Y").
CREATE TABLE surveys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name          text NOT NULL,
  type          text NOT NULL CHECK (type IN ('multi_step_form', 'nps', 'csat', 'post_demo_feedback', 'qualification')),
  questions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_surveys_set_updated_at
  BEFORE UPDATE ON surveys
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_surveys_tenant_id ON surveys (tenant_id);
CREATE INDEX idx_surveys_project_id ON surveys (project_id);
CREATE INDEX idx_surveys_type ON surveys (type);

-- Down Migration

DROP TABLE IF EXISTS surveys;
