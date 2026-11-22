-- Up Migration
--
-- Phase 2 reconciliation (Agent A2, provider cost reporting): widens the
-- EXISTING usage_events.event_type CHECK constraint (230_create_usage_events.sql,
-- most recently widened by 440_extend_usage_events_hunter_types.sql) to add
-- a single new value, 'google_search_call' — one row per real outbound call
-- to Google's Custom Search JSON API (recordUsageEvent, usageEvents.ts),
-- success OR failure, so apps/api/src/lib/providerCostReporting.ts can
-- report a REAL call count (and, since Google publishes a stable list
-- price per query, an honest cost ESTIMATE) for Google search usage.
--
-- Scope note: milestone3-phase2's own migration 295 (never applied to any
-- shared/production database — see docs/PHASE_2_CREDENTIAL_AND_COST_REPORT.md
-- for the verification evidence) built on top of ITS OWN migration 288,
-- which added both 'google_search_call' AND 'apollo_api_call' to this same
-- constraint. Master's independent lineage never carried migration 288's
-- effect forward, so neither value has ever existed here. This migration
-- deliberately adds ONLY 'google_search_call', not 'apollo_api_call' —
-- Apollo has no usage_events event type on master and this migration does
-- not invent one; that gap is reported honestly instead (see
-- providerCostReporting.ts's NOT_TRACKED_PROVIDERS and the deliverable doc).
ALTER TABLE usage_events DROP CONSTRAINT usage_events_event_type_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN (
    'agent_run', 'api_request', 'lead_captured', 'ai_tokens',
    'hunter_api_request', 'hunter_discovery', 'hunter_verification', 'hunter_request_failed',
    'google_search_call'
  ));

-- Down Migration

ALTER TABLE usage_events DROP CONSTRAINT usage_events_event_type_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN (
    'agent_run', 'api_request', 'lead_captured', 'ai_tokens',
    'hunter_api_request', 'hunter_discovery', 'hunter_verification', 'hunter_request_failed'
  ));
