-- Up Migration
--
-- Phase 2 item 1 ("Competitor Intelligence Agent"): a detected diff between
-- two consecutive crawls of the same competitor (see
-- apps/api/src/routes/competitors.ts's POST /:id/crawl for the comparison
-- logic). `diff_summary` is always real, templated text built from counts
-- actually computed at detection time (e.g. a keyword-overlap percentage
-- or word-count delta) -- never an LLM-fabricated narrative.

CREATE TABLE competitor_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  competitor_id uuid NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  change_type text NOT NULL CHECK (change_type IN ('new_page', 'content_changed', 'messaging_changed', 'page_removed')),
  page_url text NOT NULL,
  before_snapshot_id uuid REFERENCES competitor_snapshots(id) ON DELETE SET NULL,
  after_snapshot_id uuid NOT NULL REFERENCES competitor_snapshots(id) ON DELETE CASCADE,
  diff_summary text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_competitor_changes_tenant_id ON competitor_changes (tenant_id);
CREATE INDEX idx_competitor_changes_competitor_id ON competitor_changes (competitor_id);
CREATE INDEX idx_competitor_changes_competitor_detected_at ON competitor_changes (competitor_id, detected_at DESC);

-- Down Migration

DROP TABLE IF EXISTS competitor_changes;
