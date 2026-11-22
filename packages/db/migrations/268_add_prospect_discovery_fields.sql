-- Up Migration
--
-- Advanced Prospect Discovery (feature 3): adds source_confidence to both
-- discovered_organizations and discovered_contacts, reflecting how the row's
-- data was actually obtained:
--   - 'verified'    : a direct, confirmed listing from a real connector (the
--                     public_directory/Overpass connector today) or a
--                     provider that stands behind the record.
--   - 'inferred'    : a best-guess match (e.g. a future decision-maker
--                     provider's title-based guess) — real data, but not
--                     directly confirmed.
--   - 'unconfirmed' : human-entered via the manual create routes, or
--                     anything else with no provider backing it.
--
-- Every row that exists before this migration runs came from either the one
-- real connector (public_directory) or the manual create routes acting on
-- data an operator asserted was real — so they're backfilled to 'verified'
-- rather than left to default to the more conservative 'unconfirmed', per
-- an explicit decision to treat pre-existing data as trustworthy. Rows
-- inserted from here on get an honest value from the route/connector that
-- creates them (see discovery.ts), defaulting to 'unconfirmed' when nothing
-- more specific is known.

ALTER TABLE discovered_organizations
  ADD COLUMN source_confidence text NOT NULL DEFAULT 'unconfirmed'
    CHECK (source_confidence IN ('verified', 'inferred', 'unconfirmed'));

ALTER TABLE discovered_contacts
  ADD COLUMN source_confidence text NOT NULL DEFAULT 'unconfirmed'
    CHECK (source_confidence IN ('verified', 'inferred', 'unconfirmed'));

UPDATE discovered_organizations SET source_confidence = 'verified';
UPDATE discovered_contacts SET source_confidence = 'verified';

CREATE INDEX idx_discovered_organizations_source_confidence ON discovered_organizations (source_confidence);
CREATE INDEX idx_discovered_contacts_source_confidence ON discovered_contacts (source_confidence);

-- Down Migration

DROP INDEX IF EXISTS idx_discovered_contacts_source_confidence;
DROP INDEX IF EXISTS idx_discovered_organizations_source_confidence;
ALTER TABLE discovered_contacts DROP COLUMN IF EXISTS source_confidence;
ALTER TABLE discovered_organizations DROP COLUMN IF EXISTS source_confidence;
