# Feature Status — single source of truth

**Last updated:** 2026-11-22
**Updated by:** Claude (Milestone 3 Phase 2.5 — added two new features:
**AI Growth Advisor** (`growth_advisor_recommendations`/`growth_advisor_actions`,
migrations 432-436, `apps/api/src/lib/growthAdvisor.ts` /
`routes/growthAdvisor.ts`, dashboard `GrowthAdvisorPage.tsx`) — 5 real,
data-backed recommendation rules (invalid-email rate, unassigned leads, weak
landing-page conversion, qualified-leads-not-converting, unresolved
high-severity SEO issues), each with a real minimum sample size, plus one
approval-gated action (auto-assign unassigned leads, reusing
`leadPromotion.ts`'s round-robin, gated through the existing `approvals`
table) — and **DevLaunch's own internal customer-acquisition workspace**
(migrations 421-427, `publicGrowth.ts`/`internalGrowth.ts` routes, dashboard
`AcquisitionWorkspacePage.tsx`) — a dedicated, RLS-isolated internal
tenant/project with public unauthenticated growth-audit and demo-request
capture (real crawl via `growthAnalyzer.ts`, real lead ingestion, per-IP
rate-limited), trial-signup tracking, and CAC math that returns
"insufficient_data" rather than a masked zero. Both reuse existing
infrastructure (report pipeline, RBAC, audit_events, approvals, sequences/
deals) rather than rebuilding it. Routers mounted in `app.ts`, dashboard
routes/nav wired in `App.tsx`/`Layout.tsx`. Full `apps/api` suite verified
green after reconciliation: 994/1002 passing, 8 honest pre-existing skips.
See prior entry below for Milestone 3 Phase 1 — real-world smoke testing of
Listmonk/Chatwoot/Postiz against genuinely running containers; fixed a
critical platform-wide RLS-bypass finding and a route-shadowing bug; see
`docs/MILESTONE_3_REPORT.md` for the full report)

This file is the one place to check "is X built yet" across Phase 1 (core
growth-platform roadmap), Phase 2 (advanced marketing intelligence agents),
Phase 3 (platform/business infrastructure — RBAC, usage, plans, reports,
notifications), Phase 4 (cross-agent workflow orchestration), and Phase 5
(the Customer Acquisition Engine: growth analyzer → landing pages →
prospect discovery → chatbot → multi-channel execution → sales conversion →
revenue analytics). Multiple AI sessions/agents work on this repo in
parallel without seeing each other's conversations — **this file is their
shared memory of what's actually done; update it whenever you land
something.**

Status legend: ✅ built & tested · 🟡 partially built / stubbed honestly ·
🔧 built but currently mid-edit by another session (don't assume it's
stable) · ⬜ not started

Other docs in this folder: `PHASE1_REPORT.md`/`IMPLEMENTATION_PLAN.md` are
historical. `DISCOVERY.md`/`CRAWL4AI_VERIFICATION.md` are topic deep-dives.
`API_DEVIATIONS.md`/`DECISIONS.md`/`SECURITY.md` are rationale records.

**Note on concurrent sessions:** this repo has had (at least) two Claude
sessions working on it in parallel across every round so far. The other
session owns: RBAC (`apps/api/src/middleware/rbac.ts`), usage tracking
(`usageTracking.ts`/`UsagePage.tsx`), subscription plans + quota
enforcement (`planLimits.ts`/`quota.ts`/`planUsage.ts`/`PlanUsagePage.tsx`),
notifications (`notify.ts`/`notifications.ts`/`NotificationBell.tsx`), the
audit log page, per-tenant white-label branding, and the client-facing PDF
reports feature (`reports.ts`/`reportSchedules.ts`/`ReportsPage.tsx`) — all
of these are now committed/stable as of this reconciliation (previously
flagged as mid-edit; that's resolved). If you're a new session picking this
up, run `git status` and `git log --oneline -10` first — this file can only
be as fresh as the last
reconciliation.

---

# Phase 1 — core platform

## A. Find more leads
1. **Source connectors** — ✅ mostly done. Overpass public-directory connector live end-to-end. CSV connector built but not yet wired into the API's connector-type allowlist. Licensed-provider API is an honest stub.
2. **Crawl4AI website research** — ✅ verified live against a real `unclecode/crawl4ai:0.9.6` container.
3. **Contact discovery** — ✅ done.
4. **Email/phone verification** — ✅ done.
5. **Deduplication** — ✅ done (detection + skip; no merge UI).
6. **Inbound capture upgrades** — ✅ done (UTM/referrer, qualifying question, thank-you/booking link). Landing pages per audience + lead magnet still ⬜.

## B. Qualify the right leads
7. **Configurable scoring** — ✅ done, including a real `/recompute` evidence pipeline.
8. **Priority queue** — ✅ done, with dashboard UI.

## C. Create more message opportunities
9. **Message drafting** — ✅ done (deterministic, evidence-grounded, not an LLM call).
10. **Multi-step sequences** — ✅ done (manual-trigger advance; no cron yet — now also drivable via the Phase 4 workflow's campaign-execution stage).
11. **More channels / CRM tasks** — 🟡 CRM-tasks piece done; real sending integrations and Postiz remain ⬜ by design.
12. **Approval screen** — ✅ done (reuses the existing `approvals` table/state machine — also the gate the Phase 4 workflow pauses on).
13. **Reply handling** — ✅ done (deterministic classifier, manual/webhook ingestion).

## D. Delivery
14. **Sending setup per tenant** — ✅ done, including real live-verified SPF/DMARC DNS checks.

## E. Pipeline and learning
15. **CRM sync** — ⬜ not started (needs a real third-party account).
16. **Funnel analytics** — ✅ extended with a real `/funnel` endpoint.
17. **Learning loop** — ✅ done (reporting only — no send volume yet to compare).

## F. Compliance
18. **Suppression & consent** — ✅ done — the `checkSendEligibility` gate every send-adjacent feature (including the Phase 4 approval-gate stage) calls.

## G. Any company
20. **Onboarding wizard** — ✅ done, 4 real industry templates, idempotency-safe.

---

# Phase 2 — advanced marketing intelligence (all 6 items ✅ built)

### 1. Competitor Intelligence Agent — ✅ done
Crawls a competitor's site (4 fixed paths) via Crawl4AI, stores per-page content hashes, diffs against the prior snapshot (`new_page`/`content_changed`/`page_removed`), real TF-based keyword extraction, a real templated positioning report.
Evidence: `packages/db/migrations/096-099`, `apps/worker/src/agents/competitorIntelligence.ts`, `apps/api/src/routes/competitors.ts`, `apps/dashboard/src/pages/CompetitorIntelligencePage.tsx`.

### 2. Content Strategy Agent — ✅ done
Deterministic 30-day calendar generation + blog-repurposing. Explicitly NOT an LLM call — same honesty convention as message drafting.
Evidence: `packages/db/migrations/071-074`, `apps/api/src/lib/contentGeneration.ts`, `apps/api/src/routes/contentStrategy.ts`, `apps/dashboard/src/pages/ContentStrategyPage.tsx`.

### 3. Technical SEO Agent — ✅ done
Real sitemap/robots/broken-link/metadata audits. Real Google PageSpeed Core Web Vitals, honestly reporting `not_configured` without an API key. Keyword rank tracking is an honest `NotConfiguredRankingProvider` stub pending a paid SERP API.
Evidence: `packages/db/migrations/076-079`, `apps/api/src/lib/siteAudit.ts`/`coreWebVitals.ts`/`keywordRankingStub.ts`, `apps/api/src/routes/seo.ts`, `apps/dashboard/src/pages/SeoAuditPage.tsx`.

### 4. Advanced Lead Intelligence Agent — ✅ done
Company enrichment, deterministic ICP-fit scoring, keyword-based buying-signal detection, composed `/explain` endpoint.
Evidence: `packages/db/migrations/081-084`, `apps/api/src/lib/companyEnrichment.ts`/`icpMatching.ts`/`buyingSignals.ts`, `apps/api/src/routes/leadIntelligence.ts`, `apps/dashboard/src/pages/LeadIntelligencePage.tsx`.

### 5. Conversion Optimization Agent — ✅ done
Real landing-page audits, real funnel drop-off math, rule-based A/B suggestions, real experiment tracking with a minimum-sample-size guard.
Evidence: `packages/db/migrations/087-090`, `apps/api/src/lib/landingPageAudit.ts`/`funnelDropoff.ts`/`experimentSuggestions.ts`, `apps/api/src/routes/conversionOptimization.ts`, `apps/dashboard/src/pages/ConversionOptimizationPage.tsx`.

### 6. Marketing Intelligence Agent — ✅ done
Deterministic intent classifier over real queries (explicitly not true NLU). Real weekly/monthly reports, rule-based next-best-action recommendations.
Evidence: `packages/db/migrations/092-094`, `apps/api/src/lib/marketingQa.ts`/`nextBestAction.ts`/`reportGenerator.ts`, `apps/api/src/routes/marketingIntelligence.ts`, `apps/dashboard/src/pages/MarketingIntelligencePage.tsx`.

---

# Phase 3 — platform/business infrastructure (built by the other concurrent session, not this session's agents)

- **RBAC + tenant isolation hardening** — ✅ done. `apps/api/src/middleware/rbac.ts`, extended membership roles (migration `066_extend_membership_roles.sql`).
- **Usage tracking** — ✅ done. In-memory API-request counter + periodic flush (`apps/api/src/lib/usageTracking.ts`), `apps/dashboard/src/pages/UsagePage.tsx`, migrations `230-231`.
- **Subscription plans + quota enforcement** — ✅ done. Real plan column on `tenants` (migration `220`), `enforceQuota()` wired into discovery/memberships/agent-runs/projects before each insert, `apps/dashboard/src/pages/PlanUsagePage.tsx`. No real payment processing — plan changes are manual/admin-only by design.
- **Client PDF reports** — ✅ done. `apps/api/src/routes/reports.ts`/`reportSchedules.ts`, a real BullMQ report-generation worker + due-schedule loop (`apps/worker/src/reports/`), `apps/dashboard/src/pages/ReportsPage.tsx`, migrations `240-242`. Confirmed finished and wired by this reconciliation (previously flagged broken/mid-edit — that's resolved, dashboard now builds clean).
- **Notifications** — ✅ done (found already-wired during this reconciliation). `apps/api/src/lib/notify.ts`, `apps/api/src/routes/notifications.ts`, `apps/dashboard/src/components/NotificationBell.tsx`, migrations `250-252`.
- **Audit log page + per-tenant white-label branding** — ✅ done (found already-wired). `apps/dashboard/src/pages/AuditLogPage.tsx`, `BrandingPage.tsx`, migration `210_add_branding_to_tenants.sql`.

---

# Phase 4 — workflow orchestration ("make the agents work together") — ✅ built and wired this round

A pluggable `StageExecutor` registry (mirrors the existing `AgentRegistry`/
connector-registry convention) driving one real workflow per project through
7 stages, one stage per `advance` call (no auto-chaining):
`client_onboarding → research → lead_generation → content_campaign →
approval_compliance_gate → campaign_execution → analytics_learning`.

- **Core engine** — ✅ done. `apps/api/src/workflow/{types,engine,stageRegistry}.ts`, `apps/api/src/routes/workflows.ts` (`POST /`, `GET /`, `GET /:id`, `POST /:id/advance`). `needs_approval` leaves `current_stage` unchanged and never auto-approves; `completed` advances or finalizes.
- **Research stage** — ✅ done. Reuses Crawl4AI, competitor-change detection, site audit, keyword extraction — never throws for an unreachable competitor.
- **Lead generation stage** — ✅ done. Reuses the real discovery connector + dedup + verification + enrichment + ICP matching + rubric scoring glue (same logic as `discovery.ts`'s `/run`). Capped at 10 new leads/run.
- **Content & campaign stage** — ✅ done. Generates a real content calendar, drafts real messages for new leads (capped at 10), creates/enrolls a real "Content Campaign Sequence" (day 0 email / day 3 call / day 7 follow-up).
- **Approval & compliance gate + campaign execution stages** — ✅ done. Submits drafts into the existing real `approvals` table and genuinely blocks (`needs_approval`) until a human decides — never bypasses approval. Execution stage delegates straight to the real `advanceDueEnrollments` (no fabricated "send").
- **Analytics & learning stage** — ✅ done. Composes real numbers from all 6 prior stages plus funnel drop-off and variant-performance/rubric-readiness queries; each sub-call independently try/caught so one bad query doesn't fail the whole stage.
- **Dashboard** — ✅ done and now wired in. `apps/dashboard/src/pages/WorkflowPage.tsx` — start form, run list, 7-stage detail view, Advance button, `awaiting_approval` banner. Reachable at `/tenants/:tenantId/projects/:projectId/workflows`, with a sidebar nav link ("Workflows", next to Campaigns).

**This round's reconciliation work (done just now):**
- Wired all 5 remaining stage executors into `stageRegistry.ts` (only `client_onboarding` was registered before).
- Wired `workflowsRouter` into `apps/api/src/app.ts` (was built but never mounted).
- Wired `WorkflowPage` into `apps/dashboard/src/App.tsx` (route) and `Layout.tsx` (nav link) — same gap, now closed.
- Confirmed clean: `@devlaunch/agent-sdk` + `@devlaunch/api` build with zero errors, and all 431 API tests pass (38/38 files). The previously-tracked quota.ts test-mock bug (`TypeError: reading 'maxDiscoverySources'`) is **already fixed** — the other session's commit `14be9ed` resolved it directly.
- Dashboard (`vite build`) is currently blocked, but only by the unrelated in-progress Reports feature above — workflow wiring itself type-checks (confirmed `WorkflowPage` exports match the import, and the route/nav additions are syntactically consistent with the surrounding file).

**Not yet done:** a live end-to-end HTTP smoke-test pass through all 7 stages against a real tenant (only Phase 1 got that treatment so far, via `scripts/e2e-smoke-test.mjs`, which predates Phases 2/4 and doesn't cover either).

---

# Phase 5 — Customer Acquisition Engine ("connect a website → acquire customers") — ✅ built and wired this round

Six parallel agents, each extending/reusing existing infra rather than duplicating it, migrations `260-284` with zero numbering collisions.

### 1. AI Website Growth Analyzer — ✅ done
Crawls the client's whole site (reuses the verified Crawl4AI client), extracts products/services/value-props/audience signals via real TF/regex heuristics (explicitly NOT an LLM — same honesty convention as every other "agent" in this repo), recommends an ICP (industries/geographies/segments) the client can accept straight into the **existing** `icp_profiles.firmographics` jsonb (no schema change to a table owned elsewhere), reuses the existing competitor-tracking tables for competitor-opportunity content gaps, and produces a deterministic templated growth-plan summary.
Evidence: `packages/db/migrations/260-262`, `apps/api/src/lib/growthAnalyzer.ts`, `apps/api/src/routes/growthAnalyzer.ts`, `apps/dashboard/src/pages/GrowthAnalyzerPage.tsx`. 18/18 tests.

### 2. Landing Page & Lead Magnet Builder — ✅ done
Deterministic template-based landing-page sections (hero/benefits/social-proof/form/CTA — not an LLM), SEO metadata, custom-domain field (store-only), gated lead-magnet downloads, and A/B testing that reuses the **existing** Phase-2 `experiments`/`experiment_results` tables via a new join table rather than a second experiment system. Public form submissions go through the existing `ingestLead()` path (tagged `source: "public_widget"`, landing-page context preserved in `customFields`).
Evidence: `packages/db/migrations/263-267`, `apps/api/src/lib/landingPageBuilder.ts`, `apps/api/src/routes/landingPages.ts`/`publicLandingPages.ts`, `apps/dashboard/src/pages/LandingPageBuilderPage.tsx`. 25/25 tests.

### 3. Advanced Prospect Discovery (extends `discovery.ts`, doesn't duplicate it) — ✅ done
`source_confidence` (`verified`/`inferred`/`unconfirmed`) on discovered orgs/contacts; a generic, tested provider-waterfall orchestrator; an honest `NotConfiguredDecisionMakerProvider` stub behind a real pluggable interface (no paid data-provider key available — never fabricates a name/title/email); real CSV export for orgs/contacts; plus two genuine bug fixes found while reading the existing code — `normalizeOrgName` was silently failing to dedup "Pty Ltd" (AU/NZ/ZA) companies, and ICP phrase-matching could never match a phrase made entirely of short acronyms (PPC/SEO/ERP/B2B) because of a length filter.
Evidence: `packages/db/migrations/268-270`, `apps/api/src/lib/decisionMakerProvider.ts`/`providerWaterfall.ts`/`prospectExport.ts`, fixes in `dedup.ts`/`icpMatching.ts`, additions to `apps/api/src/routes/discovery.ts`. 76/76 tests (incl. the two bug-fix regression tests).

### 4. Website AI Lead Capture Agent (chatbot) — ✅ done
A deterministic weighted-term-overlap retrieval engine over client-approved knowledge sources only (explicitly NOT an LLM, same swap-in-ready convention as `marketingQa.ts`) — an honest "I don't know, want to leave your details?" fallback below a real confidence threshold, never a guessed answer. Website-import candidates always land `pending_review`/inactive and need an explicit human approval before the bot can ever use them. Real consent gate (reuses the existing `consent_records` table/shape) before any contact capture; qualifying-question flow; captured enquiries go through the existing `ingestLead()` path.
Evidence: `packages/db/migrations/271-274,284`, `apps/api/src/lib/chatbotEngine.ts`, `apps/api/src/routes/chatbotAdmin.ts`/`publicChatbot.ts`, `apps/dashboard/src/pages/ChatbotConfigPage.tsx`, `packages/embed-widget/chatbot.js`. 45 tests.

### 5. Multi-Channel Customer Acquisition / Campaign Execution — ✅ done
Real SMTP email sending (`nodemailer`, honest `NotConfiguredEmailProvider` stub without `SMTP_*` env vars) wired additively into the existing `advanceSequences.ts`, which also now **enforces the approval gate on every send** (`message_drafts.status = 'approved'` — previously missing) and **halts a sequence on any inbound reply** (previously only unsubscribe replies halted it — a real gap, now closed). A real recurring worker cron (`apps/worker/src/jobs/sequenceSchedulerCron.ts`, default 15 min) replaces the "manual-trigger only" limitation by calling the real `advanceDueEnrollments` — no reimplementation. Honest `NotConfigured*Provider` stubs (never fabricated sends/spend/impressions) for Postiz, Google Ads, Meta Ads, WhatsApp Business, all behind a shared pluggable interface. Real campaign-attribution rollup from existing campaign/enrollment/reply data.
Evidence: `packages/db/migrations/275-277`, `apps/api/src/lib/emailProvider.ts`/`channelProviders.ts`/`campaignAttribution.ts`, `apps/api/src/routes/campaignAttribution.ts`, `apps/worker/src/jobs/sequenceSchedulerCron.ts`, changes to `apps/api/src/lib/advanceSequences.ts`. 29 new tests + 10 updated/added in `sequences.test.ts`.

### 6. Sales Conversion Agent + Growth/Revenue Analytics — ✅ done
Real `deals` pipeline (new→contacted→qualified→proposal→won/lost) with a `customers` view derived from won deals (no duplicate lead/customer table), lead assignment history, meetings with a real manual-entry booking path plus an honest `NotConfiguredBookingProvider`/`NotImplementedBookingProvider` stub for Calendly-style integration, meeting-outcome tracking, and auto-generated follow-up tasks (reusing the existing `crm_tasks` table, not a second task model) on stalled deals or no-show/next-step meeting outcomes. Growth/revenue analytics composes real traffic/attribution/qualification/meetings/conversion numbers, and reports CAC/ROI as an explicit `not_available` whenever spend or customer data doesn't exist — never a guessed figure.
Evidence: `packages/db/migrations/278-283`, `apps/api/src/lib/salesPipeline.ts`/`bookingProvider.ts`/`growthRevenueAnalytics.ts`, `apps/api/src/routes/deals.ts`/`meetings.ts`/`growthAnalytics.ts`, `apps/dashboard/src/pages/SalesPipelinePage.tsx`/`GrowthAnalyticsPage.tsx`. 19 new tests.

**This round's reconciliation work (done just now):**
- Mounted all 9 new routers in `apps/api/src/app.ts` (growth analyses, landing pages + public landing pages, chatbot admin + public chatbot, deals, meetings, growth analytics, campaign attribution).
- Added 5 new dashboard routes to `App.tsx` and a new "Growth Engine" nav section + a "Sales Pipeline" link to `Layout.tsx`.
- Registered the sequence-scheduler cron in `apps/worker/src/index.ts` (import + start + shutdown `clearInterval`).
- Verified clean end to end: `@devlaunch/agent-sdk`, `@devlaunch/api`, `@devlaunch/worker` all build with zero errors; dashboard `tsc --noEmit` clean; **614/614 API tests pass, 101/101 worker tests pass** — zero migration-number collisions across all 6 agents (260-284, strictly sequential).
- Also discovered during this reconciliation that the Phase 3 items previously flagged "mid-edit by another session" (reports, notifications, audit log, branding) are now all committed and stable — updated their status above.

**Not yet done:** a live end-to-end HTTP smoke-test pass through the full Phase 5 flow (connect website → growth analysis → landing page → chatbot/discovery lead capture → sequence send → deal won → revenue analytics) against a real tenant.

---

## Reconciliation notes (read before adding new migrations)

**Migration numbering is now at 284**, strictly sequential, zero gaps or duplicates (verified `ls packages/db/migrations | sort -V` end to end). Known collisions, all in earlier rounds, all resolved by renumbering the side with fewer/no FK dependents:
1. Three Phase-1 agents landed at 052-056 simultaneously → renumbered to 064-065.
2. Phase 2's Competitor Intelligence agent's 066-069 collided with the other session's `066_extend_membership_roles.sql` → renumbered to 096-099.
3. Phase 5's chatbot agent's planned `275_enable_rls_chatbot.sql` collided with the campaign-execution agent's `275-277` range (both pre-assigned in the same round) → renumbered to `284_enable_rls_chatbot.sql`, the free slot at the time.

**Always `ls packages/db/migrations | sort -V | tail -10` AND `git status`
immediately before creating a new migration** — multiple sessions/agents
land files concurrently in this repo.

## What's left (small, concrete punch list)

1. Wire `csv_upload` into the `discovery-sources` connector-type allowlist (Phase 1 item 1).
2. Postiz, Google Ads, Meta Ads, WhatsApp Business, and Calendly-style booking all need real OAuth/API credentials — every integration point is built and honestly stubbed, waiting on real accounts.
3. Rubric-weight auto-tuning once `rubric-review-readiness` reports ≥30 outcomes.
4. A paid SERP API key to replace the keyword-ranking stub, and a real decision-maker data-provider key to replace `NotConfiguredDecisionMakerProvider` (Phase 5 item 3).
5. Wire a real LLM call behind `contentGeneration.ts`/`messageDrafting.ts`/`marketingQa.ts`/`growthAnalyzer.ts`/`chatbotEngine.ts`, if/when an API key is available — all were deliberately built so this is a drop-in swap, not a rewrite.
6. Real file-upload/CDN infra for lead magnets (`lead_magnets.file_url` is currently a client-supplied URL field, not an upload pipeline) and real custom-domain provisioning for landing pages (currently store-only).
7. Run the full Phase 2 + Phase 4 + Phase 5 flows against a real tenant end-to-end (`scripts/e2e-smoke-test.mjs` only covers Phase 1 today).

## Sales/conversion engine + attribution extensions (post-audit build)

Per user direction, built the genuinely-missing items from a follow-up
"AI sales and conversion engine" + "growth analytics and revenue attribution"
feature list, after cross-checking it against `docs/BROADER_WORKSTREAM_AUDIT.md`
to avoid rebuilding what already existed (lead qualification/scoring, reply
sentiment/intent via `classifyReply.ts`, next-best-action via
`nextBestAction.ts`, sales email drafting via `draftMessage.ts`, CAC/ROI via
`growthRevenueAnalytics.ts` were all already real — not touched this round).

**New, real, deterministic (no LLM exists in this codebase — honestly so,
same convention as every other "AI" feature here):**
- **Deal health scoring** — `GET /deals/:dealId/health`
  (`apps/api/src/lib/dealHealth.ts`), on-demand computed (no staleness-prone
  cache), scores stall-time/meeting-outcome/reply-signal/typical-deal-value,
  honestly omits any missing signal rather than guessing it.
- **Sales pipeline forecasting** — `GET /deals/forecast`
  (`apps/api/src/lib/pipelineForecast.ts`), stage-weighted (documented
  estimated defaults, not calibrated — no stage-history data exists yet to
  calibrate against), excludes deals with no `value_amount` from the dollar
  total rather than fabricating one.
- **Lost-deal analysis** — `GET /deals/lost-analysis`
  (`apps/api/src/lib/lostDealAnalysis.ts`) + a new, separate
  `classifyObjection.ts` (deliberately not merged into the existing
  `classifyReply.ts` enum — different question, different taxonomy),
  honestly reports `insufficient_data` below 3 lost deals.
- **Meeting preparation briefs** — `GET
  .../leads/:leadId/meetings/:meetingId/prep` (`apps/api/src/lib/meetingPrep.ts`),
  assembles real data from company/contact/ICP-match/enrichment/activity-
  timeline/notes — every section explicitly says "not available" when empty.
- **Objection insights** — `GET /objection-insights`
  (`apps/api/src/lib/objectionInsights.ts`) — currently proxies off the
  existing `lead_replies.classification = 'not_now'` value and says so
  explicitly in every response (`proxyCaveat`/`proxyClassification` fields)
  until/unless upgraded to read from the new `classifyObjection.ts` taxonomy.
- **Content-to-lead attribution** — `GET /content-attribution`
  (`apps/api/src/lib/contentAttribution.ts`) — closed via one small additive
  migration (`420_add_content_origin_to_landing_pages.sql`, nullable
  `content_calendar_item_id`/`content_draft_id` on `landing_pages`), joined
  against the pre-existing `custom_fields.landingPageId` lead identifier
  (found, not invented).
- **Channel performance comparison** — `GET /channel-performance`
  (`apps/api/src/lib/channelComparison.ts`), extends the existing
  `campaign_attribution` view's `campaign_channel` column rather than a
  parallel system.
- **Stalled-deal automation, now genuinely automatic** —
  `apps/worker/src/jobs/stalledDealCron.ts`, hourly, calls the existing
  (unmodified) `checkStalledDeals()`. Closes the gap flagged in the Milestone
  3 audit as "manual-trigger-only despite 'automatic' framing."
- **Lead-score recompute, now triggered on evidence change** — targeted
  (not a periodic sweep, a deliberate engineering choice documented in the
  agent's handback) recompute calls added right after `enrichLead()`
  succeeds and right after a reply is classified.

Verified for real: `tsc --noEmit` clean in both `apps/api` and
`apps/dashboard`; full `apps/api` suite **95/95 test files, 928/932 tests
passing, 4 skipped, 0 failures**; `apps/worker` suite 16/16 files, 106/106
tests passing. All `app.ts` wiring applied by me directly, sequentially,
after all agents returned, to avoid any race on that shared file — including
one load-bearing fix: `dealHealthRouter` must mount *before* the existing
`dealsRouter` or its bare `GET /:id` route would swallow `/deals/forecast`
and `/deals/lost-analysis` as invalid UUIDs.

**Known, explicitly out of scope / still honest gaps**: real pageview-based
"visitors" tracking (the existing "website traffic" number is a UTM/lead
proxy, not real analytics — flagged in the Milestone 1 audit as
disproportionate to self-host); any LLM-backed version of these features
(no LLM credentials exist anywhere in this codebase).

## Hunter.io contact discovery + email verification (merged from isolated branch)

Built by a dedicated agent in an isolated git worktree (per explicit
instruction: no merge into main until reviewed), then reconciled and merged
into this tree by hand. The agent's own self-written summary in its branch
is **out of date** relative to what actually landed — this entry is the
accurate one.

🟡 **Built, real, mock-tested — live-validation BLOCKED (no real
`HUNTER_API_KEY` available in this environment).**

- `apps/api/src/lib/hunterProvider.ts` — real Domain Search + Email Verifier
  HTTP client (pagination, credit-header capture, 401/429/5xx/timeout
  classification), endpoint shapes checked against Hunter's own published
  API docs. Adapts to the existing `DecisionMakerProvider` interface.
- `apps/api/src/lib/hunterEmailVerification.ts` — combines Hunter's paid
  tier with the existing free-tier DNS/MX verification
  (`emailVerification.ts`) rather than replacing it; accept-all/webmail are
  never reported as "valid."
- `apps/api/src/lib/hunterContactDiscovery.ts` — discovery/verification
  orchestration; reuses the EXISTING `dedup.ts` (person-identity dedup, not
  just shared-domain) rather than a new dedup system.
- `apps/api/src/lib/contactProvenance.ts` + migration
  `438_create_contact_provenance_events.sql` — a new, append-only provenance
  ledger (RLS-enabled via `439_enable_rls_contact_provenance_events.sql`),
  idempotent under retried jobs.
- `apps/api/src/lib/hunterClient.ts` (new, added during merge) — adapts
  `hunterProvider.ts` to the generic `checkHealth(credential)` contract
  `routes/integrations.ts`'s health-check route already expects.
- `apps/api/src/routes/hunterContacts.ts` — discovery/verify/provenance
  routes, mounted at `.../projects/:projectId/hunter`.

**What changed during reconciliation (the branch's own doc/summary predates
this):**
- The branch had built its OWN parallel `credentialEncryption.ts` +
  `integrationCredentials.ts` (the branch was cut before this tree's real
  Milestone 2 versions of those files existed). **Discarded the branch's
  copies**; rewired `hunterProvider.ts` to call this tree's real,
  already-in-use `getIntegrationCredential()` instead — Hunter credentials
  now go through the exact same per-tenant AES-256-GCM storage and the
  EXISTING generic `POST /integrations/hunter/connect` route that
  listmonk/chatwoot/postiz already use, not a second mechanism. Removed the
  branch's bespoke `PUT/DELETE /hunter/credential` routes accordingly (there
  is no disconnect endpoint for ANY provider in this codebase yet — a
  pre-existing, honest gap, not specific to Hunter).
- Renumbered migrations 284-287 (the branch's own numbers, now long since
  claimed by other work committed/landed since the branch was cut) to
  437-440.
- Added `'hunter'` to the existing provider registry
  (`routes/integrations.ts`'s `PROVIDERS`/`REAL_PROVIDERS`) and to the
  `integrations.provider` CHECK constraint (additive migration
  `437_add_hunter_to_integrations.sql`, following the exact pattern
  `285_add_chatwoot_to_integrations.sql` already established).
- Found and fixed one real, pre-existing bug in the branch's own test
  (`hunterContactDiscovery.test.ts`): its mock for `dedup.ts`'s name-based
  duplicate-lookup query didn't match that query's real text (the real
  query normalizes whitespace/case via `regexp_replace`; the test's regex
  expected a bare `name = $2`) — 3 tests were failing on this before the fix.
- Hunter is **not yet wired into** `buildDecisionMakerWaterfall()` — left
  for later, same as the branch itself noted.

Verified for real, after all of the above: `tsc --noEmit` clean in both
`apps/api` and `apps/dashboard`; full `apps/api` suite **102/103 test files,
994/1002 tests passing, 8 skipped (4 of which are the deliberately-skipped
real-Hunter-API test), 0 failures**. See `docs/PHASE_2_HUNTER_VALIDATION.md`
for the full verification-status mapping table and the complete, honest
BLOCKED-status list for every "real Hunter API" result.

## Milestone 3 audit — Broader Workstream Audit (read-only, no code changed)

A full, read-only, 5-agent audit of all remaining feature areas (chatbot,
growth analyzer/website analysis, SEO, content strategy/generation, landing
pages/lead magnets, inbound lead capture, outbound prospecting/ICP/discovery/
enrichment, email verification, lead scoring, CRM connective tissue, growth
analytics/revenue attribution) is complete. Full detail, per-feature file
citations, and the exact classification (1-7 taxonomy) for every area lives
in **`docs/BROADER_WORKSTREAM_AUDIT.md`**; the data-flow/connection view is
in **`docs/GROWTH_ENGINE_INTEGRATION_MAP.md`**; the proposed phased plan
(awaiting approval, nothing started) is in
**`docs/MILESTONE_3_IMPLEMENTATION_PLAN.md`**.

**Headline findings** (see the three docs above for full detail):
- Inbound lead capture (widget/chatbot/landing-page) is real, solid, and
  shares one code path — but **lead scoring is never triggered on capture**.
- **Scoring and CRM are two fully-built islands that never talk to each
  other** — no deal auto-creation from a high score, no auto-assignment,
  confirmed by grep (only 2 files in the whole codebase touch
  `lead_assignments` at all). This is the single highest-leverage gap found.
- "Automatic" stalled-deal follow-up detection is actually manual-trigger-
  only (no cron/job exists) — meeting-outcome follow-ups ARE genuinely
  automatic, confirmed by direct code read.
- Revenue attribution and CAC/ROI numbers were independently re-verified
  line-by-line: 100% real SQL aggregates, zero fabrication, honest
  `"not_available"` degradation when spend data is missing.
- **No SSRF guard exists anywhere a user-supplied URL is crawled** (chatbot
  website-import, Growth Analyzer, SEO audit all share this gap) — flagged
  as the single highest-value, lowest-effort security fix available.
- Zero LLM credentials exist anywhere in this codebase (not even a reserved
  env var) — every "AI content generation" feature is honestly-documented
  deterministic templating today, explicitly built to be a drop-in LLM swap
  later.
- Company discovery/enrichment/decision-maker-lookup all follow a
  consistent, deliberate "honest `not_configured` stub" pattern for anything
  needing a paid provider — never fabricated data.
- Two real test-coverage gaps found: `enrichLead()`'s matching logic and the
  Overpass connector's query/response parsing both have **zero direct unit
  tests** (only ever exercised through mocks of what they'd return).
- **A live regression was found and flagged, not fixed** (per this audit's
  own read-only rules): `apps/api`'s suite moved from 766/766 to 791
  passed/2 failed/8 skipped (801 total) during this audit, from the separate
  concurrent session's own current edits (`projects.slug` NOT NULL break,
  a Listmonk-webhook auth regression) — unrelated to anything audited here,
  but flagged as the first thing to resolve before new work starts.

No implementation code was modified to produce this audit, per instructions.

## Milestone 2 — Native CRM gap-fill (Companies/Contacts/Notes/Activity)

Per user approval: build a lightweight native CRM (Twenty used only as a
reference data model, not deployed) reusing the sales-pipeline tables a
concurrent session had already built (`deals`, `lead_assignments`,
`meetings`, `follow_up_tasks`/`crm_tasks`, the `customers` view,
`SalesPipelinePage.tsx`) rather than duplicating them. This round added the
two entities that were genuinely still missing:

- **Companies** (`302_create_companies.sql`) + `leads.company_id` FK
  (`303_add_company_id_to_leads.sql`, additive — the existing `leads.company`
  text column is left in place during the transition) + RLS
  (`304_enable_rls_companies.sql`). Full CRUD at
  `/api/v1/tenants/:tenantId/projects/:projectId/companies`
  (`apps/api/src/routes/companies.ts`), dashboard page
  `apps/dashboard/src/pages/CompaniesPage.tsx` (nav: "Companies").
- **Contacts** (`307_create_contacts.sql`, nullable FKs to `companies` and
  `leads` + RLS `308_enable_rls_contacts.sql`). Full CRUD at
  `.../contacts`, filterable by `?companyId=`
  (`apps/api/src/routes/contacts.ts`); reachable today only via a
  company's detail view in `CompaniesPage.tsx` (no standalone
  project-wide Contacts page yet — not asked for, flag if wanted).
- **Notes** (`312_create_notes.sql` + RLS `313_...`, attachable to a
  lead/deal/company/contact via a CHECK requiring at least one target;
  the company/contact FKs were added in a separate, later migration
  `316_add_notes_company_contact_fk.sql` so it could land independently of
  the companies/contacts migrations' timing). CRUD at `.../notes`
  (`apps/api/src/routes/notes.ts`).
- **Activity timeline** — a read-only aggregation, not a new event-log
  table: `apps/api/src/lib/activityTimeline.ts`'s
  `getLeadActivityTimeline()` merges `lead_assignments`, `deals`,
  `meetings`, `crm_tasks`, `notes`, and `lead_replies` into one
  chronological feed per lead. `GET .../leads/:leadId/activity`
  (`apps/api/src/routes/leadActivity.ts`). Dashboard components
  `ActivityTimeline.tsx`/`NotesPanel.tsx` are built and ready to drop into
  a lead-detail page once one exists (none exists yet —
  `SalesPipelinePage.tsx` is pipeline-wide, not per-lead).

Verified for real: `tsc --noEmit` clean in both `apps/api` and
`apps/dashboard`; 27/27 new tests pass
(`companies.test.ts`, `contacts.test.ts`, `notes.test.ts`,
`leadActivity.test.ts`); full API suite 744-752/757 passing depending on
exact moment (the only failures are in the concurrent session's own
in-flight Listmonk/Postiz files, untouched by this work — see
INTEGRATION_STATUS.md).

**Still missing from the user's requested module list**: a generic,
project-wide "Activities" page (the timeline exists per-lead via the API
and component, but isn't surfaced anywhere in the dashboard nav yet since
no lead-detail page exists to host it).

## Known cross-cutting bug fixed (earlier round)
`apps/api/src/middleware/tenant.ts` commits each tenant-scoped transaction
inside `res.json()` itself, before any bytes are written — see git history
if this area is ever touched again.

---

## Milestone 2 — Native CRM extensions + independent-service integrations (✅ complete, fully wired)

Full detail, test results, security/licence notes, and Milestone 3
priorities live in `docs/INTEGRATION_STATUS.md` (section 10 is the
authoritative final report). Summary:

- **Native CRM**: companies/contacts/notes, a composed lead-activity
  timeline (now including lead replies), and a real CRM dashboard — all
  built on top of the `deals`/`meetings`/`lead_assignments`/
  `follow_up_tasks` foundation from the prior round, not a rebuild.
- **Listmonk** (email/newsletter) — independent Docker service, real
  subscriber/campaign sync, approval-gated sends, suppression-list-aware,
  per-ESP bounce-webhook verification (SendGrid real, SES/Postmark
  documented gaps).
- **Chatwoot** (live chat/inbox) — independent Docker service, real HMAC
  webhook verification, widget embed, lead-to-contact sync now wired into
  `ingestLead()`. Coexists with (does not replace) the separate in-house
  deterministic chatbot.
- **Postiz** (social publishing) — upgrades the existing
  `NotConfiguredPostizProvider` stub to a real implementation of the same
  interface; independent Docker service including a full Temporal cluster;
  publish blocked without a real approved `approvals` row.

This round also finally fully reconciled app.ts/App.tsx/Layout.tsx against
**two concurrently-running orchestrator sessions** executing the same
Milestone 2 plan — confirmed no functionality was lost or duplicated.
**763/763 API tests, 101/101 worker tests, clean builds across all four
workspaces.**
cat: /tmp/feature_status_append.md: No such file or directory

---

## Milestone 3, Phase 1 — Real-world smoke testing (✅ complete, verified)

Full detail: `docs/MILESTONE_3_REPORT.md`, `docs/INTEGRATION_STATUS.md`
§§11-14, `docs/SECURITY_REVIEW.md`'s "RLS bypass" entry. Summary:

- Listmonk and Chatwoot fully verified end-to-end against real running
  containers (real connect/sync/webhook/retry/tenant-isolation/failure-
  recovery). Postiz likewise, after the orchestrator fixed two real bugs
  found along the way (a Temporal dynamic-config path, and a route-
  shadowing bug in `app.ts` that silently defeated Postiz's own
  dedicated connect/health-check verification).
- SES webhook signature verification implemented and tested for real
  (Postmark re-confirmed to have no signature scheme at all).
- Chatwoot identity verification (HMAC) implemented additively, with a
  byte-exact real cross-check against Chatwoot's own Ruby implementation.
- **Critical, platform-wide fix**: the application's Postgres connection
  was a real superuser with `rolbypassrls=true`, meaning RLS was never
  actually enforced at the database level since Phase 1 — fixed with a
  dedicated non-superuser `devlaunch_app` role (migration 321) plus a
  startup check that makes the regression impossible to reintroduce
  silently.
- A second, independent real bug (the worker's sequence-scheduler cron
  failing in every real container deployment) was found and fixed while
  verifying the above.
- 804/808 API tests passing (4 pre-existing, honestly-skipped tenant-
  isolation tests now unblocked by the RLS fix — follow-up to convert
  them to real passing assertions), 101/101 worker tests, clean builds.

---

## Milestone 3, Phase 2 — Intelligent Lead Acquisition (✅ complete, verified)

Three agents, audit-first (most of Phase 2's requirement list already
existed from Milestones 1-2 — this was a completion/wiring pass, not a
rebuild):

- **ICP + discovery provider architecture + prospecting campaigns**
  (Agent 1): generalized the existing generic `providerWaterfall.ts`
  (previously only used by decision-maker lookup) into company/target
  discovery itself via a new `POST /discovery-sources/run`. Closed the
  real "no campaign tracking" gap: `prospecting_campaigns` (migrations
  323-324) — name/goal/ICP target/status lifecycle, multi-source waterfall
  ordering, and a live (never cached/fabricated) results summary.
- **Decision-maker + enrichment + verification providers** (Agent 2):
  confirmed decision-maker lookup was already correctly pluggable. Closed
  two real gaps: `companyEnrichment.ts` had no provider interface at all
  (now waterfall-based, with `source_confidence` propagation — migration
  322); email/phone verification had no provider-swap seam and zero direct
  unit tests (both closed, same `NotConfigured*` convention).
- **Scoring explanations + buying-intent provenance + dedup + CRM sync**
  (Agent 3): confirmed scoring evidence and buying-signal provenance were
  already fully real and surfaced. Fixed a real dedup bug (unnormalized
  contact-name comparison). Closed the single highest-leverage gap: a new
  `POST .../leads/:leadId/promote-to-crm` endpoint — the first real bridge
  from the discovery/scoring pipeline into the Milestone 2 CRM (companies/
  contacts/lead_assignments), with real qualification gating and
  round-robin auto-assign, now wired into `LeadDetailPage.tsx`.

**Orchestrator reconciliation**: wired `prospectingCampaignsRouter`/
`leadPromotionRouter` into `app.ts`, built the missing
`ProspectingCampaignsPage.tsx` dashboard page (flagged but not built by
Agent 1, out of its stated scope), added the "Promote to CRM" action to
`LeadDetailPage.tsx`, and added both to `App.tsx`/`Layout.tsx`'s nav.

**Verified**: `@devlaunch/api` and `@devlaunch/worker` build clean,
dashboard `tsc --noEmit` clean. Full API suite: 927/932 passing, 4
pre-existing honest RLS-dependent skips, 1 unrelated failure in another
concurrent session's own in-progress feature (`classifyObjection.test.ts`
— not in any of this phase's 3 agents' scope, left to that session). Zero
regressions from this phase's own work.
