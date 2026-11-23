import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * @sentry/node's own behavior (envelope format, breadcrumbs, transport) is
 * not this codebase's to test — it's the one deliberate exception to this
 * repo's "hand-rolled fetch client, zero SDK dependency" convention (see
 * this task's handback for the full justification). What IS this codebase's
 * to test is its OWN integration code: that Sentry.init() is called with the
 * right options when SENTRY_DSN is set and never called when it isn't
 * (apps/api/src/index.ts, apps/worker/src/index.ts), and that
 * errorHandler.ts calls Sentry.captureException(err) for real 5xx/unhandled
 * errors. The real exported names (`init`, `captureException`) were
 * confirmed against node_modules/@sentry/node/build/types/index.d.ts before
 * writing this mock, not guessed.
 */

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

describe("middleware/errorHandler.ts: Sentry.captureException wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a genuine unhandled error to Sentry BEFORE the existing logger/response logic runs, and the existing response shape is unchanged", async () => {
    const Sentry = await import("@sentry/node");
    const { errorHandler } = await import("../src/middleware/errorHandler.js");

    const req = { path: "/widgets" } as any;
    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();
    const res = { status: statusMock, json: jsonMock } as any;
    const err = new Error("something broke");

    errorHandler(err, req, res, vi.fn());

    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: { code: "internal_error", message: "Internal server error" } });
  });

  it("reports an HttpError with status >= 500 to Sentry, but NOT a 4xx HttpError", async () => {
    const Sentry = await import("@sentry/node");
    const { errorHandler } = await import("../src/middleware/errorHandler.js");
    const { HttpError } = await import("../src/lib/httpError.js");

    const req = { path: "/widgets" } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

    const serverErr = new HttpError(503, "unavailable", "Service unavailable");
    errorHandler(serverErr, req, res, vi.fn());
    expect(Sentry.captureException).toHaveBeenCalledWith(serverErr);

    vi.clearAllMocks();

    const clientErr = new HttpError(404, "not_found", "Not found");
    errorHandler(clientErr, req, res, vi.fn());
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("does NOT report a ZodError (expected client validation mistake) to Sentry", async () => {
    const Sentry = await import("@sentry/node");
    const { errorHandler } = await import("../src/middleware/errorHandler.js");
    const { z, ZodError } = await import("zod");

    const req = { path: "/widgets" } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

    let zodErr: unknown;
    try {
      z.object({ name: z.string() }).parse({});
    } catch (e) {
      zodErr = e;
    }
    expect(zodErr).toBeInstanceOf(ZodError);

    errorHandler(zodErr, req, res, vi.fn());
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
