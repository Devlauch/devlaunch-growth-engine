import { describe, it, expect, vi } from "vitest";
import {
  refreshGoogleAdsAccessToken,
  exchangeGoogleAdsAuthorizationCode,
  runGoogleAdsQuery,
  GoogleAdsProvider,
  NotConfiguredGoogleAdsClientProvider,
  GoogleAdsApiError,
  resolveGoogleAdsCredential,
  buildGoogleAdsProviderForTenant,
  type GoogleAdsTenantCredential,
} from "../src/lib/googleAdsProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("Google Ads OAuth2", () => {
  it("refreshGoogleAdsAccessToken posts a refresh_token grant to the documented endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ access_token: "tok-1", expires_in: 3600, token_type: "Bearer" }));
    const result = await refreshGoogleAdsAccessToken(
      { clientId: "cid", clientSecret: "csecret", refreshToken: "rtok" },
      { fetcher },
    );
    expect(result).toEqual({ accessToken: "tok-1", expiresInSeconds: 3600, scope: null, tokenType: "Bearer" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("grant_type=refresh_token"),
      }),
    );
  });

  it("exchangeGoogleAdsAuthorizationCode posts an authorization_code grant and returns the refresh_token", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ access_token: "tok-1", refresh_token: "new-rtok", expires_in: 3600 }));
    const result = await exchangeGoogleAdsAuthorizationCode(
      { clientId: "cid", clientSecret: "csecret", code: "auth-code", redirectUri: "https://app.example.com/callback" },
      { fetcher },
    );
    expect(result.refreshToken).toBe("new-rtok");
    expect(fetcher.mock.calls[0][1].body).toContain("grant_type=authorization_code");
  });

  it("throws GoogleAdsApiError when the token endpoint reports an error", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant", error_description: "Token expired" }, 400));
    await expect(
      refreshGoogleAdsAccessToken({ clientId: "cid", clientSecret: "csecret", refreshToken: "bad" }, { fetcher }),
    ).rejects.toThrow(GoogleAdsApiError);
  });
});

const CREDENTIAL: GoogleAdsTenantCredential = {
  clientId: "cid",
  clientSecret: "csecret",
  developerToken: "dev-token",
  refreshToken: "rtok",
  customerId: "1234567890",
  loginCustomerId: null,
};

describe("runGoogleAdsQuery", () => {
  it("POSTs the GAQL query with developer-token and Authorization headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    await runGoogleAdsQuery(CREDENTIAL, "access-tok", "SELECT campaign.id FROM campaign", { fetcher });
    expect(fetcher).toHaveBeenCalledWith(
      "https://googleads.googleapis.com/v17/customers/1234567890/googleAds:search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer access-tok", "developer-token": "dev-token" }),
      }),
    );
  });

  it("throws GoogleAdsApiError with the real Google error message on failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Invalid customer ID" } }, 400));
    await expect(runGoogleAdsQuery(CREDENTIAL, "access-tok", "BAD QUERY", { fetcher })).rejects.toThrow(/Invalid customer ID/);
  });
});

describe("GoogleAdsProvider.getCampaignPerformance", () => {
  it("sums real impressions/clicks/cost_micros across returned rows, converting cost_micros to cents", async () => {
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(jsonResponse({ access_token: "access-tok", expires_in: 3600 }));
      }
      return Promise.resolve(
        jsonResponse({
          results: [
            { campaign: { id: "111" }, metrics: { impressions: "1000", clicks: "50", costMicros: "20000000" } },
            { campaign: { id: "111" }, metrics: { impressions: "500", clicks: "10", costMicros: "5000000" } },
          ],
        }),
      );
    });
    const provider = new GoogleAdsProvider({ ...CREDENTIAL });
    // Inject the fetcher via the module-level default by monkeypatching global fetch,
    // since GoogleAdsProvider itself doesn't expose a fetcher param (it composes
    // refreshGoogleAdsAccessToken + runGoogleAdsQuery, both of which default to global fetch).
    const original = globalThis.fetch;
    // @ts-expect-error -- test-only global fetch stub
    globalThis.fetch = fetcher;
    try {
      const result = await provider.getCampaignPerformance("111");
      expect(result.impressions).toBe(1500);
      expect(result.clicks).toBe(60);
      expect(result.spendCents).toBe(2500); // (20,000,000 + 5,000,000) micros / 10,000 = 2500 cents
      expect(result.campaignExternalId).toBe("111");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("resolveGoogleAdsCredential / buildGoogleAdsProviderForTenant (not-configured path)", () => {
  it("resolveGoogleAdsCredential returns null when the platform-level env vars are absent (this environment's real state)", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const credential = await resolveGoogleAdsCredential(db as never, "tenant-1", "project-1");
    expect(credential).toBeNull();
  });

  it("buildGoogleAdsProviderForTenant returns the NotConfigured stub, which never fabricates spend/impressions/clicks", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const provider = await buildGoogleAdsProviderForTenant(db as never, "tenant-1", "project-1");
    expect(provider).toBeInstanceOf(NotConfiguredGoogleAdsClientProvider);
    await expect(provider.getCampaignPerformance("111")).rejects.toThrow(/not configured/i);
  });
});
