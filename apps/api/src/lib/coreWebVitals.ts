/**
 * Core Web Vitals via the free Google PageSpeed Insights API (Phase 2 item
 * 3, "Technical SEO Agent"). Same injectable/graceful-degradation
 * convention as apps/api/src/lib/dnsVerification.ts /
 * apps/api/src/lib/emailVerification.ts:
 *
 *   - If no API key is configured (env.googlePageSpeedApiKey is null in
 *     this environment), this returns `{ status: "not_configured" }`
 *     immediately. It never fabricates LCP/CLS/INP numbers or a
 *     performance score.
 *   - If a key IS configured, this makes a real `fetch` to PageSpeed
 *     Insights v5 and parses the real response shape. Any HTTP/network
 *     error is mapped to `{ status: "error", error }` rather than thrown.
 */

export type CoreWebVitalsStatus = "ok" | "not_configured" | "error";

export interface CoreWebVitalsData {
  /** Largest Contentful Paint, e.g. "2.1 s" (lighthouseResult.audits['largest-contentful-paint'].displayValue). */
  lcp?: string;
  /** Cumulative Layout Shift, e.g. "0.02" (lighthouseResult.audits['cumulative-layout-shift'].displayValue). */
  cls?: string;
  /** Interaction to Next Paint, when present in the response (not every PageSpeed run surfaces it). */
  inp?: string;
  /** Lighthouse performance category score, 0-1 (lighthouseResult.categories.performance.score). */
  performanceScore?: number;
  checkedAt: string;
}

export interface CoreWebVitalsResult {
  status: CoreWebVitalsStatus;
  data?: CoreWebVitalsData;
  error?: string;
}

const PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const FETCH_TIMEOUT_MS = 30000; // PageSpeed Insights genuinely takes several seconds per run.

interface PageSpeedAudit {
  displayValue?: string;
  numericValue?: number;
}

interface PageSpeedResponse {
  lighthouseResult?: {
    audits?: Record<string, PageSpeedAudit>;
    categories?: {
      performance?: { score?: number };
    };
  };
}

export async function checkCoreWebVitals(
  url: string,
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<CoreWebVitalsResult> {
  if (!apiKey) {
    // Honest: no fake numbers, ever. This is the expected state whenever
    // GOOGLE_PAGESPEED_API_KEY isn't set in this environment.
    return { status: "not_configured" };
  }

  const checkedAt = new Date().toISOString();
  const requestUrl = `${PAGESPEED_ENDPOINT}?url=${encodeURIComponent(url)}&key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetchImpl(requestUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      // Non-JSON error body — fall back to the status-only message.
    }
    return { status: "error", error: `PageSpeed Insights request failed: ${detail}` };
  }

  let body: PageSpeedResponse;
  try {
    body = (await res.json()) as PageSpeedResponse;
  } catch (err) {
    return { status: "error", error: `Could not parse PageSpeed Insights response: ${err instanceof Error ? err.message : String(err)}` };
  }

  const audits = body.lighthouseResult?.audits ?? {};
  const data: CoreWebVitalsData = { checkedAt };

  // Omit a metric entirely rather than inventing a number when it isn't
  // present in this particular response.
  if (audits["largest-contentful-paint"]?.displayValue) {
    data.lcp = audits["largest-contentful-paint"].displayValue;
  }
  if (audits["cumulative-layout-shift"]?.displayValue) {
    data.cls = audits["cumulative-layout-shift"].displayValue;
  }
  if (audits["interaction-to-next-paint"]?.displayValue) {
    data.inp = audits["interaction-to-next-paint"].displayValue;
  } else if (audits["experimental-interaction-to-next-paint"]?.displayValue) {
    // PageSpeed has carried INP under this experimental audit key in some
    // API versions/rollout states — use it if that's what's present,
    // still never inventing a value when neither key is there.
    data.inp = audits["experimental-interaction-to-next-paint"].displayValue;
  }
  const performanceScore = body.lighthouseResult?.categories?.performance?.score;
  if (typeof performanceScore === "number") {
    data.performanceScore = performanceScore;
  }

  return { status: "ok", data };
}
