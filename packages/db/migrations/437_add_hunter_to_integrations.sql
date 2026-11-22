-- Up Migration
--
-- Agent C (Hunter contact discovery + email verification): adds 'hunter' to
-- the EXISTING `integrations` registry table's provider CHECK constraint
-- (024_create_integrations.sql, last extended for 'chatwoot' by
-- 285_add_chatwoot_to_integrations.sql). Postgres can't ALTER a CHECK
-- constraint in place, so this drops and recreates it with the same
-- allowed values plus 'hunter'.
--
-- Hunter's real, per-tenant encrypted API key is stored via the EXISTING
-- `integrations.encrypted_credential_ref` column and the EXISTING
-- `apps/api/src/lib/credentialEncryption.ts` / `integrationCredentials.ts`
-- mechanism (already built for Milestone 2's listmonk/chatwoot/postiz
-- integrations) — through the EXISTING generic
-- `POST /integrations/:provider/connect` route. No new credential column
-- or a second credential-storage mechanism is introduced here.

ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks', 'chatwoot', 'hunter'));

-- Down Migration

ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks', 'chatwoot'));
