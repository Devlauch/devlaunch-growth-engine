-- Up Migration
--
-- buying_signals: real-world "hiring"/"funding"/"expansion"/etc buying
-- signals detected from already-crawled public data (a discovered org's
-- raw_metadata summary, or a crawled page's text obtained elsewhere in the
-- app) via a simple keyword/phrase heuristic (see
-- apps/api/src/lib/buyingSignals.ts). This table does not itself scrape or
-- fetch anything — it only stores signals that were detected over text the
-- caller already had. A signal can be attached to a lead, a discovered
-- organization, or both, since the same signal may be relevant before a
-- lead even exists.
CREATE TABLE buying_signals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id           uuid REFERENCES leads (id) ON DELETE CASCADE,
  organization_id   uuid REFERENCES discovered_organizations (id) ON DELETE CASCADE,
  signal_type       text NOT NULL CHECK (signal_type IN ('hiring', 'funding', 'expansion', 'leadership_change', 'product_launch', 'other')),
  detail            text NOT NULL,
  source_url        text,
  confidence        text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  detected_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buying_signals_subject_present CHECK (lead_id IS NOT NULL OR organization_id IS NOT NULL)
);

CREATE INDEX idx_buying_signals_tenant_id ON buying_signals (tenant_id);
CREATE INDEX idx_buying_signals_project_id ON buying_signals (project_id);
CREATE INDEX idx_buying_signals_lead_id ON buying_signals (lead_id);
CREATE INDEX idx_buying_signals_organization_id ON buying_signals (organization_id);
CREATE INDEX idx_buying_signals_project_detected_at ON buying_signals (project_id, detected_at DESC);

-- Down Migration

DROP TABLE IF EXISTS buying_signals;
