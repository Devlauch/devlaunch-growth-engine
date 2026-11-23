# Broader Workstream Audit

Read-only audit of all in-flight functionality across the DevLauch Growth Engine
platform (`~/project/Growth/platform`), produced by five parallel, read-only
research passes. No implementation code was modified to produce this document.

Classification taxonomy used throughout, exactly as specified:

1. Fully implemented and tested
2. Implemented but mock-tested only
3. Partially implemented
4. In progress in another session
5. Planned but not implemented
6. Duplicate or obsolete
7. Blocked by provider credentials or external dependencies

**A note on "tested" across this entire codebase**: essentially every test file
in `apps/api/test` mocks the Postgres pool (`vi.mock("../src/db/pool.js", ...)`)
and/or outbound HTTP. This is appropriate, deliberate contract testing (it
verifies the right queries/params fire in the right order), but it means
**almost nothing in this codebase has been verified against a real running
Postgres instance with RLS actually enforced**, with one partial exception
(Crawl4AI's HTTP contract, verified live — see below, and only for the
worker's copy of the client, not apps/api's). Treat "classification 1" and "2"
as closer than they sound: both mean "real, working code," differing only in
whether a live dependency was ever actually exercised.

**Flagged regression (found, not fixed, per this audit's own rules)**: at the
moment of this audit, the full `apps/api` suite was 791 passed / 2 failed / 8
skipped (801 total, up from the 766/766 a prior round certified minutes
earlier) — `test/integrationIdempotency.test.ts` and
`test/integrationTenantIsolation.test.ts` both fail on `null value in column
"slug" of relation "projects"`, and `test/listmonkWebhooks.test.ts` has 2
assertions now getting 401 instead of 200. All three look like breakage from
the separate concurrent session's current edits (a `projects.slug` NOT NULL
constraint and an auth change), not from anything audited here. **Recommend
this be looked at before anything else** — it is a live regression, not a
backlog item.

---

## 1. AI chatbot

**Classification: 2 — Implemented but mock-tested only.**

Real, DB-backed, RLS-protected (`284_enable_rls_chatbot.sql`, force-enabled),
fully mounted in `app.ts` (public widget at `/api/v1/public`, admin at
`/api/v1/tenants/:tenantId/projects/:projectId/chatbot`). Deterministic
TF-style knowledge matcher (`apps/api/src/lib/chatbotEngine.ts`) — explicitly
**not** an LLM call, honestly documented as such. Full consent → qualifying →
contact-capture state machine. Embed widget (`packages/embed-widget/chatbot.js`)
uses `textContent` only, no stored-XSS vector. 45 tests pass across
`chatbotEngine.test.ts`/`chatbotAdmin.test.ts`/`publicChatbot.test.ts`, all
mock-only.

**Chatbot → CRM**: real, not aspirational — the contact-capture branch calls
the same shared `ingestLead()` as every other inbound channel.

**Security gap**: the "import knowledge from website" feature (admin-only,
up to 5 URLs) has **no SSRF/private-IP guard** before handing URLs to
Crawl4AI — see cross-cutting SSRF finding below.

**Credentials needed**: `CRAWL4AI_BASE_URL`/`CRAWL4AI_API_TOKEN` for the
website-import feature only; everything else needs zero external credentials.

## 2. Website crawling and business analysis (Growth Analyzer)

**Classification: 2 — Implemented but mock-tested only**, with the underlying
Crawl4AI HTTP contract unusually well-verified (see below).

Orchestrates sitemap/robots discovery → crawl via Crawl4AI → deterministic
keyword/value-prop/audience/ICP extraction (fixed dictionaries/regex, no LLM,
honestly documented) → content-gap diffing against tracked competitors →
templated growth-plan summary. ICP acceptance writes into the **existing**
`icp_profiles` table, never a second ICP system. 18 tests pass, mock-only.

**Verification asymmetry (important)**: `docs/CRAWL4AI_VERIFICATION.md`
documents a real session against a live `unclecode/crawl4ai:0.9.6` container
— but that verification was performed against **the worker's** crawler class
(`apps/worker/src/agents/websiteCrawler.ts`'s `HttpCrawl4AIBackend`), not
against **apps/api's own**, separate client (`apps/api/src/lib/crawl4aiClient.ts`).
The two clients implement near-identical parsing logic by design (apps/api has
no runtime dependency on apps/worker) but apps/api's copy has never itself been
hit against a live container — only verified by code similarity. Don't
over-extend the verification doc's credibility to the apps/api path.

**Security gap**: same SSRF gap as chatbot — no guard on user-supplied domains
before crawling, and the analyzer additionally follows the target's own
sitemap.xml links, widening the URL set handed to Crawl4AI.

**Credentials needed**: `CRAWL4AI_BASE_URL`/`CRAWL4AI_API_TOKEN`; without it,
honestly returns `status: "failed"` with a real `Crawl4AINotConfiguredError`,
never fabricated content.

## 3. SEO analysis and keyword research

**Mixed classification:**
- Site audit (sitemap/robots/broken-links/metadata) + Core Web Vitals:
  **1/2 — functionally complete**, honest degrade-to-`not_configured` when
  `GOOGLE_PAGESPEED_API_KEY` is unset (it is, by default, `null`). No live
  PageSpeed API verification exists in this repo (no equivalent of
  `CRAWL4AI_VERIFICATION.md`).
- Keyword-rank tracking: **7 — blocked by provider credentials**. Code is
  real and complete (`NotConfiguredRankingProvider`, always honestly reports
  `source: "not_configured"`), but no rank-tracking provider has even been
  *chosen* yet — there's no env var placeholder for one at all, unlike
  PageSpeed.

24 tests pass, mock-only. Same SSRF caveat as above applies to `siteAudit.ts`'s
internal fetches (shared between SEO and the Growth Analyzer — not
reimplemented twice, which is good).

**Credentials needed**: `GOOGLE_PAGESPEED_API_KEY` (free tier available) for
Core Web Vitals; a paid SERP-tracking provider (none named yet) for keyword
rank tracking.

## 4. Content strategy

**Classification: 2 — Implemented but mock-tested only.**

Full CRUD for content calendars and drafts, real RLS-backed schema. Generation
logic (`apps/api/src/lib/contentGeneration.ts`) is deterministic template
assembly from `project_profiles`/`icp_profiles` — explicitly and honestly
**not** an LLM call, by design, not an unfinished stub. 23 tests pass,
mock-only. No public/unauthenticated surface — authenticated-tenant-only, so
no XSS/external-attack-surface concern the way landing pages have.

**Credentials needed**: none for what exists today.

## 5. AI content generation

**Classification: 2 (what exists) / 7 (what's aspired to).** The phrase "AI
content generation" implies an LLM-backed feature; what actually exists across
`contentGeneration.ts`, `landingPageBuilder.ts`, `draftMessage.ts`, and
`marketingQa.ts` is deterministic templating/regex-based logic, consistently
and explicitly documented in every file's header as **not** an LLM call.
`docs/FEATURE_STATUS.md`'s claim that these were "deliberately built so [a
real LLM] is a drop-in swap, not a rewrite" was independently verified
accurate against current code. **Zero LLM credentials exist anywhere in this
codebase** — `env.ts` has no `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/generic
`LLM_API_KEY` field at all, not even a `null`-defaulted placeholder (a
stronger absence than the PageSpeed/Calendly/Postiz pattern, which at least
reserves an env var).

No dedicated unit tests exist for any of these four lib files directly — only
exercised indirectly through route-level mock tests (48 tests combined across
`contentStrategy.test.ts`/`landingPages.test.ts`).

**Duplicate flagged**: `draftMessage.ts` (apps/api) and `messageDrafting.ts`
(apps/worker) are an intentional, documented duplicate algorithm with a manual
"keep in sync" comment — a latent drift risk, not currently diverged, but
worth tracking.

## 6. Landing pages

**Classification: 2 — Implemented but mock-tested only**, for CRUD/publish/
A/B-testing/stats (real RLS schema, real experiment-table reuse). 25 tests
pass, mock-only.

**Architecture note**: this is a headless/API-only feature by design — there
is **no in-repo HTML renderer** that turns a landing page's `blocks` JSON into
an actual page a visitor loads. The admin page (`LandingPageBuilderPage.tsx`)
is management-only. An external customer site is expected to fetch the JSON
and render it itself (same model as the embeddable lead widget).

**Security note**: no HTML sanitization exists on user-authored copy fields
(low risk in-repo today since nothing here renders them as raw HTML), but
because there's no in-repo public renderer, **stored-XSS risk hands off to
whatever external renderer eventually consumes this API** — worth flagging to
whoever builds that consumer.

## 7. Lead magnets and website forms

**Classification: 3 — Partially implemented**, and honestly documented as
such in the migration's own comment. CRUD around lead-magnet metadata is
complete; `file_url` is explicitly a stub — no file-upload/object-storage
infra exists, the tenant supplies/hosts the file URL themselves, with only a
length check (no URL-format/protocol-allowlist validation). Custom domains are
similarly **store-only** — no DNS/CDN provisioning logic anywhere, and the
dashboard's own UI text discloses this to the user. Both gaps confirmed still
accurate against current code.

## 8. Inbound lead capture

**Classification: 1 for the widget channel, 2 for chatbot/landing-page
channels** (same shared code path, same test realism, different test-file
coverage maturity).

**Full request-flow trace confirmed real, not just claimed**: rate limiting →
origin allowlist → RLS-scoped transaction → `ingestLead()` → real `leads`
INSERT → real `audit_events` INSERT → real `usage_events` INSERT → real
in-app `notifications` INSERT to owners/admins → best-effort, never-blocking
Chatwoot contact sync. All three inbound channels (widget, chatbot,
landing-page form) funnel through this **single shared** `ingestLead()` path —
no duplicate/competing insert logic found.

**Real gap found**: lead scoring is **not** triggered on inbound capture at
all — `scoreLead()` exists but `ingestLead()` never calls it. A new inbound
lead sits with no score until someone manually triggers `/recompute`.

**Security**: rate limiting is real and active (in-memory, single-process —
an honest, documented limitation, not hidden). IP hashing is real (SHA-256,
truncated). CORS is deliberately permissive at the HTTP layer with the real
access control enforced per-route against the project's `allowed_origins` —
an intentional two-layer design, though it means a non-browser client with a
spoofed Origin header bypasses the browser-CORS layer entirely (inherent to
the model, not a bug).

**Other finding**: `discovery.ts` inserts leads with `source: 'discovery'`,
which may not be in the `leads.source` CHECK constraint (`internal |
public_widget | agent | import` per migration 015) — **worth verifying this
doesn't silently fail or silently bypass the constraint**; flagged, not
confirmed, by the auditing agent.

## 9. Outbound prospecting / ICP generation

**Classification: 1 — Fully implemented and tested.** Deterministic word-
overlap scorer (segment/pain-points/channels), zero external dependency,
genuinely unit-tested as a pure function (not just mock-return assertions).
Wired end-to-end: profile CRUD → matching → workflow stage → route exposure →
dashboard.

## 10. Company discovery

**Mixed classification, by connector type:**
- `public_directory` (Overpass/OSM): **1 — fully implemented**, a real,
  working, free-API integration. Known Overpass flakiness (406 without a
  User-Agent header) has a documented, live-confirmed workaround in the code.
  Rate-limited, ToS-compliant (ODL attribution surfaced to the tenant).
- `csv_upload`: **3 — partially implemented** — the connector class exists
  in the SDK and is registered, but the route layer rejects creating a
  `csv_upload` source (400, "no UI/route wiring yet").
- `website_crawl` (Crawl4AI-backed): **5 — planned but not implemented** —
  explicitly rejected as "requires a separate, not-yet-approved Crawl4AI
  service" at the route layer, even though Crawl4AI itself is already a
  working dependency elsewhere in the codebase.
- `licensed_api` (paid B2B directory): **7 — blocked by provider
  credentials** — not even a reserved env var exists yet for this, just a
  documented extension-point interface.

**Real test-coverage gap found**: the Overpass client's own query-construction/
response-parsing logic (`OverpassDirectoryApiClient.search()`) has **zero
unit tests at any level** — every route test mocks the connector away
entirely.

**Duplicate flagged (intentional, not accidental)**: `leadGeneration.ts`
(workflow stage) and `discovery.ts` (route) independently reimplement nearly
identical discovery→persist logic, explicitly because the workflow stage runs
inside a transaction and can't call the route. A bugfix in one won't
propagate to the other — a real future consolidation risk.

## 11. Contact enrichment

**Classification: 3 — Partially implemented** (functionally complete for what
it claims — domain/name matching against already-discovered orgs, honest
"complementary intelligence layer" framing, never fabricates firmographics —
but with a **real, significant test-coverage gap**: `enrichLead()`'s actual
matching/firmographics-construction logic is exercised by **zero tests**,
mocked or otherwise — only ever referenced via `vi.mock()` replacement or by
tests that mock the DB row it would have produced, never the function
itself).

**Decision-maker lookup**: **7 — blocked by provider credentials**. Same
honest-stub pattern as discovery's `licensed_api` — `NotConfiguredDecision-
MakerProvider` always throws, every lookup genuinely records `status:
"not_configured"`. Code comments name Apollo/ZoomInfo/Clearbit as the
intended integration targets; none configured.

## 12. Email discovery and verification

**Classification: 1 — Fully implemented and tested**, for what exists: real
regex syntax check + real DNS MX lookup + role-based-address dictionary, zero
external credentials (uses Node's built-in DNS resolver), genuinely unit-
tested with real branching assertions. DNS-based sending-domain checks
(SPF/DMARC/DKIM) and phone-format plausibility checks are similarly real and
complete for their explicitly narrow scope.

**What does NOT exist**: "email finding" — discovering a new address from a
name + domain (permutation guessing, or a paid finder API). **Classification
5 — planned but not implemented** — not even a stub exists. If the platform's
roadmap needs this, it is a clean-slate build, not a wire-up.

## 13. Lead scoring (automation connective tissue)

Covered in detail under "Lead scoring" in the previous audit round.
**Automation gap confirmed by direct grep**: no BullMQ job or cron loop
recomputes scores — `POST /lead-scores/:leadId/recompute` is the only trigger,
manual-only, despite some documentation/comment language implying otherwise.

## 14. CRM integration — connective tissue (the parts not already verified)

**Classification: 3 — Partially implemented, honestly self-documented as
such in the code.**

- **Lead scoring does not feed into deal creation.** `POST /deals` never
  reads `lead_scores`; nothing gates deal creation on a score threshold.
- **`lead_assignments` is a CRUD-only island.** Confirmed by grepping all of
  `apps/api/src` and `apps/worker/src`: exactly 2 files touch this table (its
  own route, and one read-only display join in the activity timeline).
  Nothing auto-assigns a lead — not scoring, not the priority queue, not
  anything else.
- **Stalled-deal follow-up detection is manual-trigger-only**, despite
  "automatic" framing in some comments — confirmed via grep across
  `apps/worker/src`: zero matches for stalled-deal logic outside `apps/api`.
  `apps/worker/src/index.ts` registers exactly 3 recurring mechanisms (agent-
  run worker, report schedule loop, sequence scheduler cron) and none of them
  touch deals/follow_up_tasks.
- **Meeting-outcome follow-up creation IS genuinely automatic** — it fires
  inline on every `PATCH .../meetings/:id` outcome update, no scheduler
  needed. This is the one piece of "automatic" framing that's actually true.

## 15. Growth analytics and revenue attribution

**Classification: 2 — Implemented but mock-tested only** (API side); the
campaign-attribution feature specifically is **3 — partially implemented**
because its API is live but **no dashboard page exists for it at all**.

**Anti-fabrication check — the main ask here — passed cleanly, verified line
by line:**
- Every number is a live, tenant-scoped SQL aggregate; no literals standing
  in for real data anywhere in `growthRevenueAnalytics.ts` or
  `campaignAttribution.ts`.
- CAC/ROI explicitly return `"not_available"` with a `reason` field rather
  than a guessed number whenever spend data is missing or division would be
  by zero.
- The "website traffic" number is explicitly labeled (in the API response
  itself, not just a code comment) as leads-with-captured-UTM, not real
  pageview analytics — the honesty guard is user-visible.
- The qualified-lead union logic is reused from a single source of truth
  shared with the existing `/funnel` endpoint — no drift risk found.
- The `campaign_attribution` SQL view correctly joins every table through
  `tenant_id` at every step, on top of each underlying table's own RLS policy
  — no cross-tenant leakage path found in the cross-table aggregation, which
  was this audit's specific concern for this area.

**Real gap found**: only 4-6 tests cover a 300+ line file with several
distinct branches (degraded/non-degraded qualification, CAC null/zero/normal,
ROI null/zero/normal) — thin depth, not a realism problem.

---

## Cross-cutting findings (apply across multiple feature areas)

### Security

**No SSRF guard exists anywhere a user-supplied URL/domain is handed to a
crawler** — chatbot website-import, Growth Analyzer crawling, and SEO site
audits all share this gap. None validate that a domain doesn't resolve to a
private/internal/link-local address before fetching it directly or handing it
to Crawl4AI. Mitigated somewhat by all three being authenticated-tenant-only
(not anonymous/public) and by Crawl4AI being a separate process boundary, but
a malicious or compromised tenant admin account could still use any of these
three features to probe internal network addresses. **This is the single
highest-value, lowest-effort security fix identified by this entire audit** —
one shared SSRF-guard utility would close the gap in all three places at once.

### Testing

The entire `apps/api/test` suite is built on mocked Postgres/HTTP. This is
legitimate contract testing, not a weakness per se, but it means "tested" in
this codebase almost never means "verified against a real, RLS-enforcing
database." The two biggest *depth* gaps (not just mock-vs-real) found: (1)
`enrichLead()`'s actual matching logic has zero direct tests, and (2) the
Overpass connector's query/response parsing has zero tests at any level.

### Duplication

Three intentional, documented duplications exist (not concurrent-session
accidents): the Crawl4AI HTTP client (apps/api vs. apps/worker copies), the
message-drafting algorithm (apps/api vs. apps/worker copies), and the
discovery→persist pipeline (the HTTP route vs. the workflow-stage version).
All three are explicitly justified in code comments by apps/api having no
runtime dependency on apps/worker, or by the workflow stage needing to run
inside a single transaction. All three carry a real "fix drifts in one, not
the other" maintenance risk worth tracking, none urgent.

### Credentials and provider gaps (full list)

| Feature | Needs | Status today |
|---|---|---|
| Growth Analyzer / chatbot import / SEO audit | `CRAWL4AI_BASE_URL`/`CRAWL4AI_API_TOKEN` | Configured and working elsewhere; same client not independently live-verified in apps/api's copy |
| Core Web Vitals | `GOOGLE_PAGESPEED_API_KEY` | Null by default, free tier available, not yet set |
| Keyword rank tracking | A paid SERP-tracking provider | Not even chosen/named yet — no env var exists |
| Licensed company-directory discovery | A paid B2B directory API | Not chosen/named — documented extension point only |
| Decision-maker lookup | Apollo, ZoomInfo, or Clearbit (named in comments) | Not configured — honest `not_configured` stub |
| Real AI content generation (calendar/drafts/Q&A/growth-plan/chatbot) | An LLM API key | **Zero LLM credentials exist anywhere** — not even a reserved env var |
| Social publishing, email campaigns, live chat | Postiz/Listmonk/Chatwoot accounts | All three integration *code* paths exist (prior audit round) — real account/credential provisioning is an operational, not engineering, task |

### Automation reality check (the most load-bearing finding for planning)

Several features described in comments/docs as "automatic" are in fact
**manual-trigger-only** today:
- Lead score recompute
- Stalled-deal follow-up detection

Two things genuinely ARE automatic without any scheduler:
- Meeting-outcome follow-up creation (fires inline on PATCH)
- The three things `apps/worker/src/index.ts` actually registers: the
  BullMQ agent-run worker, the report schedule/generation loop, and the
  sequence scheduler cron.

This distinction matters directly for Milestone 3 prioritization — see the
implementation plan.
