import { describe, it, expect, vi } from "vitest";
import {
  validateEmail,
  validatePhone,
  AbstractApiEmailVerificationProvider,
  AbstractApiPhoneVerificationProvider,
  AbstractApiError,
  resolveAbstractApiKey,
  buildAbstractApiEmailProvider,
  buildAbstractApiPhoneProvider,
} from "../src/lib/abstractApiProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("Abstract API Email Validation", () => {
  it("validateEmail returns the real validation Abstract API reported", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        email: "jane@example.com",
        deliverability: "DELIVERABLE",
        quality_score: 0.9,
        is_valid_format: true,
        is_free_email: false,
        is_disposable_email: false,
        is_role_email: false,
        is_catchall_email: false,
        is_mx_found: true,
        is_smtp_valid: true,
      }),
    );
    const result = await validateEmail("jane@example.com", "test-key", { fetcher });
    expect(result).toEqual(
      expect.objectContaining({ email: "jane@example.com", deliverability: "DELIVERABLE", isValidFormat: true, isMxFound: true, isSmtpValid: true }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("https://emailvalidation.abstractapi.com/v1/?api_key=test-key&email=jane%40example.com"),
      expect.anything(),
    );
  });

  it("reads { value, text }-shaped boolean fields defensively", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ email: "jane@example.com", is_valid_format: { value: true, text: "TRUE" }, is_role_email: { value: false, text: "FALSE" } }),
    );
    const result = await validateEmail("jane@example.com", "test-key", { fetcher });
    expect(result.isValidFormat).toBe(true);
    expect(result.isRoleEmail).toBe(false);
  });

  it("throws AbstractApiError on a real failure (e.g. 401)", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "bad key" } }, 401));
    await expect(validateEmail("jane@example.com", "bad-key", { fetcher })).rejects.toThrow(AbstractApiError);
  });
});

describe("Abstract API Phone Validation", () => {
  it("validatePhone returns the real validation Abstract API reported", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        phone: "14154582468",
        valid: true,
        risk_score: "low",
        carrier: "T-Mobile USA, Inc.",
        line_type: "mobile",
        international_format: "+14154582468",
        country_name: "United States",
        country_code: "US",
      }),
    );
    const result = await validatePhone("+14154582468", "test-key", { fetcher });
    expect(result).toEqual(
      expect.objectContaining({ phone: "14154582468", valid: true, carrier: "T-Mobile USA, Inc.", lineType: "mobile", internationalFormat: "+14154582468" }),
    );
  });

  it("throws AbstractApiError on a real failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "bad key" } }, 401));
    await expect(validatePhone("+14154582468", "bad-key", { fetcher })).rejects.toThrow(AbstractApiError);
  });
});

describe("AbstractApiEmailVerificationProvider (EmailVerificationProvider adapter)", () => {
  it("maps DELIVERABLE to 'verified'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ email: "jane@example.com", deliverability: "DELIVERABLE", is_valid_format: true, is_mx_found: true })));
    try {
      const provider = new AbstractApiEmailVerificationProvider("test-key");
      const result = await provider.verifyEmail("jane@example.com");
      expect(result.verificationStatus).toBe("verified");
      expect(result.provider).toBe("abstract_api");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps UNDELIVERABLE to 'invalid', role-based to 'role_based', never 'verified' for either", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ deliverability: "UNDELIVERABLE", is_valid_format: true })));
    try {
      const provider = new AbstractApiEmailVerificationProvider("test-key");
      const result = await provider.verifyEmail("nobody@example.com");
      expect(result.verificationStatus).toBe("invalid");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps a role-based address to 'role_based' even when deliverable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ deliverability: "DELIVERABLE", is_valid_format: true, is_role_email: true })));
    try {
      const provider = new AbstractApiEmailVerificationProvider("test-key");
      const result = await provider.verifyEmail("info@example.com");
      expect(result.verificationStatus).toBe("role_based");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("AbstractApiPhoneVerificationProvider (PhoneVerificationProvider adapter)", () => {
  it("maps a valid phone to isPlausibleE164: true with the normalized international format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ valid: true, international_format: "+14154582468" })));
    try {
      const provider = new AbstractApiPhoneVerificationProvider("test-key");
      const result = await provider.verifyPhone("+14154582468");
      expect(result).toEqual(expect.objectContaining({ normalized: "+14154582468", isPlausibleE164: true, provider: "abstract_api" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("resolveAbstractApiKey / build*Provider", () => {
  it("resolveAbstractApiKey returns null when neither a tenant credential nor ABSTRACT_API_KEY is configured", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const key = await resolveAbstractApiKey(db as never, "tenant-1", "project-1");
    expect(key).toBeNull();
  });

  it("buildAbstractApiEmailProvider/buildAbstractApiPhoneProvider return null (not a stub) when no credential resolves", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    expect(await buildAbstractApiEmailProvider(db as never, "tenant-1", "project-1")).toBeNull();
    expect(await buildAbstractApiPhoneProvider(db as never, "tenant-1", "project-1")).toBeNull();
  });
});
