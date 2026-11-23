-- Up Migration
--
-- Lets the public listmonk webhook endpoint
-- (POST /api/v1/public/webhooks/listmonk/:integrationId/:service — see
-- apps/api/src/routes/listmonkWebhooks.ts) resolve which tenant an
-- integration_id belongs to WITHOUT already knowing (or trusting a
-- client-supplied) tenant_id, mirroring 019_public_project_lookup_rls.sql's
-- "verify first, then set tenant context" shape for an unauthenticated
-- caller armed only with the integration's own id (which is only ever
-- handed out to that project's own webhook configuration URL — it is not
-- guessable the way a sequential id would be, since integrations.id is a
-- random uuid, and this policy only ever reveals a single row for provider
-- = 'listmonk', nothing else).
--
-- Same narrowly-scoped session-variable convention: app.lookup_integration_id,
-- set only for the duration of resolving the webhook's target tenant (see
-- resolveIntegrationOrFail in listmonkWebhooks.ts). Grants no write access —
-- WITH CHECK still requires the normal tenant_id match.
ALTER TABLE integrations DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integrations_isolation ON integrations;

CREATE POLICY integrations_isolation ON integrations
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    OR (
      provider = 'listmonk'
      AND id::text = current_setting('app.lookup_integration_id', true)
    )
  )
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;

-- Down Migration

ALTER TABLE integrations DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integrations_isolation ON integrations;

CREATE POLICY integrations_isolation ON integrations
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
