import { describe, it, expect } from "vitest";
import {
  verifyPhone,
  buildPhoneVerificationWaterfall,
  FormatPhoneVerificationProvider,
  NotConfiguredCarrierLookupProvider,
  NotConfiguredError,
  type PhoneVerificationProvider,
} from "../src/lib/phoneVerification.js";

/**
 * Milestone 3 Phase 2 completion pass: phoneVerification.ts had zero direct
 * unit tests before this round (discovery.test.ts only covers the pure
 * normalizePhone/isPlausibleE164 helpers, not verifyPhone or the provider
 * waterfall added this round).
 */

describe("buildPhoneVerificationWaterfall", () => {
  it("is [NotConfigured paid-provider stub, real format/E.164 provider] — a real provider added later only needs to be prepended", () => {
    const providers = buildPhoneVerificationWaterfall();
    expect(providers).toHaveLength(2);
    expect(providers[0]).toBeInstanceOf(NotConfiguredCarrierLookupProvider);
    expect(providers[1]).toBeInstanceOf(FormatPhoneVerificationProvider);
  });
});

describe("NotConfiguredCarrierLookupProvider", () => {
  it("always throws NotConfiguredError — never returns a fabricated carrier/line-type result", async () => {
    const provider = new NotConfiguredCarrierLookupProvider();
    await expect(provider.verifyPhone("+14155550132")).rejects.toThrow(NotConfiguredError);
  });
});

describe("verifyPhone (waterfall)", () => {
  it("tries the not-configured stub first, then falls through to the real format/E.164 provider", async () => {
    const result = await verifyPhone("+1 (415) 555-0132");
    expect(result.provider).toBe("format_e164");
    expect(result.normalized).toBe("+14155550132");
    expect(result.isPlausibleE164).toBe(true);
  });

  it("flags an implausible number as not E.164-plausible without throwing", async () => {
    const result = await verifyPhone("+1234");
    expect(result.normalized).toBe("+1234");
    expect(result.isPlausibleE164).toBe(false);
  });

  it("returns null/false for input with no usable country code or plus prefix", async () => {
    const result = await verifyPhone("5550132");
    expect(result.normalized).toBeNull();
    expect(result.isPlausibleE164).toBe(false);
  });

  it("a fake real provider ahead of the stub in a custom waterfall answers instead, without verifyPhone itself changing", async () => {
    const fakeRealProvider: PhoneVerificationProvider = {
      name: "fake-carrier-lookup",
      verifyPhone: async () => ({ normalized: "+14155550132", isPlausibleE164: true, provider: "fake-carrier-lookup" }),
    };
    const result = await verifyPhone("+14155550132", [fakeRealProvider]);
    expect(result.provider).toBe("fake-carrier-lookup");
  });
});
