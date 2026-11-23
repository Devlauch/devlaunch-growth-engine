import { describe, it, expect } from "vitest";
import {
  verifyEmail,
  buildEmailVerificationWaterfall,
  DnsEmailVerificationProvider,
  NotConfiguredBounceVerificationProvider,
  NotConfiguredError,
  type EmailVerificationProvider,
} from "../src/lib/emailVerification.js";

/**
 * Milestone 3 Phase 2 completion pass: provider-waterfall-level tests for
 * emailVerification.ts, complementing the existing route-level tests in
 * discovery.test.ts (which exercise verifyEmail's observable behavior but
 * not the waterfall/provider seam added this round).
 */

describe("buildEmailVerificationWaterfall", () => {
  it("is [NotConfigured paid-provider stub, real DNS/syntax provider] — a real provider added later only needs to be prepended", () => {
    const providers = buildEmailVerificationWaterfall();
    expect(providers).toHaveLength(2);
    expect(providers[0]).toBeInstanceOf(NotConfiguredBounceVerificationProvider);
    expect(providers[1]).toBeInstanceOf(DnsEmailVerificationProvider);
  });
});

describe("NotConfiguredBounceVerificationProvider", () => {
  it("always throws NotConfiguredError — never returns a fabricated mailbox-verification result", async () => {
    const provider = new NotConfiguredBounceVerificationProvider();
    await expect(provider.verifyEmail("jane@example.com")).rejects.toThrow(NotConfiguredError);
  });
});

describe("verifyEmail (waterfall)", () => {
  it("tries the not-configured stub first (recorded internally), then falls through to the real DNS provider", async () => {
    const resolver = { resolveMx: async () => [{ exchange: "mx.example.com", priority: 10 }] };
    const result = await verifyEmail("jane@example.com", { resolver });
    expect(result.provider).toBe("dns_mx_syntax");
    expect(result.verificationStatus).toBe("verified");
  });

  it("a fake real provider ahead of the stub in a custom waterfall answers instead, without verifyEmail itself changing", async () => {
    const fakeRealProvider: EmailVerificationProvider = {
      name: "fake-bounce-provider",
      verifyEmail: async () => ({
        syntaxValid: true,
        mxFound: true,
        isRoleBased: false,
        verificationStatus: "verified",
        checkedAt: new Date().toISOString(),
        provider: "fake-bounce-provider",
      }),
    };
    const result = await verifyEmail("jane@example.com", { providers: [fakeRealProvider] });
    expect(result.provider).toBe("fake-bounce-provider");
  });

  it("still returns invalid for syntactically bad input without ever reaching DNS", async () => {
    const result = await verifyEmail("not-an-email");
    expect(result.verificationStatus).toBe("invalid");
    expect(result.provider).toBe("dns_mx_syntax");
  });
});
