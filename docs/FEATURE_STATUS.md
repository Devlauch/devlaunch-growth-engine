# Feature Status — single source of truth

**Last updated:** 2026-11-22
**Updated by:** Claude (Phase 2: 6 parallel build agents — Competitor Intelligence, Content Strategy, Technical SEO, Advanced Lead Intelligence, Conversion Optimization, Marketing Intelligence — plus reconciliation)

This file is the one place to check "is X built yet" across Phase 1 (the
core growth-platform roadmap) and Phase 2 (advanced marketing intelligence
agents). Multiple AI sessions/agents work on this repo in parallel without
seeing each other's conversations — **this file is their shared memory of
what's actually done; update it whenever you land something.**

Status legend: ✅ built & tested · 🟡 partially built / stubbed honestly ·
⬜ not started

Other docs in this folder: `PHASE1_REPORT.md`/`IMPLEMENTATION_PLAN.md` are
historical. `DISCOVERY.md`/`CRAWL4AI_VERIFICATION.md` are topic deep-dives.
`API_DEVIATIONS.md`/`DECISIONS.md`/`SECURITY.md` are rationale records.

**Note on concurrent sessions:** this repo has had at least two Claude
sessions working on it in parallel across these rounds (this session's
Phase 1/2 agents, and a separate session that built real RBAC —
`apps/api/src/middleware/rbac.ts`, extended membership roles via migration
`066_extend_membership_roles.sql`). If you're a new session picking this
up, run `git status` and `git log --oneline -10` first to see what else is
in flight before assuming this file is the complete picture.

---

# Phase 1 — core platform

## A. Find more leads
1. **Source connectors** — ✅ mostly done. Overpass public-directory connector live end-to-end. CSV connector built but not yet wired into the API's connector-type allowlist. Licensed-provider API is an honest stub.
2. **Crawl4AI website research** — ✅ verified live against a real `unclecode/crawl4ai:0.9.6` container this round (found/fixed a real container networking trap, pinned the image tag).
3. **Contact discovery** — ✅ done.
4. **Email/phone verification** — ✅ done.
5. **Deduplication** — ✅ done (detection + skip; no merge UI).
6. **Inbound capture upgrades** — ✅ done (UTM/referrer, qualifying question, thank-you/booking link). Landing pages per audience + lead magnet still ⬜.

## B. Qualify the right leads
7. **Configurable scoring** — ✅ done, including a real `/recompute` evidence pipeline.
8. **Priority queue** — ✅ done, with dashboard UI.

## C. Create more message opportunities
9. **Message drafting** — ✅ done (deterministic, evidence-grounded, not an LLM call).
10. **Multi-step sequences** — ✅ done (manual-trigger advance; no cron yet).
11. **More channels / CRM tasks** — 🟡 CRM-tasks piece done; real sending integrations and Postiz remain ⬜ by design.
12. **Approval screen** — ✅ done (reuses the existing `approvals` table/state machine).
13. **Reply handling** — ✅ done (deterministic classifier, manual/webhook ingestion).

## D. Delivery
14. **Sending setup per tenant** — ✅ done, including real live-verified SPF/DMARC DNS checks.

## E. Pipeline and learning
15. **CRM sync** — ⬜ not started (needs a real third-party account).
16. **Funnel analytics** — ✅ extended with a real `/funnel` endpoint.
17. **Learning loop** — ✅ done (reporting only, as expected — no send volume yet to compare).

## F. Compliance
18. **Suppression & consent** — ✅ done — the `checkSendEligibility` gate every send-adjacent feature now calls.

## G. Any company
20. **Onboarding wizard** — ✅ done, 4 real industry templates, idempotency-safe.

---

# Phase 2 — advanced marketing intelligence (all 6 items ✅ built this round)

### 1. Competitor Intelligence Agent — ✅ done
Reuses the verified Crawl4AI infra to crawl a competitor's site (4 fixed paths), stores per-page content hashes, diffs against the prior snapshot to detect `new_page`/`content_changed`/`page_removed`, real TF-based keyword extraction (explicitly documented as not a paid SEO tool), and a real templated positioning report.
Evidence: `packages/db/migrations/096-099` (renumbered from an original 066-069 collision — see note below), `apps/worker/src/agents/competitorIntelligence.ts`, `apps/api/src/routes/competitors.ts`, `apps/dashboard/src/pages/CompetitorIntelligencePage.tsx`.

### 2. Content Strategy Agent — ✅ done
Deterministic, brand-voice-aware 30-day calendar generation (real cadence + ICP pain-point rotation) and real blog-repurposing (paragraph/sentence extraction into LinkedIn/email/thread/summary formats). Explicitly NOT an LLM call — same honesty convention as message drafting.
Evidence: `packages/db/migrations/071-074`, `apps/api/src/lib/contentGeneration.ts`, `apps/api/src/routes/contentStrategy.ts`, `apps/dashboard/src/pages/ContentStrategyPage.tsx`.

### 3. Technical SEO Agent — ✅ done
Real sitemap/robots/broken-link/metadata audits (zero external accounts needed). Real Google PageSpeed Core Web Vitals integration, honestly reporting `not_configured` without an API key (`GOOGLE_PAGESPEED_API_KEY` env var, optional). Keyword rank tracking is an honest `NotConfiguredRankingProvider` stub pending a paid SERP API — never fabricates a position.
Evidence: `packages/db/migrations/076-079`, `apps/api/src/lib/siteAudit.ts`/`coreWebVitals.ts`/`keywordRankingStub.ts`, `apps/api/src/routes/seo.ts`, `apps/dashboard/src/pages/SeoAuditPage.tsx`.

### 4. Advanced Lead Intelligence Agent — ✅ done
A complementary layer on top of (not a replacement for) the existing scoring system: company enrichment via domain/name matching to `discovered_organizations`, deterministic ICP-fit scoring (zero score on no match, same discipline as rubric scoring), keyword-based buying-signal detection (hiring/funding/expansion/leadership/product-launch), and a composed `/explain` endpoint.
Evidence: `packages/db/migrations/081-084`, `apps/api/src/lib/companyEnrichment.ts`/`icpMatching.ts`/`buyingSignals.ts`, `apps/api/src/routes/leadIntelligence.ts`, `apps/dashboard/src/pages/LeadIntelligencePage.tsx`.

### 5. Conversion Optimization Agent — ✅ done
Real landing-page audits (CTA/form/word-count/heading checks via direct fetch+regex), real funnel drop-off math (reusing the same real stage-count queries as analytics.ts's `/funnel`), rule-based A/B experiment suggestions driven only by actual findings, and real experiment tracking with a minimum-sample-size guard before declaring a winner.
Evidence: `packages/db/migrations/087-090`, `apps/api/src/lib/landingPageAudit.ts`/`funnelDropoff.ts`/`experimentSuggestions.ts`, `apps/api/src/routes/conversionOptimization.ts`, `apps/dashboard/src/pages/ConversionOptimizationPage.tsx`.

### 6. Marketing Intelligence Agent — ✅ done
"Ask in natural language" is honestly a deterministic intent classifier (5 supported question types, ordered regex rules, explicit non-LLM documentation) over real queries — not true NLU. Real weekly/monthly report generation, rule-based next-best-action recommendations (reuses `shouldPauseForHealth` from the sending-setup feature). Every question (matched or not) is logged for audit.
Evidence: `packages/db/migrations/092-094`, `apps/api/src/lib/marketingQa.ts`/`nextBestAction.ts`/`reportGenerator.ts`, `apps/api/src/routes/marketingIntelligence.ts`, `apps/dashboard/src/pages/MarketingIntelligencePage.tsx`.

---

## Reconciliation notes (read before adding new migrations)

**Migration numbering is now at 099.** This round alone saw two real
collisions:
1. Three Phase-1-round agents landed at 052-056 simultaneously (resolved by
   renumbering to 064-065 last round).
2. This round, the Competitor Intelligence agent's 066-069 collided with a
   **separate concurrent session's** `066_extend_membership_roles.sql`
   (real RBAC work, unrelated to Phase 2) — resolved by renumbering the
   competitor tables to 096-099, since they had zero dependents and the RBAC
   migration was a different session's active work.

**Always `ls packages/db/migrations | sort -V | tail -5` AND `git status`
immediately before creating a new migration** — multiple sessions/agents
land files concurrently in this repo.

## What's left (small, concrete punch list)

1. Wire `csv_upload` into the `discovery-sources` connector-type allowlist (Phase 1 item 1).
2. A scheduler/cron for `POST /sequences/advance` (Phase 1 item 10).
3. Postiz social-post integration, real CRM sync (Phase 1 items 11/15 — need real accounts).
4. Rubric-weight auto-tuning once `rubric-review-readiness` reports ≥30 outcomes (Phase 1 item 7/17).
5. A paid SERP API key to replace the keyword-ranking stub (Phase 2 item 3).
6. Wire a real LLM call behind `contentGeneration.ts`/`messageDrafting.ts`/`marketingQa.ts`'s existing function signatures, if/when an API key is available — all three were deliberately built so this is a drop-in swap, not a rewrite.
7. Run all 6 Phase 2 features against a real tenant end-to-end (only Phase 1 features got a live HTTP smoke-test pass so far — see the e2e script at `scripts/e2e-smoke-test.mjs`, which predates Phase 2 and doesn't cover it yet).

## Known cross-cutting bug fixed (earlier round)
`apps/api/src/middleware/tenant.ts` commits each tenant-scoped transaction
inside `res.json()` itself, before any bytes are written — see git history
if this area is ever touched again.
