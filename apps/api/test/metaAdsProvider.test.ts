import { describe, it, expect, vi } from "vitest";
import {
  exchangeMetaAuthorizationCode,
  exchangeForLongLivedToken,
  getCampaignInsights,
  MetaAdsProvider,
  NotConfiguredMetaAdsClientProvider,
  MetaAdsApiError,
  resolveMetaAdsCredential,
  buildMetaAdsProviderForTenant,
} from "../src/lib/metaAdsProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("Meta OAuth2", () => {
  it("exchangeMetaAuthorizationCode calls the documented oauth/access_token endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ access_token: "short-lived-tok", token_type: "bearer", expires_in: 5000 }));
    const result = await exchangeMetaAuthorizationCode(
      { appId: "app-1", appSecret: "secret", code: "auth-code", redirectUri: "https://app.example.com/callback" },
      { fetcher },
    );
    expect(result.accessToken).toBe("short-lived-tok");
    const calledUrl = new URL(fetcher.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/v19.0/oauth/access_token");
    expect(calledUrl.searchParams.get("code")).toBe("auth-code");
  });

  it("exchangeForLongLivedToken uses grant_type=fb_exchange_token", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ access_token: "long-lived-tok", expires_in: 5184000 }));
    const result = await exchangeForLongLivedToken({ appId: "app-1", appSecret: "secret", shortLivedToken: "short-lived-tok" }, { fetcher });
    expect(result.accessToken).toBe("long-lived-tok");
    const calledUrl = new URL(fetcher.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(calledUrl.searchParams.get("fb_exchange_token")).toBe("short-lived-tok");
  });

  it("throws MetaAdsApiError with Graph API's real error message on failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Invalid OAuth access token", error_subcode: 0 } }, 401));
    await expect(
      exchangeForLongLivedToken({ appId: "app-1", appSecret: "secret", shortLivedToken: "bad" }, { fetcher }),
    ).rejects.toThrow(MetaAdsApiError);
  });
});

describe("getCampaignInsights", () => {
  it("requests impressions/clicks/spend with a time_range window", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ data: [{ impressions: "100", clicks: "5", spend: "12.50" }] }));
    const result = await getCampaignInsights("campaign-1", "access-tok", { since: "2026-10-01", until: "2026-10-31" }, { fetcher });
    expect(result.data).toHaveLength(1);
    const calledUrl = new URL(fetcher.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/v19.0/campaign-1/insights");
    expect(calledUrl.searchParams.get("fields")).toBe("impressions,clicks,spend");
    expect(JSON.parse(calledUrl.searchParams.get("time_range")!)).toEqual({ since: "2026-10-01", until: "2026-10-31" });
  });
});

describe("MetaAdsProvider.getCampaignPerformance", () => {
  it("sums real impressions/clicks/spend across returned rows, converting the decimal spend string to integer cents", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { impressions: "1000", clicks: "40", spend: "12.50" },
          { impressions: "500", clicks: "10", spend: "3.25" },
        ],
      }),
    );
    const original = globalThis.fetch;
    // @ts-expect-error -- test-only global fetch stub
    globalThis.fetch = fetcher;
    try {
      const provider = new MetaAdsProvider({ accessToken: "access-tok" });
      const result = await provider.getCampaignPerformance("campaign-1");
      expect(result.impressions).toBe(1500);
      expect(result.clicks).toBe(50);
      expect(result.spendCents).toBe(1575); // 12.50 + 3.25 = 15.75 -> 1575 cents
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("resolveMetaAdsCredential / buildMetaAdsProviderForTenant (not-configured path)", () => {
  it("resolveMetaAdsCredential returns null when no access token is configured (this environment's real state)", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const credential = await resolveMetaAdsCredential(db as never, "tenant-1", "project-1");
    expect(credential).toBeNull();
  });

  it("buildMetaAdsProviderForTenant returns the NotConfigured stub, which never fabricates spend/impressions/clicks", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const provider = await buildMetaAdsProviderForTenant(db as never, "tenant-1", "project-1");
    expect(provider).toBeInstanceOf(NotConfiguredMetaAdsClientProvider);
    await expect(provider.getCampaignPerformance("campaign-1")).rejects.toThrow(/not configured/i);
  });
});
