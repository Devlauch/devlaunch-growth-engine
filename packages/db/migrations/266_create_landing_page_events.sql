-- Up Migration
--
-- Real, tracked conversion events for a landing page: a page_view (public
-- render), a form_submit (enquiry form completed, see
-- apps/api/src/routes/publicLandingPages.ts), or a download (a lead magnet
-- actually handed to a visitor, always gated behind a successful
-- form_submit in the same request). GET /landing-pages/:id/stats rolls
-- these up — counts are only ever real rows inserted by an actual public
-- request, never fabricated/estimated.
--
-- tenant_id and project_id are denormalized from landing_pages for RLS and
-- for cheap project-wide rollups, same pattern as experiment_results
-- denormalizing tenant_id from experiments.
CREATE TABLE landing_page_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  landing_page_id  uuid NOT NULL REFERENCES landing_pages (id) ON DELETE CASCADE,
  lead_magnet_id   uuid REFERENCES lead_magnets (id) ON DELETE SET NULL,
  variant          text CHECK (variant IN ('a', 'b')),
  event_type       text NOT NULL CHECK (event_type IN ('page_view', 'form_submit', 'download')),
  ip_hash          text,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_landing_page_events_tenant_id ON landing_page_events (tenant_id);
CREATE INDEX idx_landing_page_events_page_type ON landing_page_events (landing_page_id, event_type);
CREATE INDEX idx_landing_page_events_page_variant_type ON landing_page_events (landing_page_id, variant, event_type);

-- Down Migration

DROP TABLE IF EXISTS landing_page_events;
