import { describe, it } from "vitest";

/**
 * BLOCKED: no real Hunter API key is available in this environment (see
 * docs/PHASE_2_HUNTER_VALIDATION.md). This file documents, in a real,
 * skipped test, exactly what a genuine authenticated validation run would
 * assert — it is intentionally never executed as part of the normal suite.
 *
 * To actually run this file for real: set a real HUNTER_API_KEY env var,
 * delete the `.skip` on each `it`, and run
 * `HUNTER_API_KEY=... npx vitest run test/hunterRealApi.skip.test.ts`.
 */
describe("Hunter API — real, authenticated validation (BLOCKED: no key available)", () => {
  it.skip("Domain Search: a real request against a known domain returns a 200 with at least one real email record", async () => {
    // Would assert: searchDomainPage(<a real domain>, process.env.HUNTER_API_KEY!)
    // resolves with page.meta.results >= 0 and, for a domain known to have
    // published contacts, page.contacts.length > 0 with at least one
    // contact.email matching a real email shape. Also would assert
    // page.credits.used is a NUMBER (not null) on a real response, proving
    // this codebase's optional-credits handling is exercised against a
    // real credit-bearing response, not just mocks.
  });

  it.skip("Email Verifier: a real request against a known-valid mailbox returns status 'valid' or a settled status with a numeric score", async () => {
    // Would assert: verifyEmailWithHunter(<a real test mailbox>,
    // process.env.HUNTER_API_KEY!) resolves with inProgress === false and
    // status in the documented enum, score a number, proving the real
    // response shape matches what mapDomainSearchResponse/
    // verifyEmailWithHunter assume from documentation alone today.
  });

  it.skip("Authentication: an invalid API key genuinely returns HTTP 401 from the real API (proving HunterApiError's status-401 classification against a REAL response, not an invented one)", async () => {
    // Would assert: searchDomainPage("example.com", "not-a-real-key")
    // rejects with HunterApiError whose .status === 401, confirming
    // Hunter's documented 401 behavior for a bad key holds in practice.
  });

  it.skip("Rate limiting: issuing requests above Hunter's documented per-second limit genuinely returns HTTP 403, proving the retryable=true classification against a real rate-limited response", async () => {
    // Would assert: firing >15 Domain Search requests/second with a real
    // key eventually yields a 403 whose HunterApiError.retryable === true.
  });
});
