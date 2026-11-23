import { describe, it, expect, vi, afterEach } from "vitest";
import {
  NotConfiguredDecisionMakerProvider,
  NotConfiguredError,
  findDecisionMakers,
  buildDecisionMakerWaterfall,
  type DecisionMakerProvider,
  type DecisionMakerCandidate,
} from "../src/lib/decisionMakerProvider.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "22222222-2222-2222-2222-222222222222";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/lib/integrationCredentials.js");
  delete process.env.APOLLO_API_KEY;
});

describe("NotConfiguredDecisionMakerProvider", () => {
  it("always throws NotConfiguredError — never returns a fabricated contact", async () => {
    const provider = new NotConfiguredDecisionMakerProvider();
    await expect(provider.findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" })).rejects.toThrow(
      NotConfiguredError,
    );
  });

  it("names the provider it stands in for in its error message", async () => {
    const provider = new NotConfiguredDecisionMakerProvider();
    await expect(provider.findDecisionMakers({ organizationName: "Acme Inc", domain: null })).rejects.toThrow(
      /not configured/i,
    );
  });
});

describe("buildDecisionMakerWaterfall", () => {
  it("with no tenant context, returns just the NotConfigured stub (nothing to resolve a credential against)", async () => {
    const providers = await buildDecisionMakerWaterfall();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("not_configured");
  });

  it("with tenant context but no resolvable Apollo credential, still returns just the NotConfigured stub", async () => {
    vi.doMock("../src/lib/integrationCredentials.js", () => ({
      getIntegrationCredential: vi.fn(async () => null),
    }));
    const { buildDecisionMakerWaterfall: build } = await import("../src/lib/decisionMakerProvider.js");
    const providers = await build({ query: vi.fn() } as never, TENANT_1, PROJECT_1);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("not_configured");
  });

  it("prepends a real ApolloDecisionMakerProvider ahead of the stub when a tenant Apollo credential resolves", async () => {
    vi.doMock("../src/lib/integrationCredentials.js", () => ({
      getIntegrationCredential: vi.fn(async () => ({ config: {}, secret: "tenant-apollo-key", status: "connected" })),
    }));
    const { buildDecisionMakerWaterfall: build } = await import("../src/lib/decisionMakerProvider.js");
    const providers = await build({ query: vi.fn() } as never, TENANT_1, PROJECT_1);
    expect(providers).toHaveLength(2);
    expect(providers[0]?.name).toBe("apollo");
    expect(providers[1]?.name).toBe("not_configured");
  });
});

describe("findDecisionMakers", () => {
  it("with only the real (production) waterfall, classifies the outcome as 'not_configured', not 'no_result'", async () => {
    const outcome = await findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" });

    expect(outcome.status).toBe("not_configured");
    expect(outcome.provider).toBeNull();
    expect(outcome.contacts).toEqual([]);
  });

  it("reports 'found' with real candidates when a provider in the waterfall actually returns some", async () => {
    const candidate: DecisionMakerCandidate = {
      name: "Jane Doe",
      title: "Owner",
      email: "jane@acme.com",
      phone: null,
      sourceUrl: "https://example.com/jane",
      sourceConfidence: "verified",
    };
    const fakeRealProvider: DecisionMakerProvider = {
      name: "fake-real-provider",
      findDecisionMakers: async () => [candidate],
    };

    const outcome = await findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" }, [
      new NotConfiguredDecisionMakerProvider(),
      fakeRealProvider,
    ]);

    expect(outcome.status).toBe("found");
    expect(outcome.provider).toBe("fake-real-provider");
    expect(outcome.contacts).toEqual([candidate]);
    // Proves the waterfall really did try (and record) the first provider
    // before falling through, rather than skipping straight to the second.
    expect(outcome.attempts[0]).toMatchObject({ provider: "not_configured", status: "error" });
  });

  it("reports 'no_result' (not 'not_configured') when a real-but-empty provider genuinely finds nobody", async () => {
    const emptyRealProvider: DecisionMakerProvider = {
      name: "fake-real-provider",
      findDecisionMakers: async () => [],
    };

    const outcome = await findDecisionMakers({ organizationName: "Acme Inc", domain: "acme.com" }, [
      emptyRealProvider,
    ]);

    expect(outcome.status).toBe("no_result");
    expect(outcome.contacts).toEqual([]);
  });
});
