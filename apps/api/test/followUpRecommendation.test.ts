import { describe, it, expect } from "vitest";
import { recommendFollowUp } from "../src/lib/followUpRecommendation.js";
import type { Touchpoint } from "../src/lib/multiTouchEngagement.js";
import type { IntentScoreResult } from "../src/lib/leadIntentScoring.js";

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

function intent(tier: IntentScoreResult["tier"], score: number): IntentScoreResult {
  return { score, tier, signals: ["test fixture"] };
}

describe("recommendFollowUp (pure)", () => {
  it("recommends no further contact when an unsubscribe reply exists, regardless of intent or stage", () => {
    const touchpoints: Touchpoint[] = [
      tp({ type: "reply", direction: "inbound", timestamp: daysAgo(1), summary: 'Reply received via email — classified "unsubscribe"' }),
    ];
    const result = recommendFollowUp(touchpoints, intent("hot", 90), "qualified", now);
    expect(result.action).toBe("none_unsubscribed");
  });

  it("recommends nothing further for a deal already in a terminal stage", () => {
    const result = recommendFollowUp([], intent("hot", 80), "won", now);
    expect(result.action).toBe("none_closed");
  });

  it("recommends a call now for a hot lead with no inbound response in 5+ days", () => {
    const touchpoints: Touchpoint[] = [
      tp({ type: "message_drafted", direction: "outbound", channel: "email", timestamp: daysAgo(6) }),
    ];
    const result = recommendFollowUp(touchpoints, intent("hot", 75), "proposal", now);
    expect(result.action).toBe("call_now");
  });

  it("does NOT recommend a call for a hot lead that just got a reply", () => {
    const touchpoints: Touchpoint[] = [
      tp({ type: "reply", direction: "inbound", channel: "email", timestamp: daysAgo(1), summary: 'Reply received via email — classified "interested"' }),
    ];
    const result = recommendFollowUp(touchpoints, intent("hot", 75), "proposal", now);
    expect(result.action).not.toBe("call_now");
  });

  it("recommends a re-engagement email for a cold lead with no touch in 14+ days", () => {
    const touchpoints: Touchpoint[] = [tp({ timestamp: daysAgo(20) })];
    const result = recommendFollowUp(touchpoints, intent("cold", 10), "contacted", now);
    expect(result.action).toBe("re_engagement_email");
  });

  it("recommends trying a different channel for a warm lead stalled on a single channel", () => {
    const touchpoints: Touchpoint[] = [
      tp({ type: "message_drafted", direction: "outbound", channel: "email", timestamp: daysAgo(10) }),
      tp({ type: "message_drafted", direction: "outbound", channel: "email", timestamp: daysAgo(15) }),
    ];
    const result = recommendFollowUp(touchpoints, intent("warm", 50), "contacted", now);
    expect(result.action).toBe("try_different_channel");
  });

  it("recommends a follow-up email for a warm lead already using multiple channels", () => {
    const touchpoints: Touchpoint[] = [
      tp({ type: "message_drafted", direction: "outbound", channel: "email", timestamp: daysAgo(10) }),
      tp({ type: "message_drafted", direction: "outbound", channel: "whatsapp", timestamp: daysAgo(15) }),
    ];
    const result = recommendFollowUp(touchpoints, intent("warm", 50), "contacted", now);
    expect(result.action).toBe("send_follow_up_email");
  });

  it("reuses salesPipeline.ts's own 7-day stall threshold for the escalate_stalled_deal rule", () => {
    // tier 'cold' with 10 days since the last touch: below the 14-day
    // cold re-engagement threshold (rule 2 does NOT fire), but at/above
    // salesPipeline.ts's 7-day STAGE_STALL_THRESHOLD_DAYS (rule 4 fires).
    const touchpoints: Touchpoint[] = [tp({ timestamp: daysAgo(10) })];
    const result = recommendFollowUp(touchpoints, intent("cold", 10), "proposal", now);
    expect(result.action).toBe("escalate_stalled_deal");
    expect(result.reason).toMatch(/7-day/);
  });

  it("recommends no action yet for a lead with fresh, on-track engagement", () => {
    const touchpoints: Touchpoint[] = [
      tp({ type: "message_drafted", direction: "outbound", channel: "email", timestamp: daysAgo(1) }),
    ];
    const result = recommendFollowUp(touchpoints, intent("warm", 50), "contacted", now);
    expect(result.action).toBe("no_action_needed");
  });
});
