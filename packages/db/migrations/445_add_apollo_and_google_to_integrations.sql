-- Up Migration
--
-- Phase 2 reconciliation (Agent A2, provider credential unification):
-- widens the EXISTING `integrations` registry table's provider CHECK
-- constraint (024_create_integrations.sql, previously widened by
-- 285_add_chatwoot_to_integrations.sql / 437_add_hunter_to_integrations.sql)
-- so Apollo and Google (Custom Search) can get a REAL per-tenant connection
-- row through apps/api/src/routes/integrations.ts — same
-- encrypted-credential + health-check path listmonk/chatwoot/postiz/hunter
-- already use, not a parallel credential system. Without this, POST
-- .../integrations/apollo/connect (or google) would 400 at the DB layer
-- even though routes/integrations.ts's own PROVIDER_KEYS zod enum accepts
-- them. Same auto-generated-constraint-name idiom as 285/437.
ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks', 'chatwoot', 'hunter', 'apollo', 'google'));

-- Down Migration

ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks', 'chatwoot', 'hunter'));
