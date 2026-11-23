import { describe, it } from "vitest";

/**
 * BLOCKED: no real SerpApi key is available in this environment (see
 * docs/PHASE_2_GOOGLE_SEARCH_VALIDATION.md). This codebase's "Google
 * Search" provider is `apps/api/src/lib/serpProvider.ts`'s
 * `SerpApiRankingProvider` — a real HTTP client against SerpApi
 * (https://serpapi.com), which proxies Google's own search results
 * (`engine=google`) rather than calling a Google-operated endpoint
 * directly. This file documents, in a real, skipped test, exactly what a
 * genuine authenticated validation run would assert — it is intentionally
 * never executed as part of the normal suite, and nothing here fabricates
 * or simulates a real SerpApi/Google response as if it were genuine.
 *
 * To actually run this file for real: set a real SERPAPI_API_KEY env var,
 * delete the `.skip` on each `it`, and run
 * `SERPAPI_API_KEY=... npx vitest run test/googleSearchRealApi.skip.test.ts`.
 */
describe("Google Search (SerpApi) — real, authenticated validation (BLOCKED: no key available)", () => {
  it.skip("Search: a real query against a well-known domain returns a 200 with genuine organic_results, and checkRanking finds that domain's real rank position", async () => {
    // Would assert: new SerpApiRankingProvider(process.env.SERPAPI_API_KEY!)
    // .checkRanking(<a keyword known to rank a specific real domain, e.g.
    // "wikipedia" for "wikipedia.org">, <that domain>) resolves with
    // result.source === "serpapi", result.checkedAt a valid ISO timestamp,
    // and result.position either a real positive integer (the domain's
    // actual current rank in live Google results proxied through SerpApi)
    // or null if genuinely absent from the page checked — never guessed,
    // proving the real organic_results[].link/displayed_link shape this
    // codebase's hostOf()-based matching assumes from documentation alone
    // today actually matches what SerpApi returns for a live Google SERP.
  });

  it.skip("Search: a query with no real ranking match for an unrelated domain genuinely returns position: null, not a false positive", async () => {
    // Would assert: checkRanking(<a real, high-traffic keyword>,
    // <a domain genuinely unrelated to and not ranking for that keyword>)
    // resolves with position: null — proving hostOf()'s host-matching logic
    // doesn't fabricate a match against a real result set that doesn't
    // contain the target domain.
  });

  it.skip("Authentication: an invalid API key genuinely returns a SerpApi error (HTTP 401, or an HTTP-200 body carrying error/search_metadata.status === 'Error', per SerpApi's own documented bad-key behavior), proving SerpApiError's classification against a REAL response, not an invented one", async () => {
    // Would assert: new SerpApiRankingProvider("not-a-real-key")
    // .checkRanking("widgets", "example.com") rejects with SerpApiError,
    // confirming SerpApi's documented invalid-api_key behavior holds in
    // practice (SerpApi is documented to return this as an `error` string
    // field, sometimes on HTTP 200 rather than a 401 status — this test
    // would record exactly which real shape was observed).
  });

  it.skip("Rate limiting / quota: exceeding the real key's plan quota genuinely surfaces a retryable SerpApiError (HTTP 429 or 5xx, per SerpApi's documented `retryable` classification in this file), proving retryable=true against a real rate-limited or over-quota response", async () => {
    // Would assert: firing requests past the real account's documented
    // per-month/per-second plan limit eventually yields a response whose
    // SerpApiError.retryable === true (status 429 or >= 500), confirming
    // SerpApiError's constructor-derived `retryable` flag against a real
    // over-quota or rate-limited response rather than a mocked one.
  });
});
