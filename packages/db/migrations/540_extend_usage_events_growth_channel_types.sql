-- Up Migration
--
-- Milestone 6 (P5, external growth channels): additive event_type values on
-- the EXISTING usage_events table (230_create_usage_events.sql), same
-- append-only mechanism/table, no parallel usage-tracking system — same
-- convention as 440_extend_usage_events_hunter_types.sql and
-- 530_extend_usage_events_llm_token_types.sql.
--
-- One pair of types ("_api_request" success / "_request_failed" failure)
-- per new external provider client built this round, so each provider's
-- real call volume is visible independently and failure volume never gets
-- confused with successful usage:
--   - serp_api_request        : one row per real HTTP call to SerpApi
--                                (apps/api/src/lib/serpProvider.ts),
--                                quantity = 1.
--   - serp_request_failed     : one row per SerpApi call that failed
--                                (4xx/5xx/timeout/network error).
--   - clearbit_api_request    : one row per real HTTP call to Clearbit
--                                (apps/api/src/lib/clearbitProvider.ts),
--                                quantity = 1.
--   - clearbit_request_failed : one row per Clearbit call that failed.
--   - google_ads_api_request  : one row per real Google Ads API call
--                                (apps/api/src/lib/googleAdsProvider.ts),
--                                quantity = 1.
--   - google_ads_request_failed : one row per Google Ads API call that
--                                failed.
--   - meta_ads_api_request    : one row per real Meta Marketing API call
--                                (apps/api/src/lib/metaAdsProvider.ts),
--                                quantity = 1.
--   - meta_ads_request_failed : one row per Meta Marketing API call that
--                                failed.
--   - whatsapp_message_sent   : one row per real WhatsApp Cloud API
--                                template message actually sent
--                                (apps/api/src/lib/whatsAppProvider.ts),
--                                quantity = 1, metadata carries the real
--                                provider-issued message id.
--   - whatsapp_send_failed    : one row per WhatsApp Cloud API send
--                                attempt that failed.
--   - whatsapp_webhook_received : one row per real, signature-verified
--                                inbound WhatsApp delivery-status webhook
--                                event, quantity = number of status
--                                updates in that delivery. Never recorded
--                                for a request whose signature failed to
--                                verify.
--
-- No code path writes any of these with a fabricated/estimated quantity —
-- if a provider has no credential configured, its NotConfigured* stub
-- throws before any usage_events row is ever written for that call.

ALTER TABLE usage_events DROP CONSTRAINT usage_events_event_type_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN (
    'agent_run', 'api_request', 'lead_captured', 'ai_tokens',
    'hunter_api_request', 'hunter_discovery', 'hunter_verification', 'hunter_request_failed',
    'llm_tokens_input', 'llm_tokens_output',
    'serp_api_request', 'serp_request_failed',
    'clearbit_api_request', 'clearbit_request_failed',
    'google_ads_api_request', 'google_ads_request_failed',
    'meta_ads_api_request', 'meta_ads_request_failed',
    'whatsapp_message_sent', 'whatsapp_send_failed', 'whatsapp_webhook_received'
  ));

-- Down Migration

ALTER TABLE usage_events DROP CONSTRAINT usage_events_event_type_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN (
    'agent_run', 'api_request', 'lead_captured', 'ai_tokens',
    'hunter_api_request', 'hunter_discovery', 'hunter_verification', 'hunter_request_failed',
    'llm_tokens_input', 'llm_tokens_output'
  ));
