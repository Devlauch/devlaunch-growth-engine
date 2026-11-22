# Lead Discovery

This document explains what the lead-discovery feature actually does today,
what exists in the codebase but is deliberately not enabled, and the exact
data source it uses. Read this before assuming any other connector type is
live — the DB schema (`discovery_sources.connector_type`) still allows
`website_crawl`, `csv_upload`, and `licensed_api` as values, but the API only
lets you create and run a `public_directory` source right now.

## What's real and wired up today

- **Connector**: `PublicDirectoryConnector`, backed by
  `OverpassDirectoryApiClient`
  (`packages/agent-sdk/src/connectors/publicDirectoryConnector.ts` — moved
  here from `apps/worker/src/connectors/` so `apps/api` can call it directly
  without depending on the worker process; see "Why the connector code moved"
  below).
- **Data source**: the free, no-API-key **Overpass API**
  (`https://overpass-api.de/api/interpreter`), which serves **OpenStreetMap**
  business/institution data under the Open Database License (attribution
  required if republished) and the
  [Overpass API fair-use policy](https://operations.osmfoundation.org/policies/overpass/)
  (no bulk scraping, respect rate limits — this connector self-throttles via
  `SlidingWindowRateLimiter` to each source's configured
  `rate_limit_per_minute`).
- **Supported categories**: a small, honest, fixed list of OSM tags
  (`INDUSTRY_TO_OSM_TAG` in `publicDirectoryConnector.ts`): restaurant, cafe,
  school, university, hospital, clinic, dentist, pharmacy, bank, hotel, gym,
  lawyer, accountant, library, childcare. Anything else throws a clear
  `UnsupportedIndustryError` (surfaced to the API caller as a 400) rather than
  guessing or fabricating results. The dashboard's "New discovery source"
  form only ever offers this exact list, so a user can never pick an
  unsupported industry and hit a confusing error.
- **End-to-end flow**:
  1. `POST /api/v1/tenants/:tenantId/projects/:projectId/discovery-sources`
     creates a `discovery_sources` row. `connectorType` must be
     `"public_directory"` — any other value (including the other three the DB
     CHECK constraint still permits) is rejected with a 400.
  2. `POST .../discovery-sources/:id/run` looks the source up, calls
     `getConnector("public-directory")`, invokes `discover()` with the
     source's `config` (`{ industry, geography, limit }`, optionally
     overridden per-request), and persists whatever it genuinely finds into
     `discovered_organizations` (+ `discovered_contacts`, for connectors that
     return any — `PublicDirectoryConnector` itself only ever returns
     organization-level results, since OSM listings aren't contact data).
     Duplicates (by the same tenant+project+domain/name dedup rules the
     manual-create routes use, backed by the DB's own unique indexes as a
     last line of defense) are skipped, not errored.
  3. `GET .../discovered-organizations` lists organizations with their
     contacts embedded.
  4. `POST .../discovered-organizations/:id/promote-to-lead` creates a real
     row in the `leads` table (`source = 'discovery'`), using the
     organization's name/domain as `company` and its best available contact
     (ranked: verified > unverified > role-based > risky > invalid email
     verification status, then named-person > role-based > contact-form >
     phone contact channel) for the lead's name/email. It writes a real
     `audit_events` row and marks the organization `status = 'researched'` so
     it can't be silently double-promoted (only orgs in status `'new'` can be
     promoted).
  5. The dashboard's **Discovery** page (new sidebar nav item under a
     project) exposes all of this: create a source, run it, see discovered
     organizations/contacts in a table, promote one to a lead with one click.

## What's present in the codebase but NOT enabled

- **Crawl4AI / `website_crawl`**: `apps/worker/src/agents/websiteCrawler.ts`,
  `robotsTxt.ts`, and the `Crawl4AIResearchAdapter` class in
  `apps/worker/src/agents/researchAdapter.ts` are real, tested code for
  crawling a tenant-provided website list via a separate `crawl4ai` Docker
  service (added to `docker-compose.yml`, image `unclecode/crawl4ai:latest`).
  **This service is not started, required, or depended on by anything in
  this phase.** The API rejects creating a `website_crawl` discovery source
  outright. Enabling it later requires: (a) product/infra approval to
  actually run the `crawl4ai` container, (b) a discovery-sources route change
  to add `website_crawl` back to the accepted `connectorType` list, (c) a
  worker-side job (or API-side call, following the same pattern as
  `public_directory`) to invoke `Crawl4AIResearchAdapter`.
- `csv_upload` (`CsvUploadConnector` — a real, working, no-network connector
  for a tenant's own uploaded CSV) and `licensed_api`
  (`NotConfiguredDirectoryApiClient` — an honest stand-in that throws rather
  than fabricating data, since no licensed directory API key exists in this
  environment) are registered in the connector framework but have no
  API route or dashboard UI wired up to create/run them yet.

## Why the connector code moved

The connector framework (`types.ts`, `registry.ts`, `rateLimiter.ts`,
`csvConnector.ts`, `publicDirectoryConnector.ts`) used to live only under
`apps/worker/src/connectors/`. `apps/api` needed to call the same
`getConnector("public-directory")` registry the worker uses (rather than
re-implementing the Overpass call), but `apps/api` cannot depend on
`apps/worker` directly — `apps/worker/src/index.ts` opens a real Redis
connection as a side effect of being imported. The connector framework was
moved to `packages/agent-sdk/src/connectors/` (a dependency-free, already
shared package both `apps/api` and `apps/worker` depend on) and re-exported
from `@devlaunch/agent-sdk`'s index. `apps/worker/src/connectors/*.ts` are now
thin re-export shims over `@devlaunch/agent-sdk` so the worker's own existing
tests and imports keep working unchanged.

## Known bug already found and fixed (not by this change)

`apps/worker/src/connectors/rateLimiter.ts`'s `SlidingWindowRateLimiter`
previously had `currentCount` read the real wall clock (`Date.now()`) instead
of whatever clock function was last passed to `acquire()`, which broke its
own unit tests under a fake/injected test clock. That was found and fixed in
a prior pass (commit "Fix SlidingWindowRateLimiter.currentCount to use
injected clock, not wall clock") — flagged here again because the connector
code it sits under is exactly what this feature now depends on, and it's
worth knowing that code had already been audited once rather than taken on
faith.
