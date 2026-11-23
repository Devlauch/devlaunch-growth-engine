-- Up Migration
--
-- Milestone 5 (P4) LLM-integration gap closed: content_calendar_items'
-- blog body text was 100% deterministic templating with ZERO real LLM
-- call site anywhere in the codebase (see
-- apps/api/src/lib/contentGeneration.ts's original doc comment, which
-- explicitly deferred "swapping in a real LLM call" as a future upgrade).
-- apps/api/src/lib/llmProvider.ts/llmBudget.ts already existed, real and
-- configured-but-unused for this feature (they do have other real call
-- sites: marketingQa.ts, aiSalesAssistant.ts) — this column is purely
-- additive so a blog item generated via the new opt-in
-- enhanceBlogBodyWithLlm() path (apps/api/src/lib/contentGeneration.ts)
-- can be honestly labeled apart from the deterministic-template default,
-- never silently indistinguishable from one.
--
-- 'template' (the default, applied to every pre-existing row and every
-- non-blog item) means the body is 100% deterministic templating.
-- 'llm' means this specific item's body was genuinely produced by a real
-- Anthropic Messages API call (apps/api/src/lib/llmProvider.ts), only ever
-- set when that call actually succeeded — a failed/not-configured/
-- budget-exceeded attempt always leaves the row's deterministic template
-- body + 'template' label in place (see contentStrategy.ts's POST
-- /content-calendars handler).
ALTER TABLE content_calendar_items
  ADD COLUMN IF NOT EXISTS generation_method text NOT NULL DEFAULT 'template'
    CHECK (generation_method IN ('template', 'llm'));

-- Down Migration

ALTER TABLE content_calendar_items
  DROP COLUMN IF EXISTS generation_method;
