import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  NotConfiguredError,
  NotConfiguredPostizProvider,
  PostizSocialPostProvider,
  NotConfiguredGoogleAdsProvider,
  NotConfiguredMetaAdsProvider,
  NotConfiguredWhatsAppProvider,
  getPostizProvider,
  getSocialPostProvider,
  getGoogleAdsProvider,
  getMetaAdsProvider,
  getWhatsAppProvider,
  syncChannelProviderStatus,
} = await import("../src/lib/channelProviders.js");

const ENV_KEYS = [
  "POSTIZ_API_KEY",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "META_ADS_APP_ID",
  "META_ADS_APP_SECRET",
  "META_ADS_ACCESS_TOKEN",
  "WHATSAPP_BUSINESS_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCESS_TOKEN",
] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("Postiz (social post scheduling)", () => {
  it("getPostizProvider() returns the NotConfigured stub (no POSTIZ_API_KEY in this environment)", () => {
    expect(getPostizProvider()).toBeInstanceOf(NotConfiguredPostizProvider);
  });

  it("NotConfiguredPostizProvider.publish always throws, never returns a fabricated 'published' post", async () => {
    const provider = new NotConfiguredPostizProvider();
    await expect(provider.publish({ content: "hello", platforms: ["linkedin"] })).rejects.toThrow(NotConfiguredError);
  });

  it("getSocialPostProvider() returns the NotConfigured stub when no Postiz credential resolves for this tenant/project", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const provider = await getSocialPostProvider(db as never, "tenant-1", "project-1");
    expect(provider).toBeInstanceOf(NotConfiguredPostizProvider);
  });

  it("getSocialPostProvider() returns a real PostizSocialPostProvider once POSTIZ_BASE_URL/POSTIZ_API_KEY are set", async () => {
    process.env.POSTIZ_BASE_URL = "https://postiz.example.com";
    process.env.POSTIZ_API_KEY = "test-key";
    try {
      // env.ts (imported dynamically, deep inside getPostizClientForTenant)
      // caches its evaluated process.env reads at first import — force a
      // fresh module graph so this test's env vars are actually picked up,
      // same convention as credentialEncryption.test.ts's vi.resetModules().
      vi.resetModules();
      const fresh = await import("../src/lib/channelProviders.js");
      const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
      const provider = await fresh.getSocialPostProvider(db as never, "tenant-1", "project-1");
      expect(provider).toBeInstanceOf(fresh.PostizSocialPostProvider);
      expect(provider.name).toBe("postiz");
    } finally {
      delete process.env.POSTIZ_BASE_URL;
      delete process.env.POSTIZ_API_KEY;
      vi.resetModules();
    }
  });

  it("PostizSocialPostProvider.publish returns the real postId/publishedAt from a successful Postiz response, never fabricated", async () => {
    const fakeClient = {
      createPost: vi.fn().mockResolvedValue({ raw: {}, postId: "postiz-post-1", postGroup: "group-1" }),
    };
    const provider = new PostizSocialPostProvider(fakeClient as never);
    const result = await provider.publish({ content: "hello world", platforms: ["integration-1"] });
    expect(result).toEqual({
      provider: "postiz",
      postId: "postiz-post-1",
      publishedAt: expect.any(String),
      platforms: ["integration-1"],
    });
    expect(fakeClient.createPost).toHaveBeenCalledWith(
      expect.objectContaining({ type: "now", integrationIds: ["integration-1"], content: "hello world" }),
    );
  });

  it("PostizSocialPostProvider.publish schedules (type='schedule') when scheduledAt is set", async () => {
    const fakeClient = {
      createPost: vi.fn().mockResolvedValue({ raw: {}, postId: "postiz-post-2", postGroup: null }),
    };
    const provider = new PostizSocialPostProvider(fakeClient as never);
    await provider.publish({ content: "later", platforms: ["integration-1"], scheduledAt: "2030-01-01T00:00:00.000Z" });
    expect(fakeClient.createPost).toHaveBeenCalledWith(
      expect.objectContaining({ type: "schedule", date: "2030-01-01T00:00:00.000Z" }),
    );
  });

  it("PostizSocialPostProvider.publish throws rather than fabricating a postId when Postiz's response has none", async () => {
    const fakeClient = {
      createPost: vi.fn().mockResolvedValue({ raw: { unexpected: "shape" }, postId: null, postGroup: null }),
    };
    const provider = new PostizSocialPostProvider(fakeClient as never);
    await expect(provider.publish({ content: "x", platforms: ["integration-1"] })).rejects.toThrow(/fabricated/);
  });
});

describe("Google Ads", () => {
  it("getGoogleAdsProvider() returns the NotConfigured stub (no Google Ads OAuth credentials in this environment)", () => {
    expect(getGoogleAdsProvider()).toBeInstanceOf(NotConfiguredGoogleAdsProvider);
  });

  it("NotConfiguredGoogleAdsProvider.getCampaignPerformance always throws, never fabricates spend/impressions/clicks", async () => {
    const provider = new NotConfiguredGoogleAdsProvider();
    await expect(provider.getCampaignPerformance("campaign-123")).rejects.toThrow(NotConfiguredError);
  });
});

describe("Meta Ads", () => {
  it("getMetaAdsProvider() returns the NotConfigured stub (no Meta app credentials in this environment)", () => {
    expect(getMetaAdsProvider()).toBeInstanceOf(NotConfiguredMetaAdsProvider);
  });

  it("NotConfiguredMetaAdsProvider.getCampaignPerformance always throws, never fabricates spend/impressions/clicks", async () => {
    const provider = new NotConfiguredMetaAdsProvider();
    await expect(provider.getCampaignPerformance("campaign-456")).rejects.toThrow(NotConfiguredError);
  });
});

describe("WhatsApp Business", () => {
  it("getWhatsAppProvider() returns the NotConfigured stub (no WhatsApp Business Platform credentials in this environment)", () => {
    expect(getWhatsAppProvider()).toBeInstanceOf(NotConfiguredWhatsAppProvider);
  });

  it("NotConfiguredWhatsAppProvider.sendTemplateMessage always throws, never fabricates a delivery receipt", async () => {
    const provider = new NotConfiguredWhatsAppProvider();
    await expect(provider.sendTemplateMessage({ to: "+15551234567", templateName: "hello_world" })).rejects.toThrow(
      NotConfiguredError,
    );
  });
});

describe("syncChannelProviderStatus", () => {
  function fakeTenantDb() {
    return { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
  }

  it("upserts status='not_configured' when the channel's env vars are absent", async () => {
    const db = fakeTenantDb();
    const result = await syncChannelProviderStatus(db as never, "tenant-1", "postiz_social");

    expect(result).toEqual({ status: "not_configured" });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO channel_provider_configs"),
      ["tenant-1", "postiz_social", "not_configured"],
    );
  });

  it("upserts status='configured' when every required env var for that channel IS set", async () => {
    process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID = "123456";
    process.env.WHATSAPP_BUSINESS_ACCESS_TOKEN = "token";

    const db = fakeTenantDb();
    const result = await syncChannelProviderStatus(db as never, "tenant-1", "whatsapp_business");

    expect(result).toEqual({ status: "configured" });
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ["tenant-1", "whatsapp_business", "configured"]);
  });

  it("requires EVERY Google Ads env var, not just some, to report 'configured'", async () => {
    process.env.GOOGLE_ADS_CLIENT_ID = "id";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "secret";
    // GOOGLE_ADS_DEVELOPER_TOKEN / GOOGLE_ADS_REFRESH_TOKEN left unset

    const db = fakeTenantDb();
    const result = await syncChannelProviderStatus(db as never, "tenant-1", "google_ads");

    expect(result).toEqual({ status: "not_configured" });
  });
});
