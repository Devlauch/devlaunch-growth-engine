import { describe, it, expect } from "vitest";
import {
  NotConfiguredDecisionMakerProvider,
  NotConfiguredError,
  findDecisionMakers,
  buildDecisionMakerWaterfall,
  type DecisionMakerProvider,
  type DecisionMakerCandidate,
} from "../src/lib/decisionMakerProvider.js";

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
  it("today returns just the NotConfigured stub (no real provider is configured in this environment)", () => {
    const providers = buildDecisionMakerWaterfall();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("not_configured");
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
