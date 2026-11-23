import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * productAnalytics.ts talks to PostHog Cloud's real hosted Capture API —
 * there is no real PostHog project token in this environment, so every test
 * here mocks global `fetch` rather than ever making a real network call.
 * Same convention as test/hunterProvider.test.ts / test/r2FileStorage.test.ts
 * for other hand-rolled HTTP clients, and the process.env + vi.resetModules()
 * pattern from test/billingWebhooks.test.ts for exercising env.ts's
 * configured-vs-not-configured branches.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("productAnalytics: unconfigured (no POSTHOG_API_KEY)", () => {
  it("isProductAnalyticsConfigured() is honestly false", async () => {
    delete process.env.POSTHOG_API_KEY;
    vi.resetModules();
    const { isProductAnalyticsConfigured } = await import("../src/lib/productAnalytics.js");
    expect(isProductAnalyticsConfigured()).toBe(false);
  });

  it("captureProductEvent() is a complete no-op — never calls fetch at all", async () => {
    delete process.env.POSTHOG_API_KEY;
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { captureProductEvent } = await import("../src/lib/productAnalytics.js");
    captureProductEvent("tenant_created", "tenant-123", { slug: "acme" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("productAnalytics: configured (POSTHOG_API_KEY set)", () => {
  it("isProductAnalyticsConfigured() is true", async () => {
    process.env.POSTHOG_API_KEY = "phc_test_key";
    vi.resetModules();
    const { isProductAnalyticsConfigured } = await import("../src/lib/productAnalytics.js");
    expect(isProductAnalyticsConfigured()).toBe(true);
  });

  it("POSTs the documented request shape to <host>/capture/ with api_key/event/distinct_id/properties/timestamp", async () => {
    process.env.POSTHOG_API_KEY = "phc_test_key";
    delete process.env.POSTHOG_HOST;
    vi.resetModules();

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const { captureProductEvent } = await import("../src/lib/productAnalytics.js");
    captureProductEvent("agent_run_completed", "tenant-abc", { agentKey: "growth_advisor", status: "ok" });

    // Fire-and-forget: captureProductEvent itself returns synchronously
    // without the caller needing to await anything — flush microtasks so
    // the background fetch promise chain has actually run before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://app.posthog.com/capture/");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.api_key).toBe("phc_test_key");
    expect(body.event).toBe("agent_run_completed");
    expect(body.distinct_id).toBe("tenant-abc");
    expect(body.properties).toEqual({ agentKey: "growth_advisor", status: "ok" });
    expect(typeof body.timestamp).toBe("string");
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it("honors a configured POSTHOG_HOST (e.g. the EU region)", async () => {
    process.env.POSTHOG_API_KEY = "phc_test_key";
    process.env.POSTHOG_HOST = "https://eu.posthog.com";
    vi.resetModules();

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const { captureProductEvent } = await import("../src/lib/productAnalytics.js");
    captureProductEvent("tenant_created", "tenant-eu", {});
    await new Promise((resolve) => setImmediate(resolve));

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("https://eu.posthog.com/capture/");
  });

  it("defaults properties to {} when none are passed", async () => {
    process.env.POSTHOG_API_KEY = "phc_test_key";
    vi.resetModules();

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    const { captureProductEvent } = await import("../src/lib/productAnalytics.js");
    captureProductEvent("tenant_created", "tenant-xyz");
    await new Promise((resolve) => setImmediate(resolve));

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.properties).toEqual({});
  });

  it("fire-and-forget: a rejected fetch() never throws or rejects out of captureProductEvent()", async () => {
    process.env.POSTHOG_API_KEY = "phc_test_key";
    vi.resetModules();

    const fetchSpy = vi.fn().mockRejectedValue(new Error("PostHog is down"));
    vi.stubGlobal("fetch", fetchSpy);

    const { captureProductEvent } = await import("../src/lib/productAnalytics.js");

    // The real assertion: calling this synchronously must never throw, and
    // the function itself does not return a Promise the caller has to
    // handle/await/catch.
    expect(() => captureProductEvent("agent_run_completed", "tenant-err", { status: "error" })).not.toThrow();

    // Let the background rejection actually settle (and be swallowed
    // internally) before the test ends, so vitest never reports an
    // unhandled rejection for it.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("logs a warning (not a throw) when PostHog responds non-2xx", async () => {
    process.env.POSTHOG_API_KEY = "phc_test_key";
    vi.resetModules();

    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchSpy);

    const { captureProductEvent } = await import("../src/lib/productAnalytics.js");
    const { logger } = await import("../src/lib/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);

    captureProductEvent("workflow_execution_completed", "tenant-500", {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(warnSpy).toHaveBeenCalled();
  });
});
