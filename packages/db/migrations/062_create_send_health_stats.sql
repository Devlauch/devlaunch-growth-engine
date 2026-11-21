-- Up Migration
--
-- Roadmap item 14: bounce and complaint monitoring that pauses sending
-- when rates are high. Since no real sending pipeline exists in this
-- phase (see integrations.ts / campaigns.ts), these daily stat rows are
-- not populated automatically by any send worker yet — they are
-- manually/honestly entered via POST .../health (apps/api/src/routes/
-- sendingSetup.ts) so the pause-for-health math in
-- apps/api/src/lib/warmupPlan.ts (shouldPauseForHealth) has something
-- real to evaluate against. Rows will mostly be zero until a real send
-- pipeline is wired up in a later phase — that is intentional, not a bug.

CREATE TABLE send_health_stats (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  sending_domain_id uuid REFERENCES sending_domains (id) ON DELETE CASCADE,
  stat_date         date NOT NULL,
  sent_count        integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  bounced_count     integer NOT NULL DEFAULT 0 CHECK (bounced_count >= 0),
  complained_count  integer NOT NULL DEFAULT 0 CHECK (complained_count >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_health_stats_domain_date_key UNIQUE (sending_domain_id, stat_date)
);

CREATE INDEX idx_send_health_stats_domain_date ON send_health_stats (sending_domain_id, stat_date DESC);

-- Down Migration

DROP TABLE IF EXISTS send_health_stats;
