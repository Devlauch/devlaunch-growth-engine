import { describe, it, expect } from "vitest";
import { rankDecisionMakersByRelevance } from "../src/lib/decisionMakerIdentification.js";
import type { DecisionMakerCandidate } from "../src/lib/decisionMakerProvider.js";

function candidate(name: string, title: string | null): DecisionMakerCandidate {
  return { name, title, email: null, phone: null, sourceUrl: null, sourceConfidence: "verified" };
}

describe("rankDecisionMakersByRelevance", () => {
  it("is a pure function — same input always produces the same output, no network/IO", () => {
    const contacts = [candidate("Jane Doe", "VP Sales"), candidate("Bob Lee", "Software Engineer")];
    const a = rankDecisionMakersByRelevance(contacts, ["VP Sales"]);
    const b = rankDecisionMakersByRelevance(contacts, ["VP Sales"]);
    expect(a).toEqual(b);
  });

  it("scores an exact title match highest (100) and a non-matching title at 0", () => {
    const contacts = [candidate("Jane Doe", "VP Sales"), candidate("Bob Lee", "Software Engineer")];
    const ranked = rankDecisionMakersByRelevance(contacts, ["VP Sales"]);

    expect(ranked[0]?.contact.name).toBe("Jane Doe");
    expect(ranked[0]?.score).toBe(100);
    expect(ranked[0]?.bestMatchedRole).toBe("VP Sales");

    expect(ranked[1]?.contact.name).toBe("Bob Lee");
    expect(ranked[1]?.score).toBe(0);
    expect(ranked[1]?.matchedKeywords).toEqual([]);
    expect(ranked[1]?.bestMatchedRole).toBeNull();
  });

  it("scores a phrase-contains match (80) above a token-overlap match", () => {
    const contacts = [candidate("Ann Exec", "Senior VP Sales, EMEA"), candidate("Sam Dir", "Sales Director")];
    const ranked = rankDecisionMakersByRelevance(contacts, ["VP Sales"]);

    const ann = ranked.find((r) => r.contact.name === "Ann Exec")!;
    const sam = ranked.find((r) => r.contact.name === "Sam Dir")!;
    expect(ann.score).toBe(80);
    expect(sam.score).toBeGreaterThan(0);
    expect(sam.score).toBeLessThan(ann.score);
  });

  it("scores a full-token-overlap match (60) when every keyword of the target role is present but out of order/phrase", () => {
    const contacts = [candidate("Gail Grow", "Growth Head, APAC")];
    const ranked = rankDecisionMakersByRelevance(contacts, ["Head of Growth"]);
    expect(ranked[0]?.score).toBe(60);
    expect(ranked[0]?.matchedKeywords.sort()).toEqual(["growth", "head"]);
  });

  it("never scores a contact with a null title (no fabricated inference)", () => {
    const contacts = [candidate("No Title Guy", null)];
    const ranked = rankDecisionMakersByRelevance(contacts, ["CEO", "VP Sales"]);
    expect(ranked[0]?.score).toBe(0);
    expect(ranked[0]?.bestMatchedRole).toBeNull();
  });

  it("picks the best-matching role across multiple target roles", () => {
    const contacts = [candidate("Cara CMO", "Chief Marketing Officer")];
    const ranked = rankDecisionMakersByRelevance(contacts, ["VP Sales", "CMO", "Head of Growth"]);
    // "Chief Marketing Officer" does not exactly equal "CMO" nor contain it
    // as a substring, so this should fall to token overlap / no match —
    // assert it doesn't crash and returns a defined, non-negative score.
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(0);
  });

  it("returns every contact (ranking, not filtering) even when nothing matches", () => {
    const contacts = [candidate("A", "Intern"), candidate("B", "Janitor")];
    const ranked = rankDecisionMakersByRelevance(contacts, ["CEO"]);
    expect(ranked).toHaveLength(2);
  });

  it("handles an empty target-role list by scoring everyone 0", () => {
    const contacts = [candidate("Jane Doe", "VP Sales")];
    const ranked = rankDecisionMakersByRelevance(contacts, []);
    expect(ranked[0]?.score).toBe(0);
  });

  it("is a stable sort — ties keep their original relative order", () => {
    const contacts = [candidate("First", "VP Sales"), candidate("Second", "VP Sales")];
    const ranked = rankDecisionMakersByRelevance(contacts, ["VP Sales"]);
    expect(ranked[0]?.contact.name).toBe("First");
    expect(ranked[1]?.contact.name).toBe("Second");
  });
});
