import { describe, it, expect, vi } from "vitest";
import { verifyEmailCombined } from "../src/lib/hunterEmailVerification.js";

/** No real DNS or Hunter API calls — `resolver` and `hunterFetcher` are both
 * injected fakes, exercising the real mapping logic in isolation. */

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

const mxResolverFound = { resolveMx: vi.fn().mockResolvedValue([{ exchange: "mx.acme.com", priority: 10 }]) };
const mxResolverNotFound = { resolveMx: vi.fn().mockRejectedValue(new Error("ENOTFOUND")) };

describe("verifyEmailCombined: free tier only (no Hunter key)", () => {
  it("never calls Hunter for a syntactically invalid address", async () => {
    const fetcher = vi.fn();
    const result = await verifyEmailCombined("not-an-email", { resolver: mxResolverFound, hunterApiKey: "would-be-used", hunterFetcher: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.combinedStatus).toBe("invalid");
    expect(result.hunterTier.ran).toBe(false);
  });

  it("maps a role-based free-tier result to combinedStatus 'role_based' (not silently 'valid')", async () => {
    const result = await verifyEmailCombined("info@acme.com", { resolver: mxResolverFound });
    expect(result.freeTier.verificationStatus).toBe("role_based");
    expect(result.combinedStatus).toBe("role_based");
    expect(result.hunterTier.ran).toBe(false);
  });

  it("maps a no-MX free-tier result to combinedStatus 'risky'", async () => {
    const result = await verifyEmailCombined("jane@nonexistent-domain-xyz.com", { resolver: mxResolverNotFound });
    expect(result.freeTier.verificationStatus).toBe("risky");
    expect(result.combinedStatus).toBe("risky");
  });

  it("maps a clean free-tier 'verified' result (no Hunter configured) to 'not_verified' — never claims mailbox-level proof", async () => {
    const result = await verifyEmailCombined("jane.doe@acme.com", { resolver: mxResolverFound });
    expect(result.freeTier.verificationStatus).toBe("verified");
    expect(result.combinedStatus).toBe("not_verified");
  });
});

describe("verifyEmailCombined: Hunter tier", () => {
  it("maps Hunter 'valid' to combinedStatus 'valid'", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { data: { status: "valid", smtp_check: true, accept_all: false } }));
    const result = await verifyEmailCombined("jane.doe@acme.com", { resolver: mxResolverFound, hunterApiKey: "k", hunterFetcher: fetcher });
    expect(result.combinedStatus).toBe("valid");
    expect(result.hunterTier.ran).toBe(true);
  });

  it("NEVER maps Hunter 'accept_all' to 'valid' — reports it as its own distinct status", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { data: { status: "accept_all", accept_all: true } }));
    const result = await verifyEmailCombined("jane.doe@acme.com", { resolver: mxResolverFound, hunterApiKey: "k", hunterFetcher: fetcher });
    expect(result.combinedStatus).toBe("accept_all");
    expect(result.combinedStatus).not.toBe("valid");
  });

  it("maps Hunter 'disposable' to 'invalid'", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { data: { status: "disposable", disposable: true } }));
    const result = await verifyEmailCombined("temp@mailinator.com", { resolver: mxResolverFound, hunterApiKey: "k", hunterFetcher: fetcher });
    expect(result.combinedStatus).toBe("invalid");
  });

  it("maps Hunter 'webmail' + smtp_check true + accept_all false to 'valid'", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { data: { status: "webmail", smtp_check: true, accept_all: false } }));
    const result = await verifyEmailCombined("jane@gmail.com", { resolver: mxResolverFound, hunterApiKey: "k", hunterFetcher: fetcher });
    expect(result.combinedStatus).toBe("valid");
  });

  it("maps Hunter 'webmail' with no smtp_check signal to 'unknown' (informational status alone is not a deliverability verdict)", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { data: { status: "webmail" } }));
    const result = await verifyEmailCombined("jane@gmail.com", { resolver: mxResolverFound, hunterApiKey: "k", hunterFetcher: fetcher });
    expect(result.combinedStatus).toBe("unknown");
  });

  it("maps a 202 in-progress Hunter response to 'unknown', not 'provider_error'", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(202, {}));
    const result = await verifyEmailCombined("jane.doe@acme.com", { resolver: mxResolverFound, hunterApiKey: "k", hunterFetcher: fetcher });
    expect(result.combinedStatus).toBe("unknown");
    expect(result.hunterTier.result?.inProgress).toBe(true);
  });

  it("maps a genuine Hunter API failure to 'provider_error', preserving the real error", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(401, { errors: [{ details: "Invalid API key" }] }));
    const result = await verifyEmailCombined("jane.doe@acme.com", { resolver: mxResolverFound, hunterApiKey: "bad-key", hunterFetcher: fetcher });
    expect(result.combinedStatus).toBe("provider_error");
    expect(result.hunterTier.error).toMatchObject({ kind: "HunterApiError", status: 401 });
  });

  it("never throws even when Hunter is completely unreachable", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await verifyEmailCombined("jane.doe@acme.com", { resolver: mxResolverFound, hunterApiKey: "k", hunterFetcher: fetcher });
    expect(result.combinedStatus).toBe("provider_error");
  });
});
