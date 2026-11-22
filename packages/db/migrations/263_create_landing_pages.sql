-- Up Migration
--
-- DevLaunch Growth Engine feature 2, "AI Landing Page & Lead Magnet
-- Builder": landing_pages is one audience/service-specific landing page
-- for a project (e.g. a tenant can have a "cloud consulting" page and a
-- separate "DevOps training" page for the same project). Tenant/project
-- scoped, same pattern as competitors / icp_profiles.
--
-- `blocks` holds the DETERMINISTIC, template-rendered section content
-- (hero / benefits / social-proof / form / cta) produced by
-- apps/api/src/lib/landingPageBuilder.ts from the project's own
-- project_profiles/icp_profiles data plus user-supplied copy — it is never
-- raw LLM output (this environment has no LLM API key wired up; see the
-- doc comment at the top of landingPageBuilder.ts and the same convention
-- already used by apps/api/src/lib/contentGeneration.ts).
--
-- `custom_domain` is store-only: no DNS/CDN provisioning happens anywhere
-- in this codebase. It exists so a client can record the domain they
-- intend to point at this page once they wire that up themselves.
CREATE TABLE landing_pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  slug                  text NOT NULL,
  title                 text NOT NULL,
  audience_label        text,
  headline              text,
  subheadline           text,
  body_copy             text,
  benefits              text[] NOT NULL DEFAULT ARRAY[]::text[],
  testimonial_quote     text,
  testimonial_author    text,
  cta_text              text,
  cta_url               text,
  qualifying_questions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocks                jsonb NOT NULL DEFAULT '[]'::jsonb,
  seo_title             text,
  seo_description       text,
  seo_og_image_url      text,
  custom_domain         text,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landing_pages_project_slug_key UNIQUE (project_id, slug)
);

CREATE TRIGGER trg_landing_pages_set_updated_at
  BEFORE UPDATE ON landing_pages
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_landing_pages_tenant_id ON landing_pages (tenant_id);
CREATE INDEX idx_landing_pages_project_id ON landing_pages (project_id);
CREATE INDEX idx_landing_pages_project_status ON landing_pages (project_id, status);

-- Down Migration

DROP TRIGGER IF EXISTS trg_landing_pages_set_updated_at ON landing_pages;
DROP TABLE IF EXISTS landing_pages;
