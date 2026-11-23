-- Up Migration
--
-- Milestone 3 — real custom-domain DNS ownership verification (closes the
-- gap 263_create_landing_pages.sql's own comment documents: `custom_domain`
-- was store-only, with no DNS/CDN provisioning logic anywhere). Purely
-- additive: `custom_domain` itself is untouched.
--
-- See apps/api/src/lib/customDomainVerification.ts for the real
-- `dns.promises.resolveTxt()`-based check this backs — a tenant publishes
-- `verification_token` as a TXT record at `_devlaunch-verify.<custom_domain>`,
-- and `verification_status` only ever moves to 'verified' after a real DNS
-- lookup confirms it (route layer's responsibility; the lib module itself
-- never writes to the database).
ALTER TABLE landing_pages
  ADD COLUMN verification_token text,
  ADD COLUMN verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed')),
  ADD COLUMN verified_at timestamptz;

-- Down Migration

ALTER TABLE landing_pages
  DROP COLUMN IF EXISTS verification_token,
  DROP COLUMN IF EXISTS verification_status,
  DROP COLUMN IF EXISTS verified_at;
