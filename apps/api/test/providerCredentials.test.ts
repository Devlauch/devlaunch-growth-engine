import { describe, it, expect, vi, afterEach } from "vitest";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "22222222-2222-2222-2222-222222222222";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/lib/integrationCredentials.js");
  vi.doUnmock("../src/config/env.js");
  delete process.env.APOLLO_API_KEY;
  delete process.env.GOOGLE_SEARCH_API_KEY;
  delete process.env.GOOGLE_SEARCH_ENGINE_ID;
});

describe("resolveApolloApiKey", () => {
  it("prefers the tenant's own stored credential over the env fallback", async () => {
    vi.doMock("../src/lib/integrationCredentials.js", () => ({
      getIntegrationCredential: vi.fn(async () => ({ config: {}, secret: "tenant-apollo-key", status: "connected" })),
    }));
    process.env.APOLLO_API_KEY = "env-fallback-key";
    const { resolveApolloApiKey } = await import("../src/lib/providerCredentials.js");

    const key = await resolveApolloApiKey({ query: vi.fn() } as never, TENANT_1, PROJECT_1);
    expect(key).toBe("tenant-apollo-key");
  });

  it("falls back to env.apolloApiKey when no tenant credential exists", async () => {
    vi.doMock("../src/lib/integrationCredentials.js", () => ({
      getIntegrationCredential: vi.fn(async () => null),
    }));
    process.env.APOLLO_API_KEY = "env-fallback-key";
    const { resolveApolloApiKey } = await import("../src/lib/providerCredentials.js");

    const key = await resolveApolloApiKey({ query: vi.fn() } as never, TENANT_1, PROJECT_1);
    expect(key).toBe("env-fallback-key");
  });

  it("returns null (never throws, never guesses) when neither a tenant credential nor an env fallback exists", async () => {
    vi.doMock("../src/lib/integrationCredentials.js", () => ({
      getIntegrationCredential: vi.fn(async () => null),
    }));
    const { resolveApolloApiKey } = await import("../src/lib/providerCredentials.js");

    const key = await resolveApolloApiKey({ query: vi.fn() } as never, TENANT_1, PROJECT_1);
    expect(key).toBeNull();
  });
});

describe("resolveGoogleSearchCredential", () => {
  it("requires BOTH an api key and an engine id — returns null, never a half-populated object, when only one is resolvable", async () => {
    vi.doMock("../src/lib/integrationCredentials.js", () => ({
      getIntegrationCredential: vi.fn(async () => ({ config: {}, secret: "tenant-google-key", status: "connected" })),
    }));
    const { resolveGoogleSearchCredential } = await import("../src/lib/providerCredentials.js");

    const credential = await resolveGoogleSearchCredential({ query: vi.fn() } as never, TENANT_1, PROJECT_1);
    expect(credential).toBeNull();
  });

  it("resolves both fields from the tenant's own stored row (secret + config.engineId)", async () => {
    vi.doMock("../src/lib/integrationCredentials.js", () => ({
      getIntegrationCredential: vi.fn(async () => ({
        config: { engineId: "abc123:cx" },
        secret: "tenant-google-key",
        status: "connected",
      })),
    }));
    const { resolveGoogleSearchCredential } = await import("../src/lib/providerCredentials.js");

    const credential = await resolveGoogleSearchCredential({ query: vi.fn() } as never, TENANT_1, PROJECT_1);
    expect(credential).toEqual({ apiKey: "tenant-google-key", engineId: "abc123:cx" });
  });

  it("falls back to env.googleSearchApiKey/googleSearchEngineId when no tenant row exists", async () => {
    vi.doMock("../src/lib/integrationCredentials.js", () => ({
      getIntegrationCredential: vi.fn(async () => null),
    }));
    process.env.GOOGLE_SEARCH_API_KEY = "env-google-key";
    process.env.GOOGLE_SEARCH_ENGINE_ID = "env-engine-id";
    const { resolveGoogleSearchCredential } = await import("../src/lib/providerCredentials.js");

    const credential = await resolveGoogleSearchCredential({ query: vi.fn() } as never, TENANT_1, PROJECT_1);
    expect(credential).toEqual({ apiKey: "env-google-key", engineId: "env-engine-id" });
  });
});
