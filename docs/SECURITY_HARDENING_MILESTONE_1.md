# Security Hardening — Milestone 1 (SSRF guard + production hardening)

Companion to `docs/BROADER_WORKSTREAM_AUDIT.md`'s cross-cutting finding:
**"no SSRF guard exists anywhere a user-supplied URL/domain is crawled"** —
flagged there as the single highest-value, lowest-effort security fix in the
codebase. This document covers what was built/patched for that finding, plus
a read-only audit of the rest of the platform's security posture.

## 1. Shared SSRF-guard utility

`apps/api/src/lib/ssrfGuard.ts` (and an intentionally duplicated
`apps/worker/src/lib/ssrfGuard.ts` — apps/worker has no runtime dependency on
apps/api, same precedent as `crawl4aiClient.ts`/`websiteCrawler.ts` and
`draftMessage.ts`/`messageDrafting.ts`) exports:

- **`assertSafeUrl(url, opts?)`** — rejects non-http(s) schemes, resolves the
  hostname's real DNS A/AAAA records (or validates a literal IP directly),
  and throws a typed `SsrfBlockedError` if ANY resolved address is
  loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16 — this is what
  blocks the AWS/GCP/Azure metadata endpoint at 169.254.169.254 — and
  fe80::/10), private (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7),
  or another reserved/cloud-metadata-adjacent range (0.0.0.0/8,
  100.64.0.0/10 CGNAT, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24,
  198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, multicast, class
  E/broadcast; the IPv6 equivalents ::1, ::, fe80::/10, fc00::/7, ff00::/8,
  and IPv4-mapped (`::ffff:0:0/96`) addresses re-checked against the IPv4
  list so a AAAA record can't smuggle a blocked v4 address past the v6
  checks).
- **`safeFetch(url, init?, opts?)`** — a drop-in `fetch` replacement built
  directly on `node:http`/`node:https` (not global `fetch`/undici, which have
  no public, non-experimental way to pin a connection to a pre-resolved IP).
  It validates the URL the same way, then connects to the **exact** validated
  IP via a custom `lookup` option that ignores whatever hostname is asked to
  be looked up — closing the DNS-rebinding TOCTOU gap where a hostname
  resolves safely during validation and then rebinds to an internal address
  before the real connection is made. Redirects are never auto-followed by
  the transport; `safeFetch` follows them itself, one hop at a time,
  re-validating each `Location` target through the identical guard, bounded
  to `maxRedirects` (default 5). Response bodies are capped at
  `maxResponseBytes` (default 10MB) — the connection is destroyed and a typed
  `ResponseTooLargeError` is thrown once exceeded, not silently truncated.
  DNS resolver and all limits are injectable (same convention as
  `emailVerification.ts`'s injectable resolver), defaulting to Node's real
  `dns.promises`.

Real tests: `apps/api/test/ssrfGuard.test.ts` (43 tests) — private/loopback/
link-local/metadata-IP rejection for both IPv4 and IPv6 (table-driven over
`isBlockedIp`), non-http(s) scheme rejection, literal-IP-in-URL rejection
without ever calling the resolver, DNS-resolution-failure rejection,
"any resolved IP blocked" rejection even when another resolved IP is public,
a DNS-rebinding simulation (asserts the resolver is called exactly once and
that the actual `lookup` closure handed to the transport returns the
pre-validated IP regardless of what hostname is passed to it a second time),
safe-redirect-following, unsafe-redirect-rejection (asserts the unsafe hop is
**never connected to** — `http.request` call count stays at 1), a
redirect-count bound, a response-size-cap test, and one genuine **live**
test against a real public domain (`example.com`) for the authentic
happy-path case, alongside a mocked happy-path case for determinism. All 43
pass; `node:http`'s `request` is mocked for the synthetic scenarios so the
suite is deterministic/offline-safe except for that one intentional live
smoke test.

## 2. Every crawl entry point now covered

| Entry point | File | How it's covered |
|---|---|---|
| Chatbot website-import (admin, up to 5 URLs) | `apps/api/src/routes/chatbotAdmin.ts` | Calls `fetchCompetitorPage()`, which now validates internally (see below). `SsrfBlockedError` is mapped to a 400 response. |
| Competitor crawl (`POST /competitors/:id/crawl`) | `apps/api/src/routes/competitors.ts` | Same — calls `fetchCompetitorPage()`; `SsrfBlockedError` mapped to 400. |
| apps/api's Crawl4AI client | `apps/api/src/lib/crawl4aiClient.ts` | `fetchCompetitorPage(url)` calls `await assertSafeUrl(url)` before building the request to Crawl4AI. The actual `fetch()` call targets the operator-configured `CRAWL4AI_BASE_URL`, not `url` — but `url` is the real SSRF-relevant value since Crawl4AI fetches it on our behalf, so it's validated regardless of which process makes the real connection. |
| Growth Analyzer discovery (sitemap.xml/robots.txt) | `apps/api/src/lib/growthAnalyzer.ts` (`discoverPages`) | Default `fetchImpl` changed from bare `fetch` to `safeFetch` — these fetch the tenant-supplied domain directly, so they get full DNS-pinning + redirect re-validation. |
| Growth Analyzer page crawl | `apps/api/src/lib/growthAnalyzer.ts` (`crawlPages`) | Goes through `fetchCompetitorPage`, covered as above. |
| SEO site audit (sitemap/robots/broken-links/metadata) | `apps/api/src/lib/siteAudit.ts`, used by `apps/api/src/routes/seo.ts` and reused by `growthAnalyzer.ts` | Every exported function's default `fetchImpl` changed from bare `fetch` to `safeFetch` — all four direct-to-target fetches (`fetchSitemap`, `checkRobotsTxt`, `checkLinkStatus`, the per-page metadata GET) now get DNS-pinning + redirect re-validation. |
| Public growth-audit capture (`POST /public-growth/growth-audit`, unauthenticated) | `apps/api/src/routes/publicGrowth.ts` | Calls `runGrowthAnalysis(domain)`, which is now safe by construction (above) — no route-level change needed. Already rate-limited (`growthAuditIpLimiter`, confirmed still wired — see §4). |
| apps/worker's own crawler (robots.txt preflight) | `apps/worker/src/agents/websiteCrawler.ts` (`crawlOrganizationSite`) | `assertSafeUrl(robotsUrl)` added before the direct robots.txt fetch (fetches the tenant-supplied `orgDomain` directly). |
| apps/worker's own crawler (page fetch via Crawl4AI) | `apps/worker/src/agents/websiteCrawler.ts` (`HttpCrawl4AIBackend.fetchPage`) | `assertSafeUrl(url)` added as the first line — same "validate what Crawl4AI will fetch on our behalf" reasoning as apps/api's client. A blocked URL now aborts the whole crawl loudly (`SsrfBlockedError` re-thrown alongside `CrawlServiceUnreachableError` in `crawlOrganizationSite`'s per-page catch) rather than silently skipping every candidate page. |
| Competitor Intelligence agent / Research adapter (apps/worker) | `apps/worker/src/agents/competitorIntelligence.ts`, `apps/worker/src/agents/researchAdapter.ts` | Both call `crawlOrganizationSite`/`HttpCrawl4AIBackend` — covered transitively, no code change needed in these two files. |

**`publicGrowth.ts`/`internalGrowth.ts`** (read per instructions before
starting — `docs/FEATURE_STATUS.md` confirms these are the "public
growth-audit capture" feature referenced in the broader audit) were traced
and confirmed to route entirely through `runGrowthAnalysis()`, with no
separate fetch path of their own — no additional patching needed there.

### Lead magnets / custom domains (file_url, store-only)

`docs/BROADER_WORKSTREAM_AUDIT.md` §7 flags that lead-magnet `file_url` is
tenant-supplied and only length-checked, with no URL-format/protocol
validation. This was investigated: the platform **never fetches**
`file_url` server-side (it's stored and handed back to the tenant's own
UI/consumer to load directly in the visitor's browser) — there is no SSRF
exposure here because no outbound request from this codebase is ever made to
it. Left as-is; not a crawl entry point. Noted for completeness since it was
in scope to check.

## 3. Hardening beyond SSRF

- **Request timeouts**: `siteAudit.ts`'s four fetches already had
  `AbortSignal.timeout(FETCH_TIMEOUT_MS)` (5s) — unchanged, and still honored
  by `safeFetch` (it only applies its own default timeout when `init.signal`
  is absent). **Gap found and fixed**: `apps/api/src/lib/crawl4aiClient.ts`'s
  `fetchCompetitorPage` and `apps/worker/src/agents/websiteCrawler.ts`'s
  `HttpCrawl4AIBackend.fetchPage` had **no timeout at all** on their POST to
  Crawl4AI — a hung Crawl4AI service or a slow target page could tie up the
  request indefinitely. Both now have `signal: AbortSignal.timeout(20_000)`.
  The worker's robots.txt preflight fetch also had no timeout — now
  `AbortSignal.timeout(5_000)`.
- **Response-size limits**: `safeFetch`'s 10MB cap (streamed, destroys the
  connection and throws `ResponseTooLargeError` past the limit, never
  silently truncates) now applies to every direct-to-tenant-domain fetch in
  `siteAudit.ts`/`growthAnalyzer.ts`/`websiteCrawler.ts`'s robots.txt fetch,
  closing the "fully buffered into memory with no cap" gap the task called
  out. **Known residual gap, not fixed this round**: the JSON response from
  Crawl4AI itself (`crawl4aiClient.ts`'s `response.json()`,
  `HttpCrawl4AIBackend`'s `response.json()`) is still fully buffered with no
  cap. This is lower-risk than the direct-to-tenant-domain fetches above
  (Crawl4AI is an operator-configured, trusted service boundary, not an
  arbitrary third party), but a compromised/misbehaving Crawl4AI instance
  could still return an oversized response and pressure memory. Flagged here
  rather than fixed, to keep this round's changes surgical; recommend a
  bounded-read helper (stream + cap, same pattern as `safeFetch`) if Crawl4AI
  is ever exposed to lower-trust input.
- **Crawl limits**: verified, not found lacking —
  `growthAnalyzer.ts`'s `MAX_PAGES_TO_CRAWL = 15` / `MAX_CONCURRENCY = 5` and
  `siteAudit.ts`'s `MAX_SITEMAP_URLS = 50` / `MAX_CONCURRENCY = 5` are both
  still enforced; `websiteCrawler.ts`'s `DEFAULT_CANDIDATE_PATHS` is a fixed
  14-entry list and `maxPages` defaults to `paths.length` (no unbounded
  crawl). No gap found.

## 4. Read-only security audit of the rest of the platform

### Tenant isolation (RLS)

`docs/SECURITY_REVIEW.md` documents a prior critical finding: the app
connected as `devlaunch`, a real Postgres superuser with `rolbypassrls=true`,
meaning RLS was never actually enforced at the database level — fixed in
migration `321_create_app_role.sql` (new non-superuser `devlaunch_app` role)
plus `docker-compose.yml` (both `api`/`worker` `DATABASE_URL`s point at it)
plus a startup assertion. **Re-confirmed still in place**: `docker-compose.yml`
still points both services at `${APP_DB_USER:-devlaunch_app}`, and
`apps/api/src/db/pool.ts` / `apps/worker/src/db.ts` both still define
`assertDatabaseRoleRespectsRls()`, querying `pg_roles` for the actual
connected role and hard-failing (production) / loudly logging (dev) if it's
ever a superuser/bypassrls role again. No regression found.

### RBAC

Spot-checked (not exhaustive, per instructions): `approvals.ts`'s
`POST /:approvalId/decision` still has `requireRole(...GTM_ROLES)`;
`billing.ts`'s plan-change/cancel routes still call `requireRole(req, ["owner"])`.
Both present as expected. No gap found in this spot check.

### Public endpoint rate limits

Spot-checked `publicLeads.ts`, `publicChatbot.ts`, and `publicGrowth.ts` (the
public growth-audit capture feature this round's SSRF fix most directly
affects, since it's the one unauthenticated surface that triggers a real
crawl): all three still import and wire `rateLimitMiddleware` per-route
(`publicGrowth.ts`'s `POST /growth-audit` specifically uses
`growthAuditIpLimiter`, confirmed applied as route middleware, not just
defined-and-unused). `landingPages.ts` is authenticated-only
(`requireAuth`/`requireTenantMembership`) by design — not a public surface,
consistent with `docs/BROADER_WORKSTREAM_AUDIT.md` §6's note that landing
pages have no in-repo public renderer. No gap found in this spot check.

### Secret handling

Grepped every file touched or added this round
(`ssrfGuard.ts` ×2, `crawl4aiClient.ts`, `websiteCrawler.ts`, `siteAudit.ts`,
`growthAnalyzer.ts`) for `logger.`/`console.` calls near a credential/token
variable: **none of these files call `logger`/`console` at all.** The
`CRAWL4AI_API_TOKEN` is only ever placed directly into a request header
(`headers.Authorization = `Bearer ${apiToken}``), never interpolated into a
log line, in either the apps/api or apps/worker client. No new secret-
logging risk introduced by this round's changes. (This mirrors the clean
result `docs/SECURITY_REVIEW.md`'s own Milestone 3 cross-cutting secret-
logging pass found for the listmonk/chatwoot/postiz integrations — same
"never found" conclusion, now also true for the crawl/SSRF-adjacent code.)

### Pre-existing, unrelated test flakiness observed (not fixed, out of scope)

While running the full `apps/api` suite repeatedly to validate this round's
changes, a different, small set of tests failed on different runs each time
(`test/dealHealth.test.ts`, `test/meetingPrep.test.ts`,
`test/competitors.test.ts`'s `GET /:id/report` test, `test/sequences.test.ts`),
none of which touch fetch/crawl/SSRF code at all. One was traced to a real,
unrelated bug: `apps/api/src/lib/positioningInsights.ts` (currently an
**untracked, in-progress file** per `git status` — the concurrent session's
active work) throws `TypeError: pages is not iterable` in
`extractPricingSignals`. This is consistent with
`docs/BROADER_WORKSTREAM_AUDIT.md`'s own "flagged regression... from the
separate concurrent session's current edits" note. Not fixed here —
unrelated to SSRF hardening and actively being edited by another session;
flagged for whoever owns that file next.

## Files new/changed this round

**New:**
- `apps/api/src/lib/ssrfGuard.ts`
- `apps/worker/src/lib/ssrfGuard.ts`
- `apps/api/test/ssrfGuard.test.ts`
- `docs/SECURITY_HARDENING_MILESTONE_1.md` (this file)

**Changed:**
- `apps/api/src/lib/crawl4aiClient.ts` — `assertSafeUrl` + request timeout.
- `apps/api/src/lib/siteAudit.ts` — default `fetchImpl` → `safeFetch`.
- `apps/api/src/lib/growthAnalyzer.ts` — default `fetchImpl` → `safeFetch`.
- `apps/api/src/routes/chatbotAdmin.ts` — `SsrfBlockedError` → 400 mapping.
- `apps/api/src/routes/competitors.ts` — `SsrfBlockedError` → 400 mapping.
- `apps/worker/src/agents/websiteCrawler.ts` — `assertSafeUrl` on
  `HttpCrawl4AIBackend.fetchPage` and the robots.txt preflight; request
  timeouts on both; `SsrfBlockedError` re-thrown (abort-loudly) alongside
  `CrawlServiceUnreachableError` in `crawlOrganizationSite`'s per-page catch.
- `apps/api/test/growthAnalyzer.test.ts`, `apps/api/test/seo.test.ts`,
  `apps/api/test/chatbotAdmin.test.ts`, `apps/api/test/competitors.test.ts`,
  `apps/api/test/workflowResearchStage.test.ts` — added a
  `vi.mock("../src/lib/ssrfGuard.js", ...)` neutralizing `assertSafeUrl` (and,
  where `safeFetch` is now a default, delegating it to the already-stubbed
  global `fetch`) so these route-level tests keep intercepting outbound
  requests at the mock layer instead of hitting a real network for
  fictitious test domains — real DNS/rebinding/private-IP behavior is
  covered for real in `ssrfGuard.test.ts` instead.
- `apps/worker/test/websiteCrawler.test.ts`,
  `apps/worker/test/competitorIntelligence.test.ts`,
  `apps/worker/test/crawl4aiResearchAdapter.test.ts` — same
  `assertSafeUrl` neutralization, for the same reason (fictitious
  `.test`/`.invalid`/`.example` domains that don't and shouldn't need to
  resolve).

## Decisions made / ambiguity encountered

1. **Where to put the validation call for Crawl4AI-mediated crawls.**
   `fetchCompetitorPage`/`HttpCrawl4AIBackend.fetchPage`'s own `fetch()` call
   targets the *operator-configured* Crawl4AI base URL, not the
   tenant-supplied target — so DNS-pinning that connection would be wrong
   (it could legitimately be an internal Docker-network address). The
   SSRF-relevant value is the URL handed to Crawl4AI in the request body,
   which Crawl4AI then fetches on our behalf — validated via `assertSafeUrl`
   without changing the transport for that call. This is a deliberate
   decision, not an oversight: it was the only reading that doesn't risk
   breaking the legitimate internal Crawl4AI connection.
2. **Keeping `HttpCrawl4AIBackend`'s `fetchImpl` typed as `typeof fetch`**
   (not switched to `safeFetch` by default) for the same reason as above —
   it's shared between the (trusted-target) Crawl4AI POST and, in
   `crawlOrganizationSite`, the (tenant-target) robots.txt preflight. Rather
   than split that one option into two to give the robots.txt fetch full
   IP-pinning, `assertSafeUrl` validation (without pinning) was added at that
   one call site as a smaller, non-breaking change. Documented as a
   known/accepted scope limit rather than silently decided.
3. **Existing tests exercising route-level crawl behavior via
   `vi.stubGlobal("fetch", ...)`** needed updating once `safeFetch`/
   `assertSafeUrl` became the default, since `safeFetch` doesn't call global
   `fetch` at all and `assertSafeUrl` does real DNS resolution by default.
   Rather than rewrite those tests' fixtures, a `vi.mock("../src/lib/ssrfGuard.js", ...)`
   block (keeping every other export real via `importOriginal`) was added to
   each affected file, preserving the existing fixtures/assertions
   unchanged. This is the smallest change that keeps the tests both passing
   and honest about what they verify.
4. **IPv6 edge ranges not implemented**: 6to4 (`2002::/16`) and NAT64
   (`64:ff9b::/96`) embed an IPv4 address that could itself be private, but
   extracting/re-checking them wasn't explicitly requested and was left out
   to keep `isBlockedV6` focused on the ranges the task explicitly named
   (`::1`, `fe80::/10`, `fc00::/7`, plus IPv4-mapped). Flagged here as a
   narrower scope than a maximally exhaustive IPv6 guard, not a silent gap.
5. **HTTP response mapping for `SsrfBlockedError`**: the task didn't specify
   an HTTP status; `Errors.badRequest` (400) was chosen for the two route
   call sites that previously had explicit Crawl4AI-error handling
   (`competitors.ts`, `chatbotAdmin.ts`), since a blocked-URL error is a
   caller input problem, not a server/upstream failure. `growthAnalyzer.ts`/
   `publicGrowth.ts` needed no such mapping — `runGrowthAnalysis` already
   degrades every crawl failure (SSRF-blocked or otherwise) into an honest
   `status: "failed"`/`"partial"` result with a `crawlError` message, never
   throwing past the route handler.
