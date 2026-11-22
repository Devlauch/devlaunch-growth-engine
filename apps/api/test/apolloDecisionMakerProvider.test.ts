import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ApolloDecisionMakerProvider,
  NotConfiguredError,
  RateLimitedError,
  MalformedResponseError,
  AuthenticationError,
} from "../src/lib/apolloDecisionMakerProvider.js";

// Same fakeFetch(status, body) helper convention as
// apps/api/test/emailVerificationProvider.test.ts /
// packages/agent-sdk/test/{googleSearchConnector,apolloConnector}.test.ts.
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** Instant no-op sleep so retry tests don't wait out the real backoff delays. */
const instantSleep = async () => {};

afterEach(() => {
  vi.useRealTimers();
});

describe("ApolloDecisionMakerProvider", () => {
  it("reports not_configured (never fabricates a contact) when no API key is given", async () => {
    const provider = new ApolloDecisionMakerProvider(null, fakeFetch(200, { people: [] }));
    await expect(
      provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" }),
    ).rejects.toThrow(NotConfiguredError);
  });

  it("maps a real Apollo people-search response into DecisionMakerCandidate[], leaving missing fields null", async () => {
    const fetchImpl = fakeFetch(200, {
      people: [
        {
          first_name: "Jane",
          last_name: "Doe",
          title: "Owner",
          email: "jane@acme.com",
          linkedin_url: "https://linkedin.com/in/janedoe",
        },
        {
          // No title/email/phone/linkedin at all — every missing field
          // must come back null, never fabricated.
          name: "Pat Smith",
        },
      ],
    });
    const provider = new ApolloDecisionMakerProvider("key", fetchImpl);
    const candidates = await provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      name: "Jane Doe",
      title: "Owner",
      email: "jane@acme.com",
      sourceUrl: "https://linkedin.com/in/janedoe",
      sourceConfidence: "verified",
    });
    expect(candidates[1]).toMatchObject({
      name: "Pat Smith",
      title: null,
      email: null,
      phone: null,
      sourceUrl: null,
    });
  });

  it("discards Apollo's locked/un-revealed email placeholder rather than surfacing a fake-looking address", async () => {
    const fetchImpl = fakeFetch(200, {
      people: [{ name: "Jane Doe", email: "email_not_unlocked@domain.com" }],
    });
    const provider = new ApolloDecisionMakerProvider("key", fetchImpl);
    const candidates = await provider.findDecisionMakers({ organizationName: "Acme Inc", domain: null });
    expect(candidates[0].email).toBeNull();
  });

  it("skips a person record with no usable name at all, never fabricating a placeholder name", async () => {
    const fetchImpl = fakeFetch(200, { people: [{ title: "CEO", email: "x@acme.com" }] });
    const provider = new ApolloDecisionMakerProvider("key", fetchImpl);
    const candidates = await provider.findDecisionMakers({ organizationName: "Acme Inc", domain: null });
    expect(candidates).toHaveLength(0);
  });

  it("throws RateLimitedError on HTTP 429", async () => {
    const provider = new ApolloDecisionMakerProvider("key", fakeFetch(429, {}));
    await expect(
      provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" }),
    ).rejects.toThrow(RateLimitedError);
  });

  it("throws a generic Error for an unrelated non-2xx response, after exhausting transient retries", async () => {
    const provider = new ApolloDecisionMakerProvider(
      "key",
      fakeFetch(500, { error: "internal error" }),
      Date.now,
      50,
      {},
      instantSleep,
    );
    await expect(
      provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" }),
    ).rejects.toThrow(/internal error/);
  });

  it("throws AuthenticationError (not a generic Error) on HTTP 401, without retrying", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({}), { status: 401 });
    }) as unknown as typeof fetch;
    const provider = new ApolloDecisionMakerProvider("bad-key", fetchImpl, Date.now, 50, {}, instantSleep);
    await expect(
      provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toBe(1);
  });

  it("retries a transient 503 and succeeds on a later attempt", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) return new Response(JSON.stringify({}), { status: 503 });
      return new Response(JSON.stringify({ people: [{ name: "Jane Doe" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new ApolloDecisionMakerProvider("key", fetchImpl, Date.now, 50, {}, instantSleep);
    const candidates = await provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" });
    expect(calls).toBe(3);
    expect(candidates).toHaveLength(1);
  });

  it("falls back to DEFAULT_DECISION_MAKER_TITLES when no jobTitles filter is given (never an unscoped/empty search)", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ people: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new ApolloDecisionMakerProvider("key", fetchImpl);
    await provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" });
    expect(Array.isArray(capturedBody?.person_titles)).toBe(true);
    expect((capturedBody?.person_titles as string[]).length).toBeGreaterThan(0);
  });

  it("uses caller-supplied filters (jobTitles/seniorities/departments/locations/companySizeRanges) instead of the hardcoded default — never one forced ICP", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ people: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new ApolloDecisionMakerProvider("key", fetchImpl, Date.now, 50, {
      jobTitles: ["CTO", "VP Engineering", "Head of Engineering"],
      seniorities: ["c_suite", "vp"],
      departments: ["engineering"],
      locations: ["California, US"],
      companySizeRanges: ["11,50"],
    });
    await provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" });
    expect(capturedBody).toMatchObject({
      person_titles: ["CTO", "VP Engineering", "Head of Engineering"],
      person_seniorities: ["c_suite", "vp"],
      person_departments: ["engineering"],
      person_locations: ["California, US"],
      organization_num_employees_ranges: ["11,50"],
    });
  });

  it("throws MalformedResponseError when the response body isn't valid JSON", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const provider = new ApolloDecisionMakerProvider("key", fetchImpl);
    await expect(
      provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" }),
    ).rejects.toThrow(MalformedResponseError);
  });

  it("requires organizationName or domain rather than making an unscoped request", async () => {
    const provider = new ApolloDecisionMakerProvider("key", fakeFetch(200, { people: [] }));
    await expect(
      provider.findDecisionMakers({ organizationName: "", domain: null }),
    ).rejects.toThrow(/requires organizationName or domain/);
  });

  it("self-throttles via the injected clock (SlidingWindowRateLimiter reused, not reinvented)", async () => {
    let clockCalls = 0;
    const clock = () => {
      clockCalls += 1;
      return 12_345;
    };
    const provider = new ApolloDecisionMakerProvider("key", fakeFetch(200, { people: [] }), clock);
    await provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" });
    expect(clockCalls).toBeGreaterThan(0);
  });
});
