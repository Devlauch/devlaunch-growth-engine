# Open-Source-Inspired Upgrade Round — Implementation Report

12 parallel workstreams, each built by an independent agent against a fixed
set of hard rules (new files only; no edits to `app.ts`, `App.tsx`,
`Layout.tsx`, `routes/integrations.ts`, or any existing migration; no
fabricated provider/LLM success; real tests, actually run). The orchestrator
(this session) then applied all shared-file wiring sequentially and ran the
full build + test suite across all three workspaces.

See `OPEN_SOURCE_INTEGRATION_MATRIX.md` / `OPEN_SOURCE_LICENSE_AUDIT.md` /
`OPEN_SOURCE_DEPENDENCY_AUDIT.md` / `OPEN_SOURCE_INTEGRATION_ARCHITECTURE.md` /
`OPEN_SOURCE_UPGRADE_BACKLOG.md` for the read-only audit this round was based
on, and `NEW_FEATURE_ARCHITECTURE.md` / `NEW_FEATURE_TEST_REPORT.md` for the
cross-cutting architecture and verification detail.

## Final verification (post-reconciliation)

- `apps/api`: `tsc --noEmit` clean. `vitest run`: **163/167 test files, 1518/1537 tests passing**, 0 failures (4 files / 19 tests are pre-existing `.skip.test.ts` real-API fixtures, intentionally skipped — no real credentials in this environment).
- `apps/worker`: `tsc --noEmit` clean. `vitest run`: **18/18 test files, 112/112 tests passing**.
- `apps/dashboard`: `tsc --noEmit` clean. `vite build` succeeds (519 modules, no errors).
- Migration numbers used this round: 563–565, 600, 610–615, 630–633, 640–647 — reconfirmed collision-free against each other and against the pre-existing max (562) at application time.

## Workstream-by-workstream summary

### A1 — AI Agent Platform core (4 agents)
Native, tenant-aware agent runtime (`apps/api/src/lib/agentPlatform/core/`): zod-typed `AgentDefinition`, `runAgent()` wired to the existing `llmProvider.ts`/`llmBudget.ts` (honest `not_configured`/`budget_exceeded` when `ANTHROPIC_API_KEY` is unset, which it is in this environment), a tool-calling registry with 5 real tenant-scoped read tools, an `agent_runs` execution-history table (migration 600), and an eval harness. Ships 4 agents: market research, competitor intelligence, ICP research, lead research. 18/18 tests. Inspired by Mastra (Apache-2.0) and Aaron Marketing Skills (Apache-2.0) — no code copied.

### A2 — Remaining 10 specialized agents
Lead qualification, SEO research, content strategy, landing-page optimization, email campaign, social media strategy, sales intelligence, meeting preparation, customer success, and a Growth-Advisor LLM rephrase layer — each grounds in real existing tables/deterministic functions (e.g. `dealHealth.ts`, `campaignAttribution.ts`, `meetingPrep.ts`). Reconciled cleanly onto A1's real runtime contract. 9/9 new tests, 19/19 combined with A1.

### B — Native workflow automation engine
`workflow_definitions` / `workflow_executions` / `workflow_execution_steps` (migrations 610–615, full RLS), a from-scratch DAG engine (`workflowEngine.ts`) whose action executors call existing real functions only (sequence sends, task creation, lead-stage updates, notifications), and a worker trigger-poll cron. **n8n is Sustainable Use License v1.0 (not OSI-approved, internal/non-commercial use only) and Mautic is GPLv3** — both confirmed to forbid embedding in a paid SaaS, so this is a fully independent implementation with zero borrowed code. 15/15 tests.

### C1 — Growth analytics upgrade (funnels, cohorts, journeys, segmentation)
4 new lib modules querying only the existing `site_sessions`/`site_pageviews`/`site_events`/`site_visitors` tables — no new event pipeline. Confirmed distinct from the existing CRM-stage `funnelDropoff.ts` (different question: anonymous visitor event sequences, not lead pipeline stages). PostHog (MIT outside `ee/`) used for conceptual inspiration only. No migration needed. 13/13 tests, full-suite regression-free.

### C2 — A/B testing / growth experiment engine
`growth_experiments` / `experiment_exposures` / `experiment_conversions` / `growth_experiment_actions` (migrations 642–647, full RLS), deterministic hash-based stable variant assignment, a from-scratch two-proportion z-test with a hard-coded insufficient-sample-size guard (never reports a winner below `min_sample_size`), and approval-gated winner application routed through the **existing** `approvals` table (extended, not duplicated) — applying a winner never mutates a live landing page without a human decision. 16/16 tests.

### D — Forms, surveys & feedback intelligence
`surveys` / `survey_responses` (migrations 630–633, RLS incl. a public-lookup carve-out), conditional-logic branching, NPS/CSAT scoring, abandonment-funnel analytics, a public ingestion route reusing the existing `ingestLead()` path (never a direct `leads` insert), and an embeddable survey widget honoring Do-Not-Track. Formbricks (AGPLv3 core, MIT carve-outs for client SDKs) and Chatwoot CSAT plumbing used for conceptual reference only. 20/20 tests.

### E — Deep website & competitor intelligence
`website_intelligence_snapshots` (migrations 640–641, RLS), structured pricing/product-catalog/case-study extraction built on the existing Crawl4AI client, real content-hash change detection, and pure-function content-gap analysis — every outbound fetch verified to go through the existing SSRF guard (zero raw `fetch()` calls). Crawl4AI is Apache-2.0; its extraction-strategy *concepts* (not code) were ported into this codebase's existing regex-only convention. 29/29 tests.

### F — Unified customer intelligence / CRM timeline
A read-aggregating layer (`unifiedCustomerProfile.ts`) merging the existing activity timeline, site-analytics visitor history, and native-chatbot + Chatwoot conversation records into one timeline, plus deterministic engagement scoring, intent-signal detection, and lifecycle-stage mapping — all over existing tables, no new source-of-truth. Extended (not duplicated) the pre-existing `nextBestAction.ts`. Honestly declined to fabricate an email open/click signal since no such tracking table exists in this schema. 34/34 tests.

### G1 — Prospecting & company intelligence core
`companyIntelligence.ts` aggregates the existing decision-maker waterfall, firmographics, and deal/lead history (no new table — justified as unnecessary for this read pattern); `rankDecisionMakersByRelevance` is a pure deterministic keyword scorer; `prospectResearchSummary.ts` optionally LLM-polishes an already-complete deterministic summary. OpenOutreach (Apache-2.0, actively maintained) and LeadHub (near-abandoned, MIT) both yielded nothing directly reusable — correctly rejected rather than forced in. 15/15 tests.

### G2 — Sales engagement intent & follow-up analytics
`multiTouchEngagement.ts`/`leadIntentScoring.ts`/`followUpRecommendation.ts`/`prospectToMeetingAnalytics.ts`, all pure aggregation over real existing tables. Discovered and honestly documented that this codebase has **no email send/open/click tracking table at all** — touchpoints are built only from what's really there (activity timeline, sequence enrollments, message drafts, chatbot/Chatwoot conversations, correlated site events), never fabricated as "sent"/"opened". Reused `salesPipeline.ts`'s existing stall-threshold constants rather than inventing a second number. 22/22 tests.

### H — Social content calendar & conversation intelligence
`social_content_calendar` (migrations 563–565, including an additive widen of the `approvals` table's subject-type CHECK — the same established extension pattern used for campaigns/message-drafts/growth-advisor-actions). Publishing is gated through the existing approvals engine end-to-end (gate-bypass tests included) before ever calling the real Postiz client. Conversation intelligence reuses the real `integration_webhook_events`/`chatwoot_contact_leads` tables and the existing deterministic `classifyReply()` sentiment classifier — no new table, no new classifier. Postiz (AGPLv3) and Chatwoot (MIT core) used only to confirm real schema shapes, no code copied. 19/19 tests.

### License/architecture audit (read-only)
Produced the five `OPEN_SOURCE_*` documents listed above by directly reading each of the 13 sibling repos' LICENSE files, dependency manifests, and `git log` maintenance signals. Headline finding: **n8n's Sustainable Use License v1.0 is the one hard, business-level licensing blocker** across all 13 repos — every other license (AGPLv3/GPLv3/MIT-with-`ee/`-carve-outs) is satisfiable under this codebase's existing "call the documented API only" integration pattern.

## Honest gaps / explicitly not done this round

- No real Anthropic/OpenAI LLM credentials exist in this environment — every AI-agent-platform capability reports `status: "not_configured"` end-to-end; nothing was fabricated.
- No real SerpApi/Clearbit/Google Ads/Meta Ads/WhatsApp/Razorpay/Stripe/Hunter credentials exist (carried over from the prior 7-milestone round) — unaffected by this round, still honestly stubbed.
- Migrations were pattern-reviewed against sibling migrations but not run against a live Postgres in every agent's sandbox — recommend `npm run migrate:up` against a real dev database before relying on this in a deployed environment.
- Several new dashboard components (`UnifiedCustomerProfilePanel.tsx`, `CompanyIntelligencePanel.tsx`, `SalesEngagementPanel.tsx`) are built as siblings, not yet dropped into `LeadDetailPage.tsx`/`CompaniesPage.tsx`/`SalesPipelinePage.tsx`, because those pages were mid-edit by a concurrent session during this round — each workstream's report above/the git history gives the exact 2-line integration point.
- `growthAdvisor.ts`/`chatbotEngine.ts` LLM-explanation wiring from the prior round remains documented-only, not applied, for the same reason.
