# Feature Status — single source of truth

**Last updated:** 2026-11-22
**Updated by:** Claude (reconciled Phase 4 workflow orchestration — 6 parallel
build agents — and wired it in; audited everything else currently on disk)

This file is the one place to check "is X built yet" across Phase 1 (core
growth-platform roadmap), Phase 2 (advanced marketing intelligence agents),
and Phase 4 (cross-agent workflow orchestration). Multiple AI
sessions/agents work on this repo in parallel without seeing each other's
conversations — **this file is their shared memory of what's actually
done; update it whenever you land something.**

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
and is **currently mid-edit** on a client-facing PDF reports feature
(`reports.ts`/`reportSchedules.ts`/`ReportsPage.tsx`/`reportQueue.ts`). If
you're a new session picking this up, run `git status` and
`git log --oneline -10` first — this file can only be as fresh as the last
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
- **Client PDF reports** — 🔧 **in progress, currently broken on disk.** `apps/api/src/routes/reports.ts`/`reportSchedules.ts`/`apps/worker/src/reports/` exist and migrations `240-242` are staged, but `apps/dashboard/src/pages/ReportsPage.tsx` imports `GeneratedReport`/`GenerateReportResult`/`ReportSchedule` from `apps/dashboard/src/api/types.ts`, which don't exist there yet — **dashboard build currently fails** on this alone (confirmed: `apps/api` builds and all 431 API tests pass; only the dashboard `tsc` step fails, isolated to this one file). Not this session's work — leave it to the other session; don't "fix" `api/types.ts` without seeing their intended shape.

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

## Reconciliation notes (read before adding new migrations)

**Migration numbering is now at 242** (`242_enable_rls_reports.sql`, staged/uncommitted by the other session). Known collisions so far, all resolved by renumbering the side with fewer/no FK dependents:
1. Three Phase-1 agents landed at 052-056 simultaneously → renumbered to 064-065.
2. Phase 2's Competitor Intelligence agent's 066-069 collided with the other session's `066_extend_membership_roles.sql` → renumbered to 096-099.

**Always `ls packages/db/migrations | sort -V | tail -10` AND `git status`
immediately before creating a new migration** — multiple sessions/agents
land files concurrently in this repo.

## What's left (small, concrete punch list)

1. Wire `csv_upload` into the `discovery-sources` connector-type allowlist (Phase 1 item 1).
2. A scheduler/cron for `POST /sequences/advance` (Phase 1 item 10) — the Phase 4 workflow's execution stage is a manual-trigger path, not a replacement for this.
3. Postiz social-post integration, real CRM sync (Phase 1 items 11/15 — need real accounts).
4. Rubric-weight auto-tuning once `rubric-review-readiness` reports ≥30 outcomes.
5. A paid SERP API key to replace the keyword-ranking stub (Phase 2 item 3).
6. Wire a real LLM call behind `contentGeneration.ts`/`messageDrafting.ts`/`marketingQa.ts` (and now the Phase 4 content/research stages that reuse them), if/when an API key is available — all were deliberately built so this is a drop-in swap.
7. Run all 6 Phase 2 features, and the full Phase 4 workflow, against a real tenant end-to-end (`scripts/e2e-smoke-test.mjs` only covers Phase 1 today).
8. Finish the in-progress Reports feature (other session's work — see Phase 3 above): add `GeneratedReport`/`GenerateReportResult`/`ReportSchedule` to `apps/dashboard/src/api/types.ts` so `ReportsPage.tsx` compiles, then wire its route/nav the same way this round wired Workflows.

## Known cross-cutting bug fixed (earlier round)
`apps/api/src/middleware/tenant.ts` commits each tenant-scoped transaction
inside `res.json()` itself, before any bytes are written — see git history
if this area is ever touched again.
