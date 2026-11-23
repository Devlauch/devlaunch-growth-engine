# Milestone 3 — Implementation Plan

Derived from `docs/BROADER_WORKSTREAM_AUDIT.md` and
`docs/GROWTH_ENGINE_INTEGRATION_MAP.md`. This is a **proposed, phased plan
awaiting approval** — no implementation has started from this document.

## Before any implementation: one pre-flight item

**Investigate the flagged regression first** (791 passed / 2 failed / 8
skipped in `apps/api`, down from the 766/766 certified a short time earlier):
`test/integrationIdempotency.test.ts` and `test/integrationTenantIsolation.test.ts`
fail on a `projects.slug` NOT NULL violation, and `test/listmonkWebhooks.test.ts`
has a new auth regression (401 vs 200). This looks like breakage from the
separate concurrent session's current edits, not from anything in this
audit's scope — but it should be confirmed and resolved (by whoever owns that
change, or by us if it's still unresolved by the time implementation starts)
before building new features on top of a known-red suite.

## Priority ordering (per your Step 4 instructions)

1. Intelligent B2B prospect discovery
2. Authorized contact enrichment and email verification
3. Inbound website conversion
4. SEO and content workflows
5. Lead nurturing and sales conversion
6. Revenue attribution

Mapped against the audit's actual findings, here is what each priority
concretely means as buildable work — favoring **connecting what already
exists** over building new standalone features, per your "reuse existing CRM
and integration infrastructure" instruction and "do not introduce more
open-source repositories unless a documented functional gap justifies them."

---

## Phase 1 — Close the scoring → CRM gap (highest leverage, lowest new-code risk)

This is the single most consequential fix identified: scoring and CRM are
fully-built islands that never talk to each other (see integration map
section 3). Everything here is **wiring existing, already-tested functions
together**, not new subsystems.

**Scope:**
- Call `scoreLead()`/trigger scoring automatically from `ingestLead()` so
  every new inbound lead gets a real score immediately, not on manual
  recompute.
- Add a real BullMQ-scheduled (or equivalent) job in `apps/worker` that
  periodically recomputes scores for leads whose underlying evidence changed
  (new enrichment, new reply, etc.) — closing the "manual-trigger-only"
  automation gap confirmed by this audit.
- Add a real BullMQ-scheduled job that runs `checkStalledDeals()` on a
  schedule, instead of only via `POST /deals/check-stalled` — this function
  already exists, is already correct and idempotent; it just needs a
  scheduler calling it, exactly like the existing report-schedule loop and
  sequence-scheduler cron already do in the same file.
- Define and implement an auto-assignment rule (e.g., round-robin among
  active tenant members, or score-threshold-gated) that writes a real
  `lead_assignments` row when a lead crosses a configurable score threshold —
  closing the "assignment is a CRUD-only island" gap.
- Fix the "promote to lead" / agent-discovered-lead asymmetry: route
  agent-sourced lead creation through the same side-effect path
  (`recordUsageEvent`/`notifyTenantOwnersAndAdmins`) that inbound capture
  already gets, or explicitly document why it shouldn't.

**Testing/acceptance criteria:**
- Real (not just mocked) test proving a newly-ingested lead has a non-null
  score within the same request/job cycle.
- Real test proving the stalled-deal job runs on its own without any manual
  API call, using the same test-clock-injection pattern already established
  elsewhere in this codebase (see the rate-limiter test-clock precedent).
- Real test proving auto-assignment writes a `lead_assignments` row under
  the defined threshold/rule, and does not double-assign an already-assigned
  lead.
- No regression in the existing 25+ scoring/CRM test files.

**Suggested parallel-agent boundaries** (max 3, non-overlapping files):
- Agent A: scoring-on-capture wiring (`leadIngestion.ts` + `scoreLead.ts`
  call site) + its test.
- Agent B: stalled-deal cron registration in `apps/worker/src/index.ts` +
  `salesPipeline.ts` (read-only reuse, no logic change) + its test.
- Agent C: auto-assignment rule (new, small lib file) + `lead_assignments`
  write path + its test.
These three touch almost entirely disjoint files (`leadIngestion.ts`,
`apps/worker/src/index.ts`, a new assignment lib) — low collision risk.

---

## Phase 2 — Authorized contact enrichment and email verification hardening

Email verification is already solid (classification 1). The gap here is
test-depth and connector completeness, not missing functionality.

**Scope:**
- Add real, direct unit tests for `enrichLead()`'s matching/firmographics
  logic (currently zero direct coverage — a confirmed gap, not a guess).
- Add real unit tests for `OverpassDirectoryApiClient.search()`'s query-
  construction and response-parsing (currently zero coverage at any level).
- Wire the already-built `csv_upload` connector into the route layer (it
  exists in the SDK, is registered, but is explicitly rejected by
  `discovery.ts` today — this is "finish what's started," not new scope).
- Reserve (but do not fabricate) env vars for a licensed B2B directory
  provider and a decision-maker provider (Apollo/ZoomInfo/Clearbit, as
  already named in code comments), following the exact `googlePageSpeedApiKey`
  null-default convention, so the moment real credentials are available
  they're a drop-in, not a redesign.

**Explicitly out of scope for this phase** (per your "do not introduce more
open-source repositories" instruction): no new data-provider integration
should be built until a specific provider is actually chosen and credentials
are available — building against a guessed API shape would risk exactly the
kind of fabrication this project has consistently avoided.

**Testing/acceptance criteria:**
- `enrichLead()` and `OverpassDirectoryApiClient.search()` each have real,
  passing unit tests exercising their actual logic (not mocked away).
- `csv_upload` discovery sources can be created end-to-end via the API with
  a real test proving the rejection is gone.

---

## Phase 3 — Inbound website conversion

**Scope:**
- Close the SSRF gap identified as the audit's single highest-value security
  fix: one shared utility (private/link-local/metadata-address rejection)
  applied to all three crawl-triggering entry points (chatbot website-import,
  Growth Analyzer, SEO site audit) — one fix, three places it protects.
- Decide and, if approved, implement a minimal in-repo landing-page renderer
  (even a simple server-side template) so "a visitor can actually load a
  landing page" becomes true end-to-end, rather than purely headless — this
  is a product decision as much as an engineering one; flag for your explicit
  approval before building, since the current headless design may be
  intentional.
- If the above is approved: add HTML sanitization on landing-page copy
  fields as part of that same work, closing the stored-XSS hand-off risk
  identified in the audit.

**Testing/acceptance criteria:**
- Real test proving a private-IP/link-local/metadata-service URL is rejected
  by all three crawl entry points before any outbound request is attempted.
- If a renderer is built: a real test loading a published landing page's
  HTML and confirming injected script tags in copy fields are neutralized.

---

## Phase 4 — SEO and content workflows

**Scope:**
- Reserve an env var for a real SERP/rank-tracking provider (none chosen yet)
  so keyword-rank tracking has a clear integration point when one is
  selected — do not guess a provider or fabricate ranking data.
- If/when an LLM API key becomes available (explicitly flagged by this audit
  as entirely absent today — zero LLM credentials exist anywhere in this
  codebase), wire it behind the already-prepared drop-in points in
  `contentGeneration.ts`/`messageDrafting.ts`/`marketingQa.ts`/
  `growthAnalyzer.ts`/`chatbotEngine.ts` — this is explicitly a "when
  available" item, not scoped to start now without a key.
- Consolidate the two independent discovery→persist implementations
  (`leadGeneration.ts` workflow stage vs. `discovery.ts` route) if/when time
  allows, to remove the "bugfix in one won't propagate to the other" risk —
  low urgency, flagged for awareness.

**Testing/acceptance criteria:** N/A until a provider/credential decision is
made — this phase is largely blocked-and-waiting, correctly so.

---

## Phase 5 — Lead nurturing and sales conversion (campaign attribution UI)

**Scope:**
- Build the missing dashboard page for campaign attribution — the API is
  live and correct; there is simply no UI surface for it yet. This is pure
  UI work against an already-complete, already-tested backend.

**Testing/acceptance criteria:**
- Real page, following this codebase's established page conventions
  (Layout/EmptyState/ErrorBanner/StatCard), rendering real data from the
  existing `GET /campaign-attribution` endpoints.

---

## Phase 6 — Revenue attribution depth

**Scope:**
- Add deeper test coverage for `growthRevenueAnalytics.ts`'s branches (CAC
  null/zero-customer/normal, ROI null/zero-spend/normal, degraded/non-
  degraded qualification path) — currently thin (4-6 tests for 300+ lines
  with several distinct branches). No logic change expected; this is a
  coverage-depth task, not a bug fix.

---

## Explicit non-goals for Milestone 3 (per your instructions)

- Do not rebuild anything already classified "1" or "2" in the audit —
  Companies/Contacts/Notes/Activity/Listmonk/Chatwoot/Postiz/credential
  encryption from the prior round, or anything else confirmed working here.
- Do not start multiple agents on overlapping feature areas in the same
  round — the phase boundaries above are chosen specifically to keep each
  parallel agent's file set disjoint from every other agent's in the same
  phase.
- Do not introduce a new open-source repository for any of the above —
  every gap identified has a clear "finish the existing extension point" or
  "wire in a chosen provider later" path; none requires a new dependency.
- Do not fabricate provider integrations for SERP tracking, B2B directory
  data, decision-maker contacts, or LLM generation — all four remain honest
  `not_configured`/absent until real credentials exist, consistent with this
  project's established anti-fabrication discipline.

## Recommended sequencing

Phase 1 first (highest leverage, pure wiring of existing tested code, lowest
risk). Phase 3's SSRF fix should run early too given it's a security finding,
independent of Phase 1 — these two can run in parallel since they touch
entirely disjoint files (`leadIngestion.ts`/`apps/worker/src/index.ts` vs.
crawl-triggering route files). Phases 2, 5, and 6 are each small, isolated,
low-risk, and can slot in opportunistically. Phase 4 waits on external
decisions (LLM key, SERP provider) and should not block anything else.

**Waiting for your approval before starting any of the above.**
