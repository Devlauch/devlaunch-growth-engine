import { describe, it, expect } from "vitest";
import { computeIntentScore } from "../src/lib/leadIntentScoring.js";
import type { Touchpoint } from "../src/lib/multiTouchEngagement.js";

const now = new Date("2026-11-23T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function tp(overrides: Partial<Touchpoint>): Touchpoint {
  return {
    type: "note",
    direction: "outbound",
    channel: "internal",
    timestamp: now.toISOString(),
    summary: "placeholder",
    detail: null,
    sourceId: "1",
    ...overrides,
  };
}

describe("computeIntentScore (pure)", () => {
  it("scores 0/cold with an honest explanation when there are no touchpoints and no site events", () => {
    const result = computeIntentScore([], [], now);
    expect(result.score).toBe(0);
    expect(result.tier).toBe("cold");
    expect(result.signals.some((s) => /No touchpoints or site events/.test(s))).toBe(true);
  });

  it("forces score 0/cold when an unsubscribe reply exists, regardless of other signals", () => {
    const touchpoints: Touchpoint[] = [
      tp({ type: "reply", direction: "inbound", channel: "email", timestamp: daysAgo(1), summary: 'Reply received via email — classified "unsubscribe" (high confidence)' }),
      tp({ type: "meeting", direction: "outbound", channel: "demo", timestamp: daysAgo(1) }),
    ];
    const result = computeIntentScore(touchpoints, [], now);
    expect(result.score).toBe(0);
    expect(result.tier).toBe("cold");
    expect(result.signals[0]).toMatch(/unsubscribe reply on record/);
  });

  it("never fabricates a site-visit signal when no site events were passed in", () => {
    const touchpoints: Touchpoint[] = [tp({ timestamp: daysAgo(2) })];
    const result = computeIntentScore(touchpoints, [], now);
    expect(result.signals.some((s) => /site-visit signal skipped, not fabricated/.test(s))).toBe(true);
  });

  it("scores a lead with a recent interested reply, a meeting, multi-channel activity, and a recent site visit as hot", () => {
    const touchpoints: Touchpoint[] = [
      tp({
        type: "reply",
        direction: "inbound",
        channel: "email",
        timestamp: daysAgo(1),
        summary: 'Reply received via email — classified "interested" (high confidence)',
      }),
      tp({ type: "meeting", direction: "outbound", channel: "demo", timestamp: daysAgo(2) }),
      tp({ type: "message_drafted", direction: "outbound", channel: "whatsapp", timestamp: daysAgo(3) }),
      tp({ type: "message_drafted", direction: "outbound", channel: "linkedin", timestamp: daysAgo(4) }),
    ];
    const result = computeIntentScore(touchpoints, [{ eventName: "pricing_page_viewed", occurredAt: daysAgo(1) }], now);
    expect(result.tier).toBe("hot");
    expect(result.signals.some((s) => /classified "interested"/.test(s))).toBe(true);
    expect(result.signals.some((s) => /meeting on record/.test(s))).toBe(true);
  });

  it("scores a lead with a single old, internal-only touch and nothing else as cold", () => {
    const touchpoints: Touchpoint[] = [tp({ type: "note", channel: "internal", timestamp: daysAgo(40) })];
    const result = computeIntentScore(touchpoints, [], now);
    expect(result.tier).toBe("cold");
  });

  it("gives a higher score to a lead with recent multi-channel engagement than one with a single old touch", () => {
    const engaged: Touchpoint[] = [
      tp({ type: "reply", direction: "inbound", channel: "email", timestamp: daysAgo(1), summary: 'Reply received via email — classified "interested"' }),
      tp({ type: "message_drafted", direction: "outbound", channel: "whatsapp", timestamp: daysAgo(2) }),
    ];
    const stale: Touchpoint[] = [tp({ timestamp: daysAgo(40) })];
    const engagedResult = computeIntentScore(engaged, [], now);
    const staleResult = computeIntentScore(stale, [], now);
    expect(engagedResult.score).toBeGreaterThan(staleResult.score);
  });

  it("clamps the score into [0, 100]", () => {
    const touchpoints: Touchpoint[] = [
      tp({ type: "reply", direction: "inbound", channel: "email", timestamp: daysAgo(0), summary: 'Reply received via email — classified "interested"' }),
      tp({ type: "meeting", direction: "outbound", channel: "demo", timestamp: daysAgo(0) }),
      tp({ type: "message_drafted", direction: "outbound", channel: "whatsapp", timestamp: daysAgo(0) }),
      tp({ type: "message_drafted", direction: "outbound", channel: "linkedin", timestamp: daysAgo(0) }),
      tp({ type: "message_drafted", direction: "outbound", channel: "phone", timestamp: daysAgo(0) }),
      ...Array.from({ length: 10 }, (_, i) => tp({ timestamp: daysAgo(0), sourceId: `extra-${i}` })),
    ];
    const result = computeIntentScore(touchpoints, [{ eventName: "x", occurredAt: daysAgo(0) }], now);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
