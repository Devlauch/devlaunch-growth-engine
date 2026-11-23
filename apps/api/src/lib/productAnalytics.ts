import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * PostHog Capture API: thin, hand-rolled client for the PLATFORM'S OWN
 * internal product-usage analytics only — i.e. DevLaunch-the-company
 * tracking how DevLaunch-the-product's internal team/operators use the
 * admin tooling (agent runs, workflow executions, tenant signups). This is
 * NOT the tenant-facing website-visitor analytics feature (site_visitors/
 * site_sessions/site_pageviews/site_events, apps/api/src/lib/siteAnalytics.ts)
 * — that is a separate, already-shipped, customer-facing product feature and
 * is untouched by this file. A prior audit round explicitly rejected
 * self-hosting PostHog for that tenant-facing use case (infra footprint too
 * heavy); this file only ever calls PostHog Cloud's hosted Capture API, and
 * only for this platform's own internal usage telemetry.
 *
 * This is write-only/fire-and-forget by design: this codebase never reads
 * events back from PostHog. A human looks at them in PostHog's own
 * dashboard.
 *
 * Request shape confirmed against PostHog's own published docs (fetched
 * during this work, https://posthog.com/docs/api/post-only-endpoints /
 * https://posthog.com/docs/api/capture): POST <host>/capture/ with a JSON
 * body `{ api_key, event, distinct_id, properties?, timestamp? }`. PostHog's
 * newer docs lead with `/i/v0/e/` on a region-specific ingestion host
 * (us.i.posthog.com / eu.i.posthog.com), but the legacy `/capture/` path on
 * app.posthog.com / eu.posthog.com documented here remains supported and is
 * what this client uses, matching the exact shape above.
 *
 * Honestly a complete no-op when POSTHOG_API_KEY is unset: isConfigured()
 * is false, captureProductEvent() returns immediately without buffering or
 * queuing anything to send later. Never throws to the caller, and never
 * blocks/awaits the outbound call on a real user-facing request path — a
 * PostHog outage or slow response must never fail or delay the request that
 * triggered the event; failures are logged as warnings only.
 */

const DEFAULT_POSTHOG_HOST = "https://app.posthog.com";

export function isProductAnalyticsConfigured(): boolean {
  return typeof env.posthogApiKey === "string" && env.posthogApiKey.length > 0;
}

/**
 * Fires a single internal product-usage event at PostHog's Capture API.
 * Fire-and-forget: does not return a Promise the caller is expected to
 * await, and any failure (network error, non-2xx response, PostHog being
 * down) is swallowed after a logged warning — it must never throw or
 * reject in a way the caller has to handle.
 */
export function captureProductEvent(event: string, distinctId: string, properties?: Record<string, unknown>): void {
  if (!isProductAnalyticsConfigured()) {
    return;
  }

  const host = env.posthogHost ?? DEFAULT_POSTHOG_HOST;
  const body = {
    api_key: env.posthogApiKey,
    event,
    distinct_id: distinctId,
    properties: properties ?? {},
    timestamp: new Date().toISOString(),
  };

  // Deliberately not awaited by the caller — see doc comment above. The
  // promise chain below still runs to completion in the background; we just
  // never let it propagate a rejection.
  void fetch(`${host}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (!res.ok) {
        logger.warn({ event, status: res.status }, "productAnalytics: PostHog capture returned non-2xx, dropping event");
      }
    })
    .catch((err) => {
      logger.warn({ err, event }, "productAnalytics: PostHog capture failed, dropping event");
    });
}
