import { describe, it, expect, vi } from "vitest";

/**
 * SSRF-protection regression test for apps/api/src/workflow/stages/research.ts.
 *
 * Unlike workflowResearchStage.test.ts (which mocks ../src/lib/ssrfGuard.js
 * to neutralize it so unrelated fixture domains like "comp1.com"/"client.com"
 * don't hit real DNS), this file deliberately does NOT mock ssrfGuard.js — it
 * exercises the REAL safeFetch/assertSafeUrl guard end to end, proving that
 * `fetchClientHomepageText` (this stage's one-time bare-`fetch` gap, closed
 * in this change) now goes through the same SSRF-hardened path as
 * growthAnalyzer.ts/siteAudit.ts/crawl4aiClient.ts/internalLinking.ts.
 *
 * A literal private/loopback/link-local IP is validated synchronously by
 * `net.isIP` + the blocked-range tables in ssrfGuard.ts, with no DNS lookup
 * and no TCP connection ever attempted — so this test is fully deterministic
 * and needs no network access or mocking of node:http/https.
 */

vi.stubGlobal(
  "fetch",
  vi.fn(async () => {
    throw new Error(
      "global fetch should never be called for this stage's client-homepage fetch — " +
        "it must go through safeFetch (node:http/https), not bare fetch",
    );
  }),
);

const { runResearchStage } = await import("../src/workflow/stages/research.js");

function buildTenantDb() {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [], rowCount: 0 }));
  return { query } as unknown as import("pg").PoolClient;
}

function baseInput(overrides: Partial<Parameters<typeof runResearchStage>[0]> = {}) {
  return {
    tenantId: "11111111-1111-1111-1111-111111111111",
    projectId: "33333333-3333-3333-3333-333333333333",
    workflowRunId: "55555555-5555-5555-5555-555555555555",
    tenantDb: buildTenantDb(),
    priorStageResults: {},
    inputConfig: {},
    ...overrides,
  };
}

describe("runResearchStage SSRF protection (real, unmocked ssrfGuard)", () => {
  it.each(["127.0.0.1", "localhost", "169.254.169.254", "10.0.0.5", "[::1]"])(
    "never leaks client-homepage text for a blocked researchDomain target %s",
    async (blockedDomain) => {
      const result = await runResearchStage(
        baseInput({ inputConfig: { researchDomain: blockedDomain } }),
      );

      expect(result.status).toBe("completed");
      const data = result.data as any;

      // fetchClientHomepageText's safeFetch call must have thrown
      // SsrfBlockedError (caught internally -> null), so no client keywords
      // were ever extracted from a response.
      expect(data.keywordComparison.clientTopKeywords).toEqual([]);

      // runSiteAudit's own internal safeFetch calls (sitemap/robots/HEAD)
      // must likewise have been blocked rather than ever reaching the target.
      expect(data.siteAudit.status).toBe("audited");
      expect(data.siteAudit.sitemapFound).toBe(false);
      expect(data.siteAudit.robotsFound).toBe(false);
    },
  );

  it("still never calls the global bare fetch for a blocked target (proves the fix: no more bare-fetch fallback)", async () => {
    await runResearchStage(baseInput({ inputConfig: { researchDomain: "127.0.0.1" } }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
