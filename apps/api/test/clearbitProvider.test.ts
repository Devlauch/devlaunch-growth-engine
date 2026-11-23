import { describe, it, expect, vi } from "vitest";
import {
  findCompany,
  searchProspector,
  ClearbitProvider,
  NotConfiguredClearbitProvider,
  ClearbitApiError,
  resolveClearbitApiKey,
  buildClearbitProvider,
} from "../src/lib/clearbitProvider.js";
import { ClearbitNotConfiguredError } from "../src/lib/clearbitProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("Clearbit Company Enrichment", () => {
  it("findCompany returns the real company record Clearbit reported", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ id: "abc", name: "Example Inc", domain: "example.com", metrics: { employees: 50 } }),
    );
    const company = await findCompany("example.com", "test-key", { fetcher });
    expect(company).toEqual(
      expect.objectContaining({ id: "abc", name: "Example Inc", domain: "example.com" }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("https://company.clearbit.com/v2/companies/find?domain=example.com"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-key" }) }),
    );
  });

  it("findCompany returns null (not thrown) on a genuine 404 'not found'", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    const company = await findCompany("unknown-domain.com", "test-key", { fetcher });
    expect(company).toBeNull();
  });

  it("throws ClearbitApiError on a real failure (e.g. 401)", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { type: "unauthorized", message: "bad key" } }, 401));
    await expect(findCompany("example.com", "bad-key", { fetcher })).rejects.toThrow(ClearbitApiError);
  });
});

describe("Clearbit Prospector", () => {
  it("searchProspector returns the real people Clearbit reported", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse([
        { name: { fullName: "Jane Doe" }, title: "VP Engineering", seniority: "vp", email: "jane@example.com", verified: true },
      ]),
    );
    const people = await searchProspector("example.com", "test-key", { fetcher });
    expect(people).toEqual([
      expect.objectContaining({ name: "Jane Doe", title: "VP Engineering", email: "jane@example.com", emailVerified: true }),
    ]);
  });

  it("returns an empty array (never thrown) when Clearbit genuinely finds nobody", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse([]));
    const people = await searchProspector("example.com", "test-key", { fetcher });
    expect(people).toEqual([]);
  });
});

describe("ClearbitProvider (DecisionMakerProvider adapter)", () => {
  it("maps verified Prospector results to sourceConfidence: 'verified', unverified to 'inferred'", async () => {
    const globalFetch = vi.fn().mockResolvedValue(
      jsonResponse([
        { name: { fullName: "Jane Doe" }, title: "CTO", email: "jane@example.com", verified: true, linkedin: "https://linkedin.com/in/jane" },
        { name: { fullName: "John Roe" }, title: "Director", email: "john@example.com", verified: false },
      ]),
    );
    vi.stubGlobal("fetch", globalFetch);
    try {
      const provider = new ClearbitProvider("test-key");
      const candidates = await provider.findDecisionMakers({ organizationName: "Example Inc", domain: "example.com" });
      expect(candidates).toEqual([
        expect.objectContaining({ name: "Jane Doe", title: "CTO", sourceConfidence: "verified", sourceUrl: "https://linkedin.com/in/jane" }),
        expect.objectContaining({ name: "John Roe", title: "Director", sourceConfidence: "inferred" }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns [] (never throws) when input.domain is null", async () => {
    const provider = new ClearbitProvider("test-key");
    const candidates = await provider.findDecisionMakers({ organizationName: "Example Inc", domain: null });
    expect(candidates).toEqual([]);
  });
});

describe("NotConfiguredClearbitProvider", () => {
  it("always throws, never returns a fabricated contact", async () => {
    const provider = new NotConfiguredClearbitProvider();
    await expect(provider.findDecisionMakers({ organizationName: "Example Inc", domain: "example.com" })).rejects.toThrow(
      ClearbitNotConfiguredError,
    );
  });
});

describe("resolveClearbitApiKey / buildClearbitProvider", () => {
  it("resolveClearbitApiKey returns null when neither a tenant credential nor CLEARBIT_API_KEY is configured", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const key = await resolveClearbitApiKey(db as never, "tenant-1", "project-1");
    expect(key).toBeNull();
  });

  it("buildClearbitProvider returns the NotConfigured stub when no credential resolves", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const provider = await buildClearbitProvider(db as never, "tenant-1", "project-1");
    expect(provider).toBeInstanceOf(NotConfiguredClearbitProvider);
  });
});
