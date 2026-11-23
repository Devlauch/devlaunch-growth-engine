import { describe, it, expect } from "vitest";
import { classifyObjection } from "../src/lib/classifyObjection.js";

describe("classifyObjection", () => {
  it("returns 'none' for empty/missing text", () => {
    expect(classifyObjection("")).toEqual({ theme: "none", confidence: "low" });
    expect(classifyObjection(null)).toEqual({ theme: "none", confidence: "low" });
    expect(classifyObjection(undefined)).toEqual({ theme: "none", confidence: "low" });
  });

  it("classifies a no-budget objection", () => {
    const result = classifyObjection("We just don't have the budget for this right now.");
    expect(result.theme).toBe("no_budget");
    expect(result.confidence).toBe("high");
  });

  it("classifies a price objection", () => {
    const result = classifyObjection("Honestly it's too expensive for what we get.");
    expect(result.theme).toBe("price");
  });

  it("classifies a competitor objection", () => {
    const result = classifyObjection("We ended up going with a competitor instead.");
    expect(result.theme).toBe("competitor");
  });

  it("classifies a no-authority objection", () => {
    const result = classifyObjection("I'd need approval from leadership, not my decision.");
    expect(result.theme).toBe("no_authority");
  });

  it("classifies a timing objection", () => {
    const result = classifyObjection("Bad timing for us, maybe revisit this next quarter.");
    expect(result.theme).toBe("timing");
  });

  it("classifies a generic not-interested objection, but prefers a more specific theme when both are present", () => {
    expect(classifyObjection("Not interested, thanks.").theme).toBe("not_interested");
    // price is checked before not_interested in rule order, so a reply
    // mentioning both should land on the more specific, more useful theme.
    expect(classifyObjection("Not interested — it's too expensive for us.").theme).toBe("price");
  });

  it("falls back to 'none' when nothing matches", () => {
    const result = classifyObjection("Thanks for reaching out, I'll think about it.");
    expect(result.theme).toBe("none");
  });

  it("is deterministic (same input, same output)", () => {
    const text = "We can't afford it and already use a different vendor.";
    expect(classifyObjection(text)).toEqual(classifyObjection(text));
  });
});
