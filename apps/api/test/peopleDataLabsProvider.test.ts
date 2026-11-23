import { describe, it, expect, vi } from "vitest";
import {
  findCompany,
  findPerson,
  PeopleDataLabsProvider,
  NotConfiguredPeopleDataLabsProvider,
  PeopleDataLabsApiError,
  resolvePeopleDataLabsApiKey,
  buildPeopleDataLabsProvider,
  PeopleDataLabsNotConfiguredError,
} from "../src/lib/peopleDataLabsProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("People Data Labs Company Enrichment", () => {
  it("findCompany returns the real company record PDL reported", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ status: 200, likelihood: 9, id: "abc", name: "Example Inc", website: "example.com", industry: "software", size: "51-200" }),
    );
    const company = await findCompany("example.com", "test-key", { fetcher });
    expect(company).toEqual(
      expect.objectContaining({ id: "abc", name: "Example Inc", website: "example.com", industry: "software", size: "51-200" }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("https://api.peopledatalabs.com/v5/company/enrich?website=example.com&api_key=test-key"),
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
  });

  it("findCompany returns null (not thrown) on a genuine 404 'not found'", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    const company = await findCompany("unknown-domain.com", "test-key", { fetcher });
    expect(company).toBeNull();
  });

  it("throws PeopleDataLabsApiError on a real failure (e.g. 401)", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ status: 401, error: { type: "authentication_error", message: "bad key" } }, 401));
    await expect(findCompany("example.com", "bad-key", { fetcher })).rejects.toThrow(PeopleDataLabsApiError);
  });

  it("classifies 429 as retryable, 401 as not retryable", async () => {
    const rateLimited = vi.fn().mockResolvedValue(jsonResponse({ status: 429, error: { type: "rate_limit_error", message: "slow down" } }, 429));
    await expect(findCompany("example.com", "key", { fetcher: rateLimited })).rejects.toMatchObject({ status: 429, retryable: true });

    const unauthorized = vi.fn().mockResolvedValue(jsonResponse({ status: 401, error: { type: "authentication_error", message: "bad key" } }, 401));
    await expect(findCompany("example.com", "key", { fetcher: unauthorized })).rejects.toMatchObject({ status: 401, retryable: false });
  });
});

describe("People Data Labs Person Enrichment", () => {
  it("findPerson returns the real person record PDL reported", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 200,
        likelihood: 8,
        data: { full_name: "Jane Doe", job_title: "VP Engineering", emails: [{ address: "jane@example.com" }], phone_numbers: ["+15551234567"], linkedin_url: "https://linkedin.com/in/jane" },
      }),
    );
    const person = await findPerson({ email: "jane@example.com" }, "test-key", { fetcher });
    expect(person).toEqual(
      expect.objectContaining({ fullName: "Jane Doe", jobTitle: "VP Engineering", email: "jane@example.com", phone: "+15551234567", linkedinUrl: "https://linkedin.com/in/jane" }),
    );
  });

  it("findPerson returns null (not thrown) on a genuine 404 'not found'", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    const person = await findPerson({ email: "nobody@example.com" }, "test-key", { fetcher });
    expect(person).toBeNull();
  });

  it("throws PeopleDataLabsApiError on PDL's documented 400 for insufficient identifying input", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ status: 400, error: { type: "invalid_request_error", message: "insufficient input" } }, 400),
    );
    await expect(findPerson({ company: "Example Inc" }, "test-key", { fetcher })).rejects.toThrow(PeopleDataLabsApiError);
  });
});

describe("PeopleDataLabsProvider (DecisionMakerProvider adapter)", () => {
  it("honestly returns [] without making any network call (DecisionMakerLookupInput never carries a person-identifying field)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = new PeopleDataLabsProvider("test-key");
      const candidates = await provider.findDecisionMakers({ organizationName: "Example Inc", domain: "example.com" });
      expect(candidates).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("NotConfiguredPeopleDataLabsProvider", () => {
  it("always throws, never returns a fabricated contact", async () => {
    const provider = new NotConfiguredPeopleDataLabsProvider();
    await expect(provider.findDecisionMakers({ organizationName: "Example Inc", domain: "example.com" })).rejects.toThrow(
      PeopleDataLabsNotConfiguredError,
    );
  });
});

describe("resolvePeopleDataLabsApiKey / buildPeopleDataLabsProvider", () => {
  it("resolvePeopleDataLabsApiKey returns null when neither a tenant credential nor PEOPLE_DATA_LABS_API_KEY is configured", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const key = await resolvePeopleDataLabsApiKey(db as never, "tenant-1", "project-1");
    expect(key).toBeNull();
  });

  it("buildPeopleDataLabsProvider returns the NotConfigured stub when no credential resolves", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const provider = await buildPeopleDataLabsProvider(db as never, "tenant-1", "project-1");
    expect(provider).toBeInstanceOf(NotConfiguredPeopleDataLabsProvider);
  });
});
