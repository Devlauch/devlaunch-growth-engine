import { describe, it, expect, vi } from "vitest";
import {
  generateVerificationToken,
  verificationRecordName,
  verifyCustomDomainOwnership,
  isPlausibleDomain,
  type TxtResolver,
} from "../src/lib/customDomainVerification.js";

function mockResolver(impl: TxtResolver["resolveTxt"]): TxtResolver {
  return { resolveTxt: impl as TxtResolver["resolveTxt"] };
}

describe("generateVerificationToken", () => {
  it("generates a real, unique, non-guessable token each call", () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(30);
  });
});

describe("verificationRecordName", () => {
  it("builds the documented _devlaunch-verify.<domain> record name", () => {
    expect(verificationRecordName("example.com")).toBe("_devlaunch-verify.example.com");
  });
});

describe("isPlausibleDomain", () => {
  it("accepts a real-shaped domain", () => {
    expect(isPlausibleDomain("example.com")).toBe(true);
    expect(isPlausibleDomain("sub.example.co.uk")).toBe(true);
  });
  it("rejects malformed input without ever touching DNS", () => {
    expect(isPlausibleDomain("")).toBe(false);
    expect(isPlausibleDomain("not a domain")).toBe(false);
    expect(isPlausibleDomain("-leading-hyphen.com")).toBe(false);
  });
});

describe("verifyCustomDomainOwnership", () => {
  const token = "abc123token";

  it("returns invalid_domain and never calls DNS for a malformed domain", async () => {
    const resolveTxt = vi.fn();
    const result = await verifyCustomDomainOwnership("not a domain", token, { resolver: mockResolver(resolveTxt) });
    expect(result.status).toBe("invalid_domain");
    expect(resolveTxt).not.toHaveBeenCalled();
  });

  it("returns verified when the real TXT lookup contains the exact token", async () => {
    const resolveTxt = vi.fn(async (name: string) => {
      expect(name).toBe("_devlaunch-verify.example.com");
      return [[token]];
    });
    const result = await verifyCustomDomainOwnership("example.com", token, { resolver: mockResolver(resolveTxt) });
    expect(result.status).toBe("verified");
  });

  it("joins multi-chunk TXT record values before comparing (same convention as dnsVerification.ts)", async () => {
    const resolveTxt = vi.fn(async () => [["abc", "123", "token"]]);
    const result = await verifyCustomDomainOwnership("example.com", token, { resolver: mockResolver(resolveTxt) });
    expect(result.status).toBe("verified");
  });

  it("returns not_found when the token is absent from the TXT records", async () => {
    const resolveTxt = vi.fn(async () => [["some-other-value"]]);
    const result = await verifyCustomDomainOwnership("example.com", token, { resolver: mockResolver(resolveTxt) });
    expect(result.status).toBe("not_found");
    expect(result.foundRecords).toEqual(["some-other-value"]);
  });

  it("maps any DNS resolution failure (NXDOMAIN/timeout/etc) to not_found, never throws", async () => {
    const resolveTxt = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const result = await verifyCustomDomainOwnership("example.com", token, { resolver: mockResolver(resolveTxt) });
    expect(result.status).toBe("not_found");
  });

  it("never reports verified for a correct-looking but different token (no substring match)", async () => {
    const resolveTxt = vi.fn(async () => [[`${token}-but-not-quite`]]);
    const result = await verifyCustomDomainOwnership("example.com", token, { resolver: mockResolver(resolveTxt) });
    expect(result.status).toBe("not_found");
  });
});
