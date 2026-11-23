import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Verifies apps/api/src/index.ts's own Sentry.init() gating: called with the
 * right options when SENTRY_DSN is set, never called at all when it isn't.
 * @sentry/node's own init() behavior is not this codebase's to test (see
 * test/sentryIntegration.test.ts's doc comment) — this only asserts on OUR
 * call. Every other real side effect of index.ts (app.listen, the DB pool,
 * the usage-tracking flush loop) is mocked out so importing it here never
 * opens a real port or DB connection — this module has no other existing
 * test importing it directly, for the same reason.
 */

const listenMock = vi.fn((_port: number, cb: () => void) => {
  cb();
  return { close: vi.fn() };
});

vi.mock("../src/app.js", () => ({
  createApp: () => ({ listen: listenMock }),
}));

vi.mock("../src/db/pool.js", () => ({
  pool: { end: vi.fn().mockResolvedValue(undefined) },
  withTenantContext: vi.fn(),
  assertDatabaseRoleRespectsRls: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/usageTracking.js", () => ({
  startApiRequestUsageFlush: vi.fn(),
  stopApiRequestUsageFlush: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

const ORIGINAL_SENTRY_DSN = process.env.SENTRY_DSN;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_SENTRY_DSN === undefined) {
    delete process.env.SENTRY_DSN;
  } else {
    process.env.SENTRY_DSN = ORIGINAL_SENTRY_DSN;
  }
});

describe("apps/api/src/index.ts: Sentry.init() gating", () => {
  it("calls Sentry.init() with dsn/environment/tracesSampleRate when SENTRY_DSN is set", async () => {
    process.env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";
    const Sentry = await import("@sentry/node");

    await import("../src/index.js");

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const options = (Sentry.init as any).mock.calls[0][0];
    expect(options.dsn).toBe("https://examplePublicKey@o0.ingest.sentry.io/0");
    expect(options.environment).toBe(process.env.NODE_ENV);
    expect(typeof options.tracesSampleRate).toBe("number");
  });

  it("never calls Sentry.init() when SENTRY_DSN is unset", async () => {
    delete process.env.SENTRY_DSN;
    const Sentry = await import("@sentry/node");

    await import("../src/index.js");

    expect(Sentry.init).not.toHaveBeenCalled();
  });
});
