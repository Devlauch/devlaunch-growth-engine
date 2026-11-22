-- Up Migration
--
-- A/B testing for landing pages. Per the brief, this REUSES the existing
-- Phase 2 "Conversion Optimization Agent" experiment infra
-- (088_create_experiments.sql / 089_create_experiment_results.sql, see
-- apps/api/src/routes/conversionOptimization.ts) instead of building a
-- second experiment system: landing_page_variants is a new JOIN table that
-- links a landing page's two variants ('a' control / 'b' challenger) to one
-- `experiments` row. The existing experiments lifecycle
-- (suggested -> running -> completed | abandoned), experiment_results
-- (visitors/conversions per variant), and the existing
-- GET /conversion-optimization/experiments/:id/results winner-calc endpoint
-- are reused unchanged — apps/api/src/routes/publicLandingPages.ts writes
-- real experiment_results rows from real tracked landing_page_events
-- (page_view -> visitors, form_submit -> conversions) for the variant a
-- visitor was actually served.
--
-- experiment_id is nullable: a landing page can have two variant rows
-- without yet being wired to a running experiment (e.g. while a draft
-- variant is being authored), but once an experiment is created the two
-- variant rows are expected to share the same experiment_id.
CREATE TABLE landing_page_variants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  landing_page_id  uuid NOT NULL REFERENCES landing_pages (id) ON DELETE CASCADE,
  experiment_id    uuid REFERENCES experiments (id) ON DELETE SET NULL,
  variant          text NOT NULL CHECK (variant IN ('a', 'b')),
  is_control       boolean NOT NULL DEFAULT false,
  headline         text,
  subheadline      text,
  cta_text         text,
  blocks           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landing_page_variants_page_variant_key UNIQUE (landing_page_id, variant)
);

CREATE TRIGGER trg_landing_page_variants_set_updated_at
  BEFORE UPDATE ON landing_page_variants
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_landing_page_variants_tenant_id ON landing_page_variants (tenant_id);
CREATE INDEX idx_landing_page_variants_landing_page_id ON landing_page_variants (landing_page_id);
CREATE INDEX idx_landing_page_variants_experiment_id ON landing_page_variants (experiment_id);

-- Down Migration

DROP TRIGGER IF EXISTS trg_landing_page_variants_set_updated_at ON landing_page_variants;
DROP TABLE IF EXISTS landing_page_variants;
