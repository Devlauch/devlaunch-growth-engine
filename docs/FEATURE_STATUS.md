# Feature Status — single source of truth

**Last updated:** 2026-11-21
**Updated by:** Claude (orchestrating 3 parallel build agents + 1 e2e sanity agent this round)

This file is the one place to check "is X built yet" across the whole
20-item growth-platform roadmap. Multiple AI sessions/agents work on this
repo in parallel without seeing each other's conversations — this file (not
chat history) is their shared memory of what's actually done.

**Rule for whoever picks up work next (human or agent): before starting,
read this file. After landing a feature, update this file in the same
change** — move the item from ⬜/🟡 to ✅, add the evidence line(s), and bump
"Last updated". Don't let this drift from the code; if you're not sure
something still works, mark it 🟡 with a note rather than leave stale ✅.

Status legend: ✅ built & tested · 🟡 partially built / stubbed honestly ·
⬜ not started

Other docs in this folder are point-in-time or topic-specific and are **not**
kept current the way this file is: `PHASE1_REPORT.md` and
`IMPLEMENTATION_PLAN.md` describe the original Phase 1 scaffold (now behind
current state), `DISCOVERY.md` is a deep-dive on item 1/2's connector
internals, `API_DEVIATIONS.md`/`DECISIONS.md`/`SECURITY.md` are rationale
records. Treat this file as the index; follow its evidence pointers into
those or into the code for depth.

---

## A. Find more leads

### 1. Real source connectors — 🟡 partial
One real connector is live end-to-end; three are schema-ready but not
implemented.
- ✅ Plug-in interface (`SourceConnector`), per-source rate limiter, terms
  note, per-tenant on/off switch: `packages/agent-sdk/src/connectors/` (moved
  here from `apps/worker/src/connectors/` so `apps/api` can call connectors
  directly — see `docs/DISCOVERY.md` "Why the connector code moved").
- ✅ `public_directory` connector: real, no-key **Overpass API** (OpenStreetMap),
  15 fixed categories, self-throttled. `publicDirectoryConnector.ts`.
- ✅ `csv_upload` connector: real hand-rolled RFC4180 CSV parser.
  `csvConnector.ts`. **Not yet wired to an API route** — the
  `discovery-sources` route currently only accepts `connectorType:
  "public_directory"` (400s on `csv_upload`), so the parser exists but isn't
  reachable from the dashboard/API yet.
- ⬜ `website_crawl` as a *source connector* (distinct from the Crawl4AI
  research adapter in item 2, which crawls a *known* org's own site, not a
  discovery source in its own right) — not built.
- ⬜ Licensed data provider API — intentionally a stub
  (`NotConfiguredError`, never fabricates data) pending a real paid key.
- ✅ **Check from spec met**: a discovery-source run against `public_directory`
  returns real organizations, each with a `source_url` and `discovered_at`.
  Verified via `scripts/e2e-smoke-test.mjs`.
- Evidence: `apps/api/src/routes/discovery.ts`, `packages/db/migrations/026-029`,
  `apps/worker/test/connectors/*`, `docs/DISCOVERY.md`.

### 2. Website research with Crawl4AI — 🟡 partial, unverified against a live instance
- ✅ Real robots.txt parser (longest-match Allow/Disallow), per-domain rate
  limiting, page-type classification (contact/about/departments/placement/news),
  email/phone extraction from fetched HTML — all unit-tested without a live
  Crawl4AI instance.
- ✅ `Crawl4AIResearchAdapter`/`crawlOrganizationSite()` refuses outright
  (throws) rather than fabricating a result if the Crawl4AI service is
  unreachable — matches this codebase's no-fake-data convention.
- 🟡 **Not verified live**: the exact `POST {baseUrl}/crawl` request/response
  shape is implemented against a best-guess of Crawl4AI's documented API
  (with a fallback parse path), and the `crawl4ai` service added to
  `docker-compose.yml` uses an unpinned `unclecode/crawl4ai:latest` tag and a
  guessed `/health` path. **Action needed:** bring the `crawl4ai` container up
  for real and confirm/fix the one `HttpCrawl4AIBackend` class if its
  contract differs — nothing else needs to change if so.
- Evidence: `apps/worker/src/agents/researchAdapter.ts`, `websiteCrawler.ts`,
  `robotsTxt.ts`, `docker-compose.yml` (`crawl4ai` service).

### 3. Contact discovery (lawful only) — ✅ built
- Role-based vs. named-person vs. contact-form vs. phone channel
  classification (`contact_channel` column), verification_status enum
  (`verified`/`unverified`/`role_based`/`risky`/`invalid`).
- Evidence: `packages/db/migrations/028_create_discovered_contacts.sql`,
  `apps/api/src/routes/discovery.ts` (contact sub-routes).

### 4. Email and phone verification — ✅ built
- Real RFC-5322-ish syntax check + live `dns.promises.resolveMx` MX lookup +
  role-based local-part heuristic (info@/contact@/admin@/etc., correctly
  treated as a valid category, not a rejection). DNS failures degrade to
  `risky`, never throw.
- Phone: E.164 plausibility check + normalizer.
- Evidence: `apps/api/src/lib/emailVerification.ts`,
  `apps/api/src/lib/phoneVerification.ts`, `apps/api/test/discovery.test.ts`.

### 5. Deduplication — ✅ built
- Org dedup by normalized domain (exact) then normalized name, scoped to
  tenant+project; enforced at both the application layer
  (`findDuplicateOrganization`) **and** a DB-level partial unique index.
- Contact dedup by normalized email within an organization, same
  app-layer + DB-unique-index pattern.
- Re-POSTing a known-duplicate org/contact returns `{ duplicate: true }` and
  does not insert a second row — verified live via
  `scripts/e2e-smoke-test.mjs`.
- ⬜ **Gap vs. spec**: no "merge records" UI/endpoint yet — duplicates are
  detected and skipped, not merged. No dashboard "duplicate warning" surface
  either (`DiscoveryPage.tsx` doesn't yet show a merge/duplicate-review UI).
- Evidence: `apps/api/src/lib/dedup.ts`.

### 6. Inbound lead capture upgrades — ⬜ not started
- The embeddable widget (`packages/embed-widget/embed.js`) and
  `publicLeads.ts` work (origin-allowlisted, rate-limited, writes to `leads`)
  but have none of: UTM/source tracking fields, a qualifying question, an
  instant "thank you" + booking link, per-audience landing pages, or a lead
  magnet. This is the next natural item to pick up in section A.

---

## B. Qualify the right leads

### 7. Configurable scoring — 🟡 mostly built, not yet wired to real evidence
- ✅ Per-project rubric (`scoring_rubrics`, weighted criteria array), a
  deterministic `lead-scoring` worker agent (hard "missing evidence scores
  zero" rule — not a suggestion, enforced), `why_summary` +
  `next_research_note` generation, good/bad feedback endpoint
  (`lead_score_feedback`).
- 🟡 `POST .../lead-scores/:leadId/recompute` is a documented `501` stub, not
  wired up — nothing yet automatically assembles "evidence" for a lead from
  its matching `discovered_organizations`/`discovered_contacts`/crawled pages
  and feeds it to the scoring agent. The scoring math/output works
  (unit-tested), but nothing calls it against a real lead's real evidence
  yet. **This is the next thing to build to make scoring end-to-end real.**
- ⬜ No dashboard UI for rubric config or viewing a lead's score/why-summary
  (no `ScoringPage.tsx` yet — only `DiscoveryPage.tsx` exists for the
  discovery feature).
- ⬜ "Use feedback to tune weights later" — feedback is captured
  (`lead_score_feedback` rows exist) but nothing reads it yet to adjust
  rubric weights. Expected: spec says do this after 30-50 outcomes, so this
  is correctly deferred, not a bug.
- Evidence: `packages/db/migrations/031-034`, `apps/worker/src/agents/leadScoring.ts`,
  `apps/api/src/routes/scoring.ts`.

### 8. Priority queue — ✅ built (API only, no dashboard UI yet)
- `GET /priority-queue` — real paginated SQL, `LEFT JOIN lead_scores`,
  `total_score DESC NULLS LAST` then freshness, status/minScore filters, real
  `COUNT(*)` total (not estimated/faked).
- `GET /priority-queue/today` — daily top-N actionable leads, honest empty
  state when nothing is scored yet (no placeholder rows).
- ⬜ No dashboard page consumes this yet.
- Evidence: `apps/api/src/routes/priorityQueue.ts`,
  `apps/api/test/priorityQueue.test.ts` (12 tests).

---

## C. Create more message opportunities — ⬜ not started (items 9-13)

Nothing built yet for: personalized message drafting (9), multi-step
sequences (10), additional send channels behind approval (11), the
approval-screen UI for messages specifically (12 — note: a *campaign*
approval flow already exists and is unrelated, see below), or reply handling
(13). This is the natural next section after closing out 7/8's gaps.

(Side note, not a roadmap item but relevant context: **Campaigns** —
draft → submit-for-approval → approve/reject — is already built and tested,
reusing the real `approvals` table. An approved campaign explicitly shows
"sending integration not yet connected"; no fake auto-send exists. This is
infrastructure items 9-12 will eventually plug into, not itself item 9-12.
Evidence: `apps/api/src/routes/campaigns.ts`, `apps/dashboard/src/pages/CampaignsPage.tsx`.)

## D. Make sure messages are delivered — ⬜ not started (item 14)

No per-tenant SPF/DKIM/DMARC onboarding, warm-up limits, or bounce/complaint
monitoring. Depends on item 9-11 existing first (nothing to deliver yet).

## E. Pipeline and learning — 🟡 partial

### 15. CRM and pipeline — ⬜ not started
`integrations.ts` lists Twenty (and others) honestly as `not_connected` — no
real sync exists yet, by design (no real third-party accounts to connect
to). Evidence: `apps/api/src/routes/integrations.ts`.

### 16. Funnel analytics — 🟡 partial
Real aggregate queries exist (leads/campaigns/executions by status, 30-day
trend) via `analytics.ts`/`AnalyticsPage.tsx`, showing real numbers or "no
data yet" — but the funnel stages don't yet include the lead-discovery or
scoring stages (discovered → qualified → contacted → replied → demo → won),
since contacting/replying isn't built yet (section C). Will need extending
once C exists.

### 17. Learning loop — ⬜ not started
Depends on message variants (item 9) existing to compare.

## F. Compliance — ⬜ not started (item 18)
No suppression list, unsubscribe handling, or consent records yet. **Must be
built before any real item 9-13 sending goes live** — do not wire a real
send channel without this.

## G. Make it work for any company — ⬜ not started (item 20)
No onboarding wizard yet.

---

## Suggested next build order (unchanged from original plan, updated for what's now done)

1. ~~Source connectors + Crawl4AI research (1-3)~~ — done (connector
   framework + Overpass connector real; Crawl4AI adapter real but needs live
   verification)
2. ~~Verification + dedup (4-5)~~ — done, except merge-duplicates UI
3. ~~Scoring + priority queue (7-8)~~ — done, except wiring scoring to real
   evidence (the `/recompute` 501 stub) and both features' dashboard pages
4. **→ next:** finish item 7's evidence-wiring + a Scoring/Priority-Queue
   dashboard page, then move to message drafting/sequences/approval screen
   (9, 10, 12)
5. Sending setup + compliance (14, 18) — build compliance *before* any real
   send channel
6. Reply handling + CRM sync (13, 15)
7. Analytics/learning-loop extensions (16-17)
8. Onboarding wizard (20)

## Known cross-cutting bug fixed this round

`apps/api/src/middleware/tenant.ts` committed each tenant-scoped transaction
on the response's `finish` event (i.e. *after* bytes were already sent),
creating a real race where a client's next sequential request could read
stale/missing data. Fixed by committing inside `res.json()` itself, before
any bytes are written. Verified with 3x back-to-back real end-to-end runs,
zero settle delay (`scripts/e2e-smoke-test.mjs`). If you ever see a
mysterious 404-right-after-create or stale-read bug reappear in a *new* route
that bypasses `res.json()` (e.g. a future streaming or `res.send()` response),
re-check this file first.
