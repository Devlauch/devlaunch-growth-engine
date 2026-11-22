import { describe, it, expect, vi } from "vitest";
import {
  searchDomainPage,
  searchDomainAllPages,
  verifyEmailWithHunter,
  HunterApiError,
  HunterTimeoutError,
  HunterProvider,
  NotConfiguredHunterProvider,
  HunterNotConfiguredError,
} from "../src/lib/hunterProvider.js";

/**
 * All of these tests exercise real request/response handling LOGIC (URL
 * construction, pagination, status-code classification, field mapping)
 * against a fake, injected `fetcher` — there is no real Hunter API key in
 * this environment, so no test here ever talks to the real
 * api.hunter.io. See docs/PHASE_2_HUNTER_VALIDATION.md for the explicit
 * BLOCKED status of real-credential validation.
 */

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  } as unknown as Response;
}

describe("HunterProvider: domain search", () => {
  it("builds the request with api_key as a query parameter (Hunter's documented auth mechanism)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: { domain: "acme.com", emails: [] }, meta: { results: 0, limit: 100, offset: 0 } }),
    );
    await searchDomainPage("acme.com", "test-key-123", { fetcher });
    const [calledUrl] = fetcher.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.pathname).toBe("/v2/domain-search");
    expect(url.searchParams.get("api_key")).toBe("test-key-123");
    expect(url.searchParams.get("domain")).toBe("acme.com");
  });

  it("maps a real-shaped domain-search response field-for-field, never inventing a name for a role email", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(
        200,
        {
          data: {
            domain: "acme.com",
            organization: "Acme Inc",
            pattern: "{first}.{last}",
            accept_all: false,
            emails: [
              {
                value: "jane.doe@acme.com",
                type: "personal",
                provenance: "found",
                confidence: 92,
                first_name: "Jane",
                last_name: "Doe",
                position: "VP Engineering",
                seniority: "executive",
                department: "engineering",
                sources: [{ domain: "acme.com", uri: "https://acme.com/team", extracted_on: "2026-01-01" }],
                verification: { date: "2026-01-02", status: "valid" },
              },
              {
                value: "info@acme.com",
                type: "generic",
                provenance: "inferred",
                confidence: 40,
                first_name: null,
                last_name: null,
                position: null,
                sources: [],
              },
            ],
          },
          meta: { results: 2, limit: 100, offset: 0 },
        },
        { "X-Credits-Used": "1", "X-Credits-Unit": "search" },
      ),
    );

    const page = await searchDomainPage("acme.com", "test-key", { fetcher });
    expect(page.organization).toBe("Acme Inc");
    expect(page.contacts).toHaveLength(2);
    expect(page.contacts[0]).toMatchObject({
      email: "jane.doe@acme.com",
      firstName: "Jane",
      lastName: "Doe",
      position: "VP Engineering",
      provenance: "found",
      confidence: 92,
    });
    // The generic/role email has no real name Hunter provided — never fabricated.
    expect(page.contacts[1].firstName).toBeNull();
    expect(page.contacts[1].lastName).toBeNull();
    expect(page.credits).toEqual({ used: 1, unit: "search" });
  });

  it("paginates across multiple pages using offset, stopping once meta.results is reached", async () => {
    const page1Emails = Array.from({ length: 100 }, (_, i) => ({ value: `person${i}@acme.com`, type: "personal" }));
    const page2Emails = Array.from({ length: 30 }, (_, i) => ({ value: `person${100 + i}@acme.com`, type: "personal" }));

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { domain: "acme.com", emails: page1Emails }, meta: { results: 130, limit: 100, offset: 0 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { domain: "acme.com", emails: page2Emails }, meta: { results: 130, limit: 100, offset: 100 } }),
      );

    const { contacts, pages, truncated } = await searchDomainAllPages("acme.com", "test-key", { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(contacts).toHaveLength(130);
    expect(pages).toHaveLength(2);
    expect(truncated).toBe(false);
    const secondCallUrl = new URL((fetcher.mock.calls[1] as [string])[0]);
    expect(secondCallUrl.searchParams.get("offset")).toBe("100");
  });

  it("stops at the safety cap (never an infinite loop) when the reported total keeps exceeding what's fetched", async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      jsonResponse(200, {
        data: { domain: "huge.com", emails: [{ value: "a@huge.com", type: "personal" }] },
        meta: { results: 1_000_000, limit: 100, offset: 0 },
      }),
    );
    const { pages, truncated } = await searchDomainAllPages("huge.com", "test-key", { fetcher, maxPages: 3 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(pages).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("classifies a 401 (invalid key) as a non-retryable HunterApiError", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(401, { errors: [{ id: "unauthorized", code: 401, details: "Invalid API key" }] }),
    );
    await expect(searchDomainPage("acme.com", "bad-key", { fetcher })).rejects.toMatchObject({
      name: "HunterApiError",
      status: 401,
      retryable: false,
    });
  });

  it("classifies a 429 (usage limit) as retryable", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(429, { errors: [{ code: 429, details: "Usage limit reached" }] }));
    await expect(searchDomainPage("acme.com", "k", { fetcher })).rejects.toMatchObject({
      name: "HunterApiError",
      status: 429,
      retryable: true,
    });
  });

  it("classifies a 500 as retryable", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(500, { errors: [{ details: "Internal error" }] }));
    await expect(searchDomainPage("acme.com", "k", { fetcher })).rejects.toMatchObject({ status: 500, retryable: true });
  });

  it("throws HunterTimeoutError when the request aborts", async () => {
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    await expect(searchDomainPage("acme.com", "k", { fetcher, timeoutMs: 5 })).rejects.toThrow(HunterTimeoutError);
  });
});

describe("HunterProvider: email verifier", () => {
  it("maps a settled verification response", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          email: "jane@acme.com",
          status: "valid",
          score: 90,
          regexp: true,
          mx_records: true,
          smtp_server: true,
          smtp_check: true,
          accept_all: false,
          disposable: false,
          webmail: false,
          block: false,
          verification: { date: "2026-01-01", status: "valid" },
        },
      }),
    );
    const result = await verifyEmailWithHunter("jane@acme.com", "k", { fetcher });
    expect(result.status).toBe("valid");
    expect(result.inProgress).toBe(false);
    expect(result.smtpCheck).toBe(true);
  });

  it("treats HTTP 202 (still processing) as in-progress, not an error", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(202, {}));
    const result = await verifyEmailWithHunter("jane@acme.com", "k", { fetcher });
    expect(result.inProgress).toBe(true);
    expect(result.status).toBe("unknown");
  });

  it("treats HTTP 222 (SMTP check failed, retry later) as in-progress, not an error", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(222, {}));
    const result = await verifyEmailWithHunter("jane@acme.com", "k", { fetcher });
    expect(result.inProgress).toBe(true);
  });

  it("propagates a genuine 4xx/5xx as HunterApiError (not silently swallowed)", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(400, { errors: [{ details: "bad email param" }] }));
    await expect(verifyEmailWithHunter("not-an-email", "k", { fetcher })).rejects.toBeInstanceOf(HunterApiError);
  });
});

describe("HunterProvider as a DecisionMakerProvider (waterfall compatibility)", () => {
  it("maps Hunter 'found' provenance to sourceConfidence 'verified', and 'inferred' to 'inferred' (never 'verified' when Hunter didn't itself confirm it)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          domain: "acme.com",
          emails: [
            { value: "jane@acme.com", first_name: "Jane", last_name: "Doe", position: "CTO", provenance: "found", phone_number: "+15551234567" },
            { value: "info@acme.com", provenance: "inferred" },
          ],
        },
        meta: { results: 2, limit: 100, offset: 0 },
      }),
    );
    const provider = new HunterProvider("k");
    // Inject the fetcher via the module-level searchDomainAllPages the
    // provider calls internally — done by monkeypatching global fetch for
    // this one assertion since HunterProvider doesn't take a fetcher itself
    // (it's a thin adapter over the already-tested pagination helper).
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      const candidates = await provider.findDecisionMakers({ organizationName: "Acme", domain: "acme.com" });
      expect(candidates).toHaveLength(2);
      expect(candidates[0]).toMatchObject({ name: "Jane Doe", title: "CTO", email: "jane@acme.com", sourceConfidence: "verified" });
      expect(candidates[1]).toMatchObject({ email: "info@acme.com", sourceConfidence: "inferred" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns [] for an organization with no domain, rather than calling Hunter with nothing to search", async () => {
    const provider = new HunterProvider("k");
    const candidates = await provider.findDecisionMakers({ organizationName: "No Domain Co", domain: null });
    expect(candidates).toEqual([]);
  });
});

describe("NotConfiguredHunterProvider (honest stub, same convention as NotConfiguredDecisionMakerProvider)", () => {
  it("always throws HunterNotConfiguredError, never returns a fabricated result", async () => {
    const provider = new NotConfiguredHunterProvider();
    await expect(provider.findDecisionMakers({ organizationName: "Acme", domain: "acme.com" })).rejects.toBeInstanceOf(
      HunterNotConfiguredError,
    );
  });
});
