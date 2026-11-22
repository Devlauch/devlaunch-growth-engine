-- Up Migration
--
-- meetings: real, tenant/project-scoped scheduled meetings against a lead
-- (and optionally the deal they relate to), roadmap item "Booking
-- integration" + "Meeting outcome tracking".
--
-- booking_provider distinguishes HOW the meeting got onto this table:
--   - 'manual'   -> a sales rep recorded it themselves (POST .../meetings).
--                   This is the one real, always-available path — no
--                   external credentials required.
--   - 'calendly' -> would come from a real Calendly-style booking-provider
--                   integration. No such integration is wired up in this
--                   codebase (no CALENDLY_API_KEY/equivalent exists in any
--                   environment this was built against) — see
--                   apps/api/src/lib/bookingProvider.ts's
--                   NotConfiguredBookingProvider, which is the only
--                   implementation that currently exists. external_event_id
--                   is reserved for that integration's event id once one is
--                   ever wired up; it is never populated by the manual path.
-- This mirrors the same "real path + honest not-connected stub" pattern as
-- apps/api/src/routes/integrations.ts (registry, no real
-- Twenty/Mautic/etc. connection) and 058_create_lead_replies.sql (manual
-- ingestion today, same schema a real webhook could feed later).
--
-- status is the meeting's lifecycle: scheduled (default) -> completed |
-- no_show | rescheduled | cancelled. outcome_notes + next_step are filled
-- in once a meeting has actually happened (roadmap item "Meeting outcome
-- tracking") and are what apps/api/src/lib/salesPipeline.ts reads to decide
-- whether an automatic follow_up_tasks row is warranted.
CREATE TABLE meetings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  deal_id           uuid REFERENCES deals (id) ON DELETE SET NULL,
  type              text NOT NULL CHECK (type IN ('call', 'demo')),
  scheduled_at      timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'no_show', 'rescheduled', 'cancelled')),
  outcome_notes     text,
  next_step         text,
  booking_provider  text NOT NULL DEFAULT 'manual' CHECK (booking_provider IN ('manual', 'calendly')),
  external_event_id text,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_meetings_set_updated_at
  BEFORE UPDATE ON meetings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_meetings_tenant_id ON meetings (tenant_id);
CREATE INDEX idx_meetings_project_id ON meetings (project_id);
CREATE INDEX idx_meetings_lead_id ON meetings (lead_id);
CREATE INDEX idx_meetings_deal_id ON meetings (deal_id);
CREATE INDEX idx_meetings_tenant_status ON meetings (tenant_id, status);
-- Growth analytics' "meetings booked" aggregate buckets by scheduled_at.
CREATE INDEX idx_meetings_tenant_scheduled_at ON meetings (tenant_id, scheduled_at);

-- Down Migration

DROP TABLE IF EXISTS meetings;
