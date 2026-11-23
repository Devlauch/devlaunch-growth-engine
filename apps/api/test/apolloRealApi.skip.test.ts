import { describe, it } from "vitest";

/**
 * BLOCKED: no real Apollo.io API key is available in this environment (same
 * situation as apps/api/test/hunterRealApi.skip.test.ts — see
 * docs/PHASE_2_HUNTER_VALIDATION.md for that precedent). This file
 * documents, in a real, skipped test, exactly what a genuine authenticated
 * validation run against Apollo's live API would assert — it is
 * intentionally never executed as part of the normal suite.
 *
 * To actually run this file for real: set a real APOLLO_API_KEY env var,
 * delete the `.skip` on each `it`, and run
 * `APOLLO_API_KEY=... npx vitest run test/apolloRealApi.skip.test.ts`.
 *
 * API shape these assertions rely on was confirmed against Apollo's own
 * published documentation (https://docs.apollo.io/reference/people-enrichment,
 * fetched during this work) — see apps/api/src/lib/apolloProvider.ts's doc
 * comment for the full citation. Nothing here is a recorded fixture
 * presented as live: every `it` below, once un-skipped, makes a real
 * network call to https://api.apollo.io and asserts on the real response.
 */
describe("Apollo.io API — real, authenticated validation (BLOCKED: no key available)", () => {
  it.skip("People Enrichment: a real match request for a well-known public person (name + domain) returns a 200 with a genuine response shape", async () => {
    // Would assert: matchPerson(
    //   { name: "Satya Nadella", domain: "microsoft.com" },
    //   process.env.APOLLO_API_KEY!,
    // ) resolves with:
    //   - result.requestId a non-empty string (Apollo's request_id_str),
    //     proving the real response actually included Apollo's own
    //     request-tracking id, not an invented one.
    //   - result.person !== null, with person.matchConfidence one of
    //     "high"/"medium"/"low"/"none" (never an unmapped raw string),
    //     proving mapMatchResponse's match_confidence handling holds
    //     against a real response.
    //   - When matchConfidence !== "none": person.name and
    //     person.organizationDomain are populated from Apollo's real data,
    //     not fabricated — proving this codebase's optimistic field mapping
    //     (first_name/last_name -> name fallback, organization.primary_domain
    //     -> organizationDomain) matches the real response shape assumed
    //     from documentation alone today.
  });

  it.skip("People Enrichment: a name alone (no domain/email/linkedin_url) still returns HTTP 200, with person unmatched or match_confidence 'none' — Apollo's documented low-signal behavior, not a client error", async () => {
    // Would assert: matchPerson({ name: "John Smith" },
    // process.env.APOLLO_API_KEY!) resolves without throwing ApolloApiError
    // (i.e. a real 200), with result.person === null OR
    // result.person.matchConfidence === "none", confirming this client
    // doesn't misclassify Apollo's documented "insufficient identifying
    // data" outcome as a failure.
  });

  it.skip("Authentication: an invalid API key genuinely returns HTTP 401 from the real API (proving ApolloApiError's status-401 classification against a REAL response, not an invented one)", async () => {
    // Would assert: matchPerson({ name: "Satya Nadella", domain:
    // "microsoft.com" }, "not-a-real-key") rejects with ApolloApiError
    // whose .status === 401, confirming Apollo's documented 401 behavior
    // for a bad key holds in practice. Also would assert the error message
    // is readable text (Apollo's docs say this body is text/plain, not
    // JSON, unlike Hunter/Clearbit's 401 bodies) — proving this client's
    // non-JSON 401 parsing fallback (see apolloPost's try/catch around
    // JSON.parse) actually handles Apollo's real body, not just a
    // hand-constructed mock.
  });

  it.skip("Rate limiting: issuing requests above Apollo's documented per-hour limit for this endpoint genuinely returns HTTP 429 with error_details.code 'USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED', proving the retryable=true classification against a real rate-limited response", async () => {
    // Would assert: firing >600 People Enrichment requests/hour (Apollo's
    // documented limit for this endpoint) with a real key eventually
    // yields a 429 whose ApolloApiError.retryable === true and
    // .code === "USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED". Note: unlike
    // the other three assertions here, genuinely reproducing this
    // real-world limit also burns a meaningful fraction of the key's
    // hourly quota — a human running this for real should expect that
    // cost, not treat a 429 here as a bug.
  });
});
