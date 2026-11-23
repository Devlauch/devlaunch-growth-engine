-- Up Migration
--
-- Widens the EXISTING `integrations` registry table's provider CHECK
-- constraint (024_create_integrations.sql, last extended by
-- 541_add_growth_channel_providers_to_integrations.sql) so People Data Labs
-- ('people_data_labs') and Abstract API ('abstract_api') can get a REAL
-- per-tenant connection row through apps/api/src/routes/integrations.ts —
-- same encrypted-credential + health-check path listmonk/chatwoot/postiz/
-- hunter/clearbit/apollo/google already use, not a parallel credential
-- system. Without this, POST .../integrations/people_data_labs/connect (or
-- abstract_api) would 400 at the DB layer even though
-- routes/integrations.ts's own PROVIDER_KEYS zod enum accepts them.
-- Postgres can't ALTER a CHECK constraint in place, so this drops and
-- recreates it with the same allowed values plus these two — same
-- drop-and-recreate idiom as 285/437/445/541.
--
-- Per-provider connection scope:
--   - 'people_data_labs' : a fourth, additive company/person data provider
--                   alongside hunter/clearbit/apollo (see
--                   apps/api/src/lib/peopleDataLabsProvider.ts) — platform-
--                   wide in practice (a single licensed data subscription),
--                   but made tenant-connectable here anyway for consistency
--                   with the other three, falling back to the
--                   PEOPLE_DATA_LABS_API_KEY env var when a tenant hasn't
--                   supplied its own key.
--   - 'abstract_api' : email + phone validation, additive alongside the
--                   existing free DNS/MX and E.164-format checks (see
--                   apps/api/src/lib/abstractApiProvider.ts) — same
--                   platform-wide-subscription-but-tenant-connectable
--                   convention, falling back to ABSTRACT_API_KEY.
--
-- Real per-tenant credential storage continues to use the EXISTING
-- integrations.encrypted_credential_ref + credentialEncryption.ts
-- mechanism — no new credential column or second credential-storage
-- mechanism is introduced here.

ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN (
    'twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks', 'chatwoot', 'hunter',
    'apollo', 'google',
    'clearbit', 'google_ads', 'meta_ads', 'whatsapp_business',
    'people_data_labs', 'abstract_api'
  ));

-- Down Migration

ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN (
    'twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks', 'chatwoot', 'hunter',
    'apollo', 'google',
    'clearbit', 'google_ads', 'meta_ads', 'whatsapp_business'
  ));
