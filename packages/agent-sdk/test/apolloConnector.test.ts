import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ApolloConnector,
  NotConfiguredError,
  RateLimitedError,
  MalformedResponseError,
  AuthenticationError,
} from "../src/connectors/apolloConnector.js";
import type { ConnectorConfig } from "../src/connectors/types.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** Instant no-op sleep so retry tests don't actually wait out the real
 * backoff delays. */
const instantSleep = async () => {};

const enabledConfig: ConnectorConfig = {
  rateLimitPerMinute: 100,
  enabled: true,
  termsNote: "test",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("ApolloConnector", () => {
  it("reports not_configured (never fabricates a company) when APOLLO_API_KEY is missing", async () => {
    const connector = new ApolloConnector(null, fakeFetch(200, {}));
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(NotConfiguredError);
  });

  it("falls back to process.env.APOLLO_API_KEY when not passed explicitly", async () => {
    vi.stubEnv("APOLLO_API_KEY", "env-key");
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ organizations: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const connector = new ApolloConnector(undefined as unknown as string, fetchImpl);
    await connector.discover({ query: "Acme" }, enabledConfig);
    expect((capturedHeaders as Record<string, string>)["x-api-key"]).toBe("env-key");
  });

  it("maps a successful 'organizations' response into DiscoveredOrganization[]", async () => {
    const fetchImpl = fakeFetch(200, {
      organizations: [
        {
          id: "org-1",
          name: "Acme Robotics",
          website_url: "https://www.acmerobotics.example",
          primary_domain: "acmerobotics.example",
          industry: "Robotics",
          linkedin_url: "https://linkedin.com/company/acme-robotics",
        },
        {
          // No name at all — must be skipped, never a fabricated placeholder name.
          website_url: "https://nameless.example",
        },
      ],
    });
    const connector = new ApolloConnector("key", fetchImpl);
    const result = await connector.discover({ query: "Acme Robotics" }, enabledConfig);

    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]).toMatchObject({
      name: "Acme Robotics",
      domain: "acmerobotics.example",
      sourceUrl: "https://www.acmerobotics.example",
    });
    expect(result.organizations[0].rawMetadata.source).toBe("apollo");
    expect(result.contacts).toEqual({});
  });

  it("also reads organizations from the 'accounts' array (Apollo's mixed_companies/search shape)", async () => {
    const fetchImpl = fakeFetch(200, {
      accounts: [{ name: "Acme Saved Account", website_url: "https://saved.example" }],
    });
    const connector = new ApolloConnector("key", fetchImpl);
    const result = await connector.discover({ query: "Acme" }, enabledConfig);
    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0].name).toBe("Acme Saved Account");
  });

  it("throws RateLimitedError on HTTP 429", async () => {
    const connector = new ApolloConnector("key", fakeFetch(429, {}));
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(RateLimitedError);
  });

  it("throws a generic Error for an unrelated non-2xx response, after exhausting transient retries", async () => {
    const connector = new ApolloConnector("key", fakeFetch(500, { error: "internal error" }), Date.now, instantSleep);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(/internal error/);
  });

  it("throws AuthenticationError (not a generic Error) on HTTP 401, without retrying", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({}), { status: 401 });
    }) as unknown as typeof fetch;
    const connector = new ApolloConnector("bad-key", fetchImpl, Date.now, instantSleep);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toBe(1); // no retry on an auth failure — retrying can't fix a bad key
  });

  it("throws AuthenticationError on HTTP 403 as well", async () => {
    const connector = new ApolloConnector("key", fakeFetch(403, {}), Date.now, instantSleep);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("retries a transient 503 and succeeds on a later attempt", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) return new Response(JSON.stringify({}), { status: 503 });
      return new Response(JSON.stringify({ organizations: [{ name: "Acme", website_url: "https://acme.example" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const connector = new ApolloConnector("key", fetchImpl, Date.now, instantSleep);
    const result = await connector.discover({ query: "Acme" }, enabledConfig);
    expect(calls).toBe(3);
    expect(result.organizations).toHaveLength(1);
  });

  it("gives up after MAX_TRANSIENT_RETRIES and reports how many attempts were made", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "still down" }), { status: 503 });
    }) as unknown as typeof fetch;
    const connector = new ApolloConnector("key", fetchImpl, Date.now, instantSleep);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(/still down/);
    expect(calls).toBe(3); // 1 initial attempt + 2 retries
  });

  it("wraps and retries a network-level failure (fetch itself rejecting), not just a bad status", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const connector = new ApolloConnector("key", fetchImpl, Date.now, instantSleep);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(3);
  });

  it("sends caller-supplied locations/industries/employeeRanges/page filters, never a hardcoded default", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ organizations: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const connector = new ApolloConnector("key", fetchImpl);
    await connector.discover(
      {
        query: "Acme",
        page: 2,
        locations: ["California, US"],
        industries: ["saas", "fintech"],
        employeeRanges: ["11,50"],
      },
      enabledConfig,
    );
    expect(capturedBody).toMatchObject({
      q_organization_name: "Acme",
      page: 2,
      organization_locations: ["California, US"],
      q_organization_keyword_tags: ["saas", "fintech"],
      organization_num_employees_ranges: ["11,50"],
    });
  });

  it("omits filter params entirely when not requested, rather than sending empty arrays", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ organizations: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const connector = new ApolloConnector("key", fetchImpl);
    await connector.discover({ query: "Acme" }, enabledConfig);
    expect(capturedBody).not.toHaveProperty("organization_locations");
    expect(capturedBody).not.toHaveProperty("q_organization_keyword_tags");
    expect(capturedBody).not.toHaveProperty("organization_num_employees_ranges");
    expect(capturedBody?.page).toBe(1);
  });

  it("throws MalformedResponseError when the response body isn't valid JSON", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const connector = new ApolloConnector("key", fetchImpl);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(MalformedResponseError);
  });

  it("rejects malformed input rather than silently returning an empty result", async () => {
    const connector = new ApolloConnector("key", fakeFetch(200, { organizations: [] }));
    await expect(connector.discover({}, enabledConfig)).rejects.toThrow(/expects/);
  });

  it("passes the injected clock (not Date.now) into the rate limiter's acquire() call", async () => {
    let clockCalls = 0;
    const clock = () => {
      clockCalls += 1;
      return 12_345;
    };
    const connector = new ApolloConnector("key", fakeFetch(200, { organizations: [] }), clock);
    await connector.discover({ query: "Acme" }, enabledConfig);
    expect(clockCalls).toBeGreaterThan(0);
  });

  it("constructs its rate limiter from config.rateLimitPerMinute (reusing SlidingWindowRateLimiter, not a reinvented one)", async () => {
    const connector = new ApolloConnector("key", fakeFetch(200, { organizations: [] }));
    await expect(
      connector.discover({ query: "Acme" }, { rateLimitPerMinute: -1, enabled: true, termsNote: "test" }),
    ).rejects.toThrow(/positive number/);
  });
});
