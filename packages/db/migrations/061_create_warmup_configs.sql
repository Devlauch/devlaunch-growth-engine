-- Up Migration
--
-- Roadmap item 14: warm-up limits that start small and increase slowly,
-- per sending domain. This is real config + math (see
-- apps/api/src/lib/warmupPlan.ts for the pure ramp calculation) even
-- though no real send pipeline consumes `daily_limit`/`current limit` yet
-- — the point is for the limit to already be correctly computed and
-- ready for whenever real sending is wired up.

CREATE TABLE warmup_configs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  sending_domain_id   uuid REFERENCES sending_domains (id) ON DELETE CASCADE,
  daily_limit         integer NOT NULL DEFAULT 20 CHECK (daily_limit > 0),
  target_daily_limit  integer NOT NULL CHECK (target_daily_limit >= daily_limit),
  ramp_increment      integer NOT NULL DEFAULT 10 CHECK (ramp_increment > 0),
  ramp_interval_days  integer NOT NULL DEFAULT 3 CHECK (ramp_interval_days > 0),
  started_at          timestamptz NOT NULL DEFAULT now(),
  is_paused           boolean NOT NULL DEFAULT false,
  paused_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_configs_sending_domain_key UNIQUE (sending_domain_id)
);

CREATE TRIGGER trg_warmup_configs_set_updated_at
  BEFORE UPDATE ON warmup_configs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_warmup_configs_tenant_id ON warmup_configs (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS warmup_configs;
