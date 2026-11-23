-- Up Migration
--
-- Milestone 2: adds 'chatwoot' as a valid `integrations.provider` value.
-- The CHECK constraint on this column has no explicit name in
-- 024_create_integrations.sql, so Postgres auto-named it
-- `integrations_provider_check` (table_column_check, the default
-- convention) — dropped and re-added here with the same auto-generated
-- name so a future `\d integrations` still shows one unnamed-looking
-- constraint, not a stray custom one.
--
-- This migration does NOT change encrypted_credential_ref's meaning —
-- see 286_create_integration_webhook_events.sql and
-- apps/api/src/lib/credentialEncryption.ts for the real encryption layer
-- Milestone 2 adds on top of this registry table.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks', 'chatwoot'));

-- Down Migration

ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks'));
