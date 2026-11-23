import { describe, it, expect, vi, afterEach } from "vitest";
import {
  GoogleSearchConnector,
  NotConfiguredError,
  RateLimitedError,
  MalformedResponseError,
} from "../src/connectors/googleSearchConnector.js";
import type { ConnectorConfig } from "../src/connectors/types.js";

// Same fakeFetch(status, body) helper convention as
// apps/api/test/emailVerificationProvider.test.ts.
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function throwingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

const enabledConfig: ConnectorConfig = {
  rateLimitPerMinute: 100,
  enabled: true,
  termsNote: "test",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("GoogleSearchConnector", () => {
  it("reports not_configured (never fabricates a result) when the API key is missing", async () => {
    const connector = new GoogleSearchConnector(null, "engine-id", fakeFetch(200, {}));
    await expect(connector.discover({ query: "Acme Robotics" }, enabledConfig)).rejects.toThrow(
      NotConfiguredError,
    );
  });

  it("reports not_configured when the engine ID is missing", async () => {
    const connector = new GoogleSearchConnector("api-key", null, fakeFetch(200, {}));
    await expect(connector.discover({ query: "Acme Robotics" }, enabledConfig)).rejects.toThrow(
      NotConfiguredError,
    );
  });

  it("falls back to process.env when apiKey/engineId aren't passed explicitly", async () => {
    vi.stubEnv("GOOGLE_SEARCH_API_KEY", "env-key");
    vi.stubEnv("GOOGLE_SEARCH_ENGINE_ID", "env-engine");
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const connector = new GoogleSearchConnector(undefined as unknown as string, undefined as unknown as string, fetchImpl);
    await connector.discover({ query: "Acme" }, enabledConfig);
    expect(capturedUrl).toContain("key=env-key");
    expect(capturedUrl).toContain("cx=env-engine");
  });

  it("maps a successful response into DiscoveredOrganization[], never inventing fields the API didn't return", async () => {
    const fetchImpl = fakeFetch(200, {
      items: [
        {
          title: "Acme Robotics",
          link: "https://www.acmerobotics.example/about",
          displayLink: "acmerobotics.example",
          snippet: "Robotics company based in Springfield.",
        },
        {
          // Malformed item missing `link` — must be skipped, not fabricated.
          title: "No link here",
        },
      ],
    });
    const connector = new GoogleSearchConnector("key", "engine", fetchImpl);
    const result = await connector.discover({ query: "Acme Robotics" }, enabledConfig);

    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]).toMatchObject({
      name: "Acme Robotics",
      domain: "acmerobotics.example",
      sourceUrl: "https://www.acmerobotics.example/about",
    });
    expect(result.organizations[0].rawMetadata.source).toBe("google-programmable-search");
    expect(result.contacts).toEqual({});
  });

  it("throws RateLimitedError on HTTP 429 — never falls back to scraping", async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount += 1;
      return new Response(JSON.stringify({}), { status: 429 });
    }) as unknown as typeof fetch;

    const connector = new GoogleSearchConnector("key", "engine", fetchImpl);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(RateLimitedError);
    expect(callCount).toBe(1); // Exactly one request — no retry-via-scraping fallback.
  });

  it("treats a 403 RESOURCE_EXHAUSTED response as rate_limited too, not a generic failure", async () => {
    const fetchImpl = fakeFetch(403, {
      error: { code: 403, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric" },
    });
    const connector = new GoogleSearchConnector("key", "engine", fetchImpl);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(RateLimitedError);
  });

  it("throws a generic Error (not RateLimitedError) for an unrelated non-2xx response", async () => {
    const fetchImpl = fakeFetch(500, { error: { message: "internal error" } });
    const connector = new GoogleSearchConnector("key", "engine", fetchImpl);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(/HTTP 500/);
  });

  it("throws MalformedResponseError when the response body isn't valid JSON", async () => {
    const fetchImpl = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const connector = new GoogleSearchConnector("key", "engine", fetchImpl);
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(MalformedResponseError);
  });

  it("wraps a network failure in a descriptive Error rather than letting it propagate raw", async () => {
    const connector = new GoogleSearchConnector("key", "engine", throwingFetch("ECONNRESET"));
    await expect(connector.discover({ query: "Acme" }, enabledConfig)).rejects.toThrow(
      /Google Custom Search request failed/,
    );
  });

  it("rejects malformed input rather than silently returning an empty result", async () => {
    const connector = new GoogleSearchConnector("key", "engine", fakeFetch(200, { items: [] }));
    await expect(connector.discover({}, enabledConfig)).rejects.toThrow(/expects/);
  });

  it("refuses to run when the connector is disabled for this tenant", async () => {
    const connector = new GoogleSearchConnector("key", "engine", fakeFetch(200, { items: [] }));
    await expect(
      connector.discover({ query: "Acme" }, { ...enabledConfig, enabled: false }),
    ).rejects.toThrow(/disabled/);
  });

  it("passes the injected clock (not Date.now) into the rate limiter's acquire() call", async () => {
    let clockCalls = 0;
    const clock = () => {
      clockCalls += 1;
      return 12_345;
    };
    const connector = new GoogleSearchConnector("key", "engine", fakeFetch(200, { items: [] }), clock);
    await connector.discover({ query: "Acme" }, enabledConfig);
    expect(clockCalls).toBeGreaterThan(0);
  });

  it("constructs its rate limiter from config.rateLimitPerMinute (reusing SlidingWindowRateLimiter, not a reinvented one)", async () => {
    // SlidingWindowRateLimiter's constructor throws for a non-positive
    // maxPerMinute (rateLimiter.ts); a configured, non-zero-but-invalid
    // value of -1 reaching that constructor proves `discover()` really
    // builds the limiter from `config.rateLimitPerMinute` rather than
    // silently ignoring it or hardcoding its own default.
    const connector = new GoogleSearchConnector("key", "engine", fakeFetch(200, { items: [] }));
    await expect(
      connector.discover({ query: "Acme" }, { rateLimitPerMinute: -1, enabled: true, termsNote: "test" }),
    ).rejects.toThrow(/positive number/);
  });
});
