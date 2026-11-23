-- Up Migration
--
-- Workstream C2: a real, general-purpose A/B testing / growth
-- experimentation engine. This is DELIBERATELY NOT a third rewrite of the
-- existing 088_create_experiments.sql / 089_create_experiment_results.sql
-- landing-page-only A/B infra (reused as-is by 264_create_landing_page_variants.sql
-- and apps/api/src/routes/landingPages.ts's POST /:id/ab-test) — that system
-- only ever compares exactly two variants ('a'/'b') of one landing page, has
-- no deterministic per-visitor assignment (a visitor's variant is whatever
-- landingPageBuilder.ts's pickVariant() happens to pick per request), and
-- has no statistical-significance calculation. growth_experiments instead
-- supports N weighted variants, four kinds of target entity (landing page,
-- form, email subject line, CTA), deterministic hash-based visitor
-- assignment (apps/api/src/lib/experimentEngine.ts), and a real
-- two-proportion z-test before ever declaring a winner. The two systems
-- intentionally coexist; neither replaces the other.
CREATE TABLE growth_experiments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id           uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name                 text NOT NULL,
  hypothesis           text,
  target_entity_type   text NOT NULL CHECK (target_entity_type IN ('landing_page', 'form', 'email_subject', 'cta')),
  target_entity_id     uuid NOT NULL,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'concluded', 'abandoned')),
  -- [{ key: control, label: Control, weight: 50 }, ...] — at
  -- least two variants, each a distinct key, weights summing to any
  -- positive total (assignVariant() normalizes by the real sum, never
  -- assumed to be 100 — see experimentEngine.ts).
  variants             jsonb NOT NULL,
  primary_metric_event text NOT NULL,
  min_sample_size      integer NOT NULL DEFAULT 100 CHECK (min_sample_size > 0),
  started_at           timestamptz,
  concluded_at         timestamptz,
  winning_variant_key  text,
  created_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_experiments_variants_is_array
    CHECK (jsonb_typeof(variants) = 'array'),
  CONSTRAINT growth_experiments_at_least_two_variants
    CHECK (jsonb_array_length(variants) >= 2),
  CONSTRAINT growth_experiments_concluded_has_winner
    CHECK (status <> 'concluded' OR winning_variant_key IS NOT NULL)
);

CREATE TRIGGER trg_growth_experiments_set_updated_at
  BEFORE UPDATE ON growth_experiments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_growth_experiments_tenant_id ON growth_experiments (tenant_id);
CREATE INDEX idx_growth_experiments_project_id ON growth_experiments (project_id);
CREATE INDEX idx_growth_experiments_project_status ON growth_experiments (project_id, status);
CREATE INDEX idx_growth_experiments_target_entity ON growth_experiments (target_entity_type, target_entity_id);

-- Down Migration

DROP TABLE IF EXISTS growth_experiments;
