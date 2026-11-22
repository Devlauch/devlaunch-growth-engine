# Crawl4AI HTTP contract — verification against a real instance

Date: 2026-11-21
Scope: roadmap item 2's last open gap — `HttpCrawl4AIBackend`
(`apps/worker/src/agents/websiteCrawler.ts`) and the `crawl4ai` service in
`docker-compose.yml` were built against a best-guess of Crawl4AI's HTTP API,
never checked against a real running container. This document records that
check.

## What was tried

The main stack (postgres/redis/api/worker/dashboard, via plain
`docker compose up`) was already running and was left untouched throughout.

1. `docker compose --profile crawl4ai up -d crawl4ai` — brought up the
   `crawl4ai` service from `unclecode/crawl4ai:latest`. The environment
   **does** have internet access: the image pulled successfully and the
   container reported itself `healthy` within ~30s.

2. `curl http://localhost:11235/health` from the WSL host — this **failed**
   (`Connection reset by peer` / empty response), even though
   `docker compose ps` showed the container "healthy" and the port mapping
   `11235:11235` in place. Same failure reaching it from a sibling container
   (`devlaunch-api-1`) over the `devlaunch_default` bridge network by
   service name (`crawl4ai`) or by container IP.

3. Investigated by running `curl http://localhost:11235/health` with
   `docker exec` **inside** the `crawl4ai` container itself — that worked
   (`{"status":"ok","timestamp":...,"version":"0.9.6"}`). Reading
   `/app/entrypoint.sh` and `/app/config.yml` inside the image explained why:

   > `unclecode/crawl4ai` (this image, version `0.9.6`) refuses to bind to
   > anything but the **container's own loopback** (`127.0.0.1:11235`)
   > unless the `CRAWL4AI_API_TOKEN` environment variable is set at
   > container start. Its own healthcheck curls `localhost:11235` from
   > *inside* the container, so it reports "healthy" even while being
   > completely unreachable from the host or any other container — this is
   > a real, confirmed footgun in the original `docker-compose.yml`, which
   > published port 11235 but never set this variable.

   This is also enforced by the image's internal auth guard
   (`server.py`'s `_resolve_auth()`, mirrored in `entrypoint.sh`), not just
   the compose file — so no healthcheck or port-mapping fix alone would
   have worked.

4. Re-verified by running the image manually with
   `-e CRAWL4AI_API_TOKEN=<token>` and a fresh port mapping. With the token
   set, `/health` became reachable from the host immediately.

5. With the service reachable, issued the real requests:
   - `POST /crawl` with `{"urls":["https://example.com"]}` and **no**
     `Authorization` header → **401** `{"detail":"Authentication
     required"}` with header `www-authenticate: Bearer`. So the service's
     own API also requires the same bearer token, independent of the
     container-bind guard in step 3.
   - Same request **with** `Authorization: Bearer <token>` → **200**, body
     shape:
     ```json
     {
       "success": true,
       "results": [
         {
           "url": "https://example.com",
           "html": "<!DOCTYPE html>...",
           "success": true,
           "cleaned_html": "<html>...",
           "markdown": { "raw_markdown": "...", "markdown_with_citations": "..." },
           "metadata": { "title": "Example Domain", "description": null, "keywords": null, "author": null },
           "status_code": 200,
           "error_message": null,
           "...": "many more fields: media, links, screenshot, pdf, mhtml, tables, crawl_stats, etc."
         }
       ],
       "server_processing_time_s": 0.4,
       "server_memory_delta_mb": "...",
       "server_peak_memory_mb": "..."
     }
     ```
   - `docker image inspect unclecode/crawl4ai:latest` and
     `docker pull unclecode/crawl4ai:0.9.6` were compared by digest — both
     resolve to the identical image
     (`sha256:4603d7c4d69769673dfa1214fa9abbcac2a874d4d9af07d784782af528b65c68`),
     confirming `0.9.6` is the correct, real, pinnable tag for exactly what
     was verified here (not a guess).

6. Cleaned up the manual verification container and confirmed the
   pre-existing stack (postgres/redis/api/worker/dashboard) was left
   running, unmodified, throughout.

## Verdict vs. what the code originally assumed

| Original assumption (`HttpCrawl4AIBackend`, pre-verification) | Reality (verified) |
|---|---|
| `POST {baseUrl}/crawl` with `{urls:[url]}` | **Confirmed correct.** |
| Response `{results:[{html, metadata:{title}}]}` | **Confirmed correct** for the success path — `html` and `metadata.title` are exactly where this class reads them. (`markdown` is a structured object, not the plain string the code's fallback branch guessed at — but that fallback is never reached since `html` is always present, so it was harmless, not a real bug.) |
| No auth needed | **Wrong.** `/crawl` requires `Authorization: Bearer <token>`; a missing/invalid token returns 401, not a crawl result. |
| `:latest` image tag | Resolved, at verification time, to `0.9.6` exactly (confirmed by matching digests). |
| `/health` healthcheck path | **Confirmed correct** — returns real 200 JSON once reachable. |
| (not previously considered) container network bind | **New finding:** the image binds to its own loopback only without `CRAWL4AI_API_TOKEN`, making the `docker-compose.yml` port mapping a no-op and masking the problem behind a "healthy" container. |

## Changes made as a result

- `apps/worker/src/agents/websiteCrawler.ts` (`HttpCrawl4AIBackend` only):
  - Added an `apiToken` constructor parameter (defaults to the
    `CRAWL4AI_API_TOKEN` env var), sent as `Authorization: Bearer <token>`.
  - `crawlOrganizationSite`'s options gained `apiToken`, threaded through to
    the default backend it constructs.
  - A 401/403 response is now treated as `CrawlServiceUnreachableError`
    (abort), not a silent per-page skip — a missing/invalid token fails
    every page identically, so treating it as "this one page 404s" would
    have silently looked like "the organization's site has none of these
    pages" instead of the real, fixable cause.
  - Updated the class/module doc comments from "not independently
    verified" to record what was actually confirmed.
- `apps/worker/test/crawl4aiResearchAdapter.test.ts`: added tests for the
  real, fuller 0.9.6 response shape (object-shaped `markdown`, extra
  fields ignored), the `Authorization` header being sent when an
  `apiToken` is configured, and the 401 → `CrawlServiceUnreachableError`
  behavior. All pre-existing tests in this file and in
  `websiteCrawler.test.ts` still pass unmodified (22/22 total).
- `docker-compose.yml` (`crawl4ai` service block and the `worker` service's
  `CRAWL4AI_BASE_URL` comment only):
  - Pinned `image: unclecode/crawl4ai:latest` → `unclecode/crawl4ai:0.9.6`.
  - Added `environment: CRAWL4AI_API_TOKEN: ${CRAWL4AI_API_TOKEN:-}` (no
    baked-in default — an operator must consciously set it) and a comment
    chain explaining the loopback-bind and `/crawl` auth findings above, so
    the next person enabling this profile doesn't rediscover the "healthy
    but unreachable" trap from scratch.
  - Left the healthcheck test command (`curl -f http://localhost:11235/health`)
    as-is — the path was confirmed correct — but added a comment noting it
    only proves the service is up *inside its own container*, which is not
    the same as "reachable", given the loopback-bind behavior.

## Still open / not verified

- Only the synchronous `/crawl` + `/health` endpoints were exercised
  (matching what `HttpCrawl4AIBackend` actually calls). The async
  `/crawl/job` + polling flow, `/llm/*`, and deep-crawl
  (`CRAWL4AI_ALLOW_DEEP_CRAWL`) endpoints mentioned in the image's own
  `config.yml` were not tested — nothing in this codebase calls them.
- Only tested against a single simple public page (`https://example.com`).
  Behavior against JS-heavy pages, pages requiring the browser-render path,
  or pages that trip `limits.wall_clock_s`/`max_body_bytes` was not
  exercised.
- `CRAWL4AI_BASE_URL` is a docker-compose placeholder only — nothing in
  `apps/worker/src` currently constructs a `Crawl4AIResearchAdapter` at
  runtime (no wiring/call site exists yet), so this verification covers the
  HTTP contract itself, not an end-to-end "worker calls it in production"
  path.
