import { describe, it, expect } from "vitest";
import { runProviderWaterfall, type WaterfallProvider } from "../src/lib/providerWaterfall.js";

/**
 * Only one real connector (public_directory/Overpass) plus honest
 * NotConfigured* stubs exist in this codebase today, so there's no second
 * real provider to prove fallthrough with. These tests instead use 2+ plain
 * in-memory stub providers to prove the waterfall orchestration itself
 * (try in order, skip past a thrown error or an empty result, record who
 * actually answered) is real and correct, independent of any one
 * provider's implementation.
 */

function provider<T>(name: string, run: () => Promise<T>): WaterfallProvider<void, T> {
  return { name, run };
}

describe("runProviderWaterfall", () => {
  it("returns the first provider's result when it succeeds, without ever calling the second", async () => {
    let secondCalled = false;
    const providers = [
      provider("first", async () => ["a result"]),
      provider("second", async () => {
        secondCalled = true;
        return ["should never be reached"];
      }),
    ];

    const outcome = await runProviderWaterfall(providers, undefined);

    expect(outcome.answeredBy).toBe("first");
    expect(outcome.result).toEqual(["a result"]);
    expect(secondCalled).toBe(false);
    expect(outcome.attempts).toEqual([{ provider: "first", status: "success", durationMs: expect.any(Number) }]);
  });

  it("falls through to the next provider when the first throws", async () => {
    const providers = [
      provider("flaky", async (): Promise<string[]> => {
        throw new Error("boom");
      }),
      provider("backup", async () => ["backup result"]),
    ];

    const outcome = await runProviderWaterfall(providers, undefined);

    expect(outcome.answeredBy).toBe("backup");
    expect(outcome.result).toEqual(["backup result"]);
    expect(outcome.attempts).toEqual([
      { provider: "flaky", status: "error", error: "boom", durationMs: expect.any(Number) },
      { provider: "backup", status: "success", durationMs: expect.any(Number) },
    ]);
  });

  it("falls through to the next provider when the first returns an empty array (no result, not an error)", async () => {
    const providers = [
      provider("empty", async (): Promise<string[]> => []),
      provider("backup", async () => ["found it"]),
    ];

    const outcome = await runProviderWaterfall(providers, undefined);

    expect(outcome.answeredBy).toBe("backup");
    expect(outcome.attempts[0]).toMatchObject({ provider: "empty", status: "no_result" });
  });

  it("falls through past a second provider too (3+ providers), not just one hop", async () => {
    const providers = [
      provider("first", async (): Promise<string[]> => {
        throw new Error("first failed");
      }),
      provider("second", async (): Promise<string[]> => []),
      provider("third", async () => ["third answered"]),
    ];

    const outcome = await runProviderWaterfall(providers, undefined);

    expect(outcome.answeredBy).toBe("third");
    expect(outcome.attempts.map((a) => a.provider)).toEqual(["first", "second", "third"]);
  });

  it("returns null/null when every provider fails or finds nothing — never fabricates a result", async () => {
    const providers = [
      provider("flaky", async (): Promise<string[]> => {
        throw new Error("down");
      }),
      provider("empty", async (): Promise<string[]> => []),
    ];

    const outcome = await runProviderWaterfall(providers, undefined);

    expect(outcome.result).toBeNull();
    expect(outcome.answeredBy).toBeNull();
    expect(outcome.attempts).toHaveLength(2);
  });

  it("supports a scalar result type with a custom isEmpty predicate", async () => {
    const providers: WaterfallProvider<void, number | null>[] = [
      provider("returns-null", async () => null),
      provider("returns-zero", async () => 0),
    ];

    const outcome = await runProviderWaterfall(providers, undefined, {
      isEmpty: (r) => r === null,
    });

    // 0 is falsy but NOT "empty" under this custom predicate — proves the
    // default array/null-only emptiness check isn't hardcoded in.
    expect(outcome.answeredBy).toBe("returns-zero");
    expect(outcome.result).toBe(0);
  });

  it("returns an empty attempts/result outcome for an empty provider list", async () => {
    const outcome = await runProviderWaterfall([], undefined);
    expect(outcome.result).toBeNull();
    expect(outcome.answeredBy).toBeNull();
    expect(outcome.attempts).toEqual([]);
  });
});
