-- Up Migration
--
-- Milestone 6 (P5, external growth channels): adds 'clearbit', 'google_ads',
-- 'meta_ads', and 'whatsapp_business' to the EXISTING `integrations`
-- registry table's provider CHECK constraint (024_create_integrations.sql,
-- last extended for 'hunter' by 437_add_hunter_to_integrations.sql).
-- Postgres can't ALTER a CHECK constraint in place, so this drops and
-- recreates it with the same allowed values plus these four — same
-- pattern as 285_add_chatwoot_to_integrations.sql /
-- 437_add_hunter_to_integrations.sql.
--
-- Per-provider connection scope (documented here since it isn't obvious
-- from the column alone):
--   - 'clearbit'  : platform-wide in practice (a single licensed B2B data
--                   subscription), but made tenant-connectable here anyway
--                   for consistency with 'hunter' (also a shared data
--                   provider) — a tenant MAY still supply its own API key
--                   via POST /integrations/clearbit/connect, falling back
--                   to the CLEARBIT_API_KEY env var when it doesn't (see
--                   apps/api/src/lib/clearbitProvider.ts).
--   - 'google_ads', 'meta_ads', 'whatsapp_business' : genuinely per-tenant
--                   OAuth connections — each tenant advertises from / sends
--                   WhatsApp messages from its OWN ad account / WhatsApp
--                   Business phone number, so these MUST be tenant-
--                   connectable, not platform-wide-only. The long-lived
--                   OAuth token (google_ads/meta_ads) or access token
--                   (whatsapp_business) is the per-row
--                   encrypted_credential_ref; the platform's own OAuth
--                   app id/secret/developer token remain env vars (see
--                   apps/api/src/config/env.ts) since those are shared
--                   across every tenant's connection to that same
--                   registered app.
--
-- Real per-tenant credential storage continues to use the EXISTING
-- integrations.encrypted_credential_ref + credentialEncryption.ts
-- mechanism — no new credential column or second credential-storage
-- mechanism is introduced here.
--
-- PATCHED (Phase 2 merge reconciliation, orchestrator): this migration
-- rewrites the constraint's FULL value list rather than adding to it, so it
-- was found to silently drop 'apollo'/'google' — added by migration 445,
-- which runs before this one — the moment this migration ran. 445's values
-- carried forward here so they survive; never applied to any shared
-- database before this fix.

ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN (
    'twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks', 'chatwoot', 'hunter',
    'apollo', 'google',
    'clearbit', 'google_ads', 'meta_ads', 'whatsapp_business'
  ));

-- Down Migration

ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks', 'chatwoot', 'hunter', 'apollo', 'google'));
