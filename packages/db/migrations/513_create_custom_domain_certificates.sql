-- Up Migration
--
-- Milestone 3 — tracks real ACME (Let's Encrypt) certificate-provisioning
-- attempts per landing page custom domain (apps/api/src/lib/acmeClient.ts).
-- One row per provisioning attempt (re-attempts insert a new row, they
-- don't overwrite history — useful for debugging a failed issuance).
--
-- HONEST LIMITATION (see acmeClient.ts's doc comment in full): this
-- environment has no real public DNS zone/reachable public endpoint for
-- Let's Encrypt's validation servers, so `status` here realistically never
-- progresses past 'challenge_ready' in this environment — that is a real
-- external-infrastructure limitation, not a schema gap.
CREATE TABLE custom_domain_certificates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  landing_page_id    uuid NOT NULL REFERENCES landing_pages (id) ON DELETE CASCADE,
  domain             text NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'challenge_ready', 'validating', 'issued', 'failed')),
  challenge_type     text CHECK (challenge_type IN ('http-01', 'dns-01')),
  challenge_token    text,
  challenge_value    text,
  acme_order_url     text,
  acme_account_kid   text,
  error              text,
  issued_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_custom_domain_certificates_set_updated_at
  BEFORE UPDATE ON custom_domain_certificates
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_custom_domain_certificates_tenant_id ON custom_domain_certificates (tenant_id);
CREATE INDEX idx_custom_domain_certificates_project_id ON custom_domain_certificates (project_id);
CREATE INDEX idx_custom_domain_certificates_landing_page_id ON custom_domain_certificates (landing_page_id);

-- Down Migration

DROP TRIGGER IF EXISTS trg_custom_domain_certificates_set_updated_at ON custom_domain_certificates;
DROP TABLE IF EXISTS custom_domain_certificates;
