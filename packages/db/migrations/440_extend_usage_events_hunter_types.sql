-- Up Migration
--
-- Agent C (Hunter): additive event_type values on the EXISTING usage_events
-- table (230_create_usage_events.sql) — same append-only mechanism/table,
-- no parallel usage-tracking system. Four new, Hunter-specific types so
-- Hunter's own usage never gets confused with the generic 'api_request'
-- bucket used for this API's own request volume:
--   - hunter_api_request    : one row per real HTTP call made to Hunter's
--                             API (domain search, email verifier, etc.),
--                             quantity = 1, metadata.endpoint identifies
--                             which one. metadata.creditsUsed /
--                             metadata.creditsUnit carry Hunter's own
--                             X-Credits-Used/X-Credits-Unit response
--                             headers WHEN Hunter's response actually
--                             included them — null/omitted otherwise,
--                             never guessed.
--   - hunter_discovery      : one row per contact actually discovered via
--                             Hunter Domain Search (quantity = number of
--                             new contacts persisted from that call).
--   - hunter_verification   : one row per real Hunter Email Verifier call
--                             (quantity = 1).
--   - hunter_request_failed : one row per Hunter API call that failed
--                             (4xx/5xx/timeout/network error), so failure
--                             volume is visible independent of successful
--                             usage above. metadata.statusCode /
--                             metadata.errorKind record what actually
--                             happened — never a guessed cause.

ALTER TABLE usage_events DROP CONSTRAINT usage_events_event_type_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN (
    'agent_run', 'api_request', 'lead_captured', 'ai_tokens',
    'hunter_api_request', 'hunter_discovery', 'hunter_verification', 'hunter_request_failed'
  ));

-- Down Migration

ALTER TABLE usage_events DROP CONSTRAINT usage_events_event_type_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN ('agent_run', 'api_request', 'lead_captured', 'ai_tokens'));
