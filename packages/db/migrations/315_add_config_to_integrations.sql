-- Up Migration
--
-- Milestone 2: upgrades the registry/placeholder `integrations` table
-- (024_create_integrations.sql) to support a real per-tenant connection
-- for exactly 3 providers (listmonk, chatwoot, postiz — see
-- docs/INTEGRATION_STATUS.md). Reuses this table rather than creating a
-- parallel one, per that doc's explicit instruction.
--
-- `config` holds non-secret, per-integration settings (e.g. `baseUrl`,
-- `inboxId`, `listId`) as plain jsonb — readable by anyone who can read
-- the row, never a place to put a real secret.
--
-- `encrypted_credential_ref` (existing column) changes meaning going
-- forward: previously an unencrypted placeholder label string; from this
-- migration on, every new/updated row stores ONLY the AES-256-GCM
-- envelope produced by apps/api/src/lib/credentialEncryption.ts
-- (encryptCredential) — never plaintext. This migration does not rewrite
-- existing placeholder rows (there is no real secret to re-encrypt, and
-- no production data in this environment); the API layer
-- (apps/api/src/routes/integrations.ts) is what actually stops accepting
-- plaintext from here on.
--
-- The `status` CHECK already allows 'connected'/'error' as of
-- 024_create_integrations.sql, and `provider` already includes 'chatwoot'
-- as of 285_add_chatwoot_to_integrations.sql — neither needs widening
-- here.
ALTER TABLE integrations ADD COLUMN config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Down Migration

ALTER TABLE integrations DROP COLUMN IF EXISTS config;
