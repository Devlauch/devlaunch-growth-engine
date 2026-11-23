-- Up Migration
--
-- Milestone 5 (P4, pluggable LLM intelligence): additive event_type values
-- on the EXISTING usage_events table (230_create_usage_events.sql), same
-- append-only mechanism/table, no parallel usage-tracking system — same
-- convention as 440_extend_usage_events_hunter_types.sql.
--
-- Two new, LLM-specific types, split input/output (rather than reusing the
-- existing generic 'ai_tokens' type) so a real per-million-token cost
-- estimate (input and output tokens are priced differently by every LLM
-- provider) can be computed directly from these rows without having to
-- guess an input/output split after the fact:
--   - llm_tokens_input  : one row per real LLM completion call, quantity =
--                         the REAL input_tokens count the provider's own
--                         response reported (apps/api/src/lib/
--                         llmProvider.ts's LlmCompleteResult.inputTokens).
--                         Never an estimate.
--   - llm_tokens_output : one row per real LLM completion call, quantity =
--                         the REAL output_tokens count the provider's own
--                         response reported
--                         (LlmCompleteResult.outputTokens). Never an
--                         estimate.
--
-- Both are written together, in the same tenant-scoped transaction as the
-- call site that made the LLM request, by apps/api/src/lib/llmBudget.ts's
-- recordLlmUsage() — the single write path for these two event types, same
-- "one function, every caller goes through it" convention as
-- usageEvents.ts's recordUsageEvent() itself documents. No code path writes
-- these event_type values with a fabricated/estimated quantity — if a real
-- call never happens (no LLM key configured, call fails, or the per-tenant
-- monthly budget is already exceeded), no row is written at all, exactly
-- like 230's own 'ai_tokens' type sat genuinely empty until a real token
-- count existed.
ALTER TABLE usage_events DROP CONSTRAINT usage_events_event_type_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN (
    'agent_run', 'api_request', 'lead_captured', 'ai_tokens',
    'hunter_api_request', 'hunter_discovery', 'hunter_verification', 'hunter_request_failed',
    'llm_tokens_input', 'llm_tokens_output'
  ));

-- Down Migration

ALTER TABLE usage_events DROP CONSTRAINT usage_events_event_type_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN (
    'agent_run', 'api_request', 'lead_captured', 'ai_tokens',
    'hunter_api_request', 'hunter_discovery', 'hunter_verification', 'hunter_request_failed'
  ));
