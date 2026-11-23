import { describe, it, expect, vi } from "vitest";
import {
  computeEngagementScore,
  detectIntentSignals,
  getLifecycleStage,
  getUnifiedTimeline,
  type TimelineEvent,
} from "../src/lib/unifiedCustomerProfile.js";

function event(overrides: Partial<TimelineEvent> & Pick<TimelineEvent, "channel" | "type" | "timestamp">): TimelineEvent {
  return {
    summary: "summary",
    detail: null,
    sourceId: "src-1",
    metadata: {},
    ...overrides,
  };
}

const NOW = new Date("2026-11-23T00:00:00.000Z");
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("computeEngagementScore (pure)", () => {
  it("returns 0 with honest signals for an empty timeline", () => {
    const result = computeEngagementScore([], NOW);
    expect(result.score).toBe(0);
    expect(result.signals.some((s) => /0 distinct channel/.test(s))).toBe(true);
  });

  it("scores a lead with many fresh events across all 3 channels higher than one with a single old event", () => {
    const richTimeline: TimelineEvent[] = [
      event({ channel: "crm", type: "note", timestamp: daysAgo(0) }),
      event({ channel: "crm", type: "meeting", timestamp: daysAgo(1) }),
      event({ channel: "site", type: "pageview", timestamp: daysAgo(0) }),
      event({ channel: "site", type: "session_start", timestamp: daysAgo(0) }),
      event({ channel: "conversation", type: "chatbot_conversation", timestamp: daysAgo(0) }),
    ];
    const sparseTimeline: TimelineEvent[] = [event({ channel: "crm", type: "note", timestamp: daysAgo(400) })];

    const rich = computeEngagementScore(richTimeline, NOW);
    const sparse = computeEngagementScore(sparseTimeline, NOW);
    expect(rich.score).toBeGreaterThan(sparse.score);
  });

  it("never exceeds 100 regardless of how many events are packed in", () => {
    const hugeTimeline: TimelineEvent[] = Array.from({ length: 500 }, (_, i) =>
      event({ channel: "crm", type: "note", timestamp: daysAgo(0), sourceId: `n-${i}` }),
    );
    const result = computeEngagementScore(hugeTimeline, NOW);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("decays an event's contribution with age (older timeline scores lower, all else equal)", () => {
    const fresh = computeEngagementScore([event({ channel: "crm", type: "note", timestamp: daysAgo(0) })], NOW);
    const old = computeEngagementScore([event({ channel: "crm", type: "note", timestamp: daysAgo(60) })], NOW);
    expect(fresh.score).toBeGreaterThan(old.score);
  });

  it("rewards channel diversity: 3 events on 1 channel score lower than 1 event each on 3 channels", () => {
    const oneChannel = computeEngagementScore(
      [
        event({ channel: "crm", type: "note", timestamp: daysAgo(0), sourceId: "a" }),
        event({ channel: "crm", type: "note", timestamp: daysAgo(0), sourceId: "b" }),
      ],
      NOW,
    );
    const threeChannels = computeEngagementScore(
      [
        event({ channel: "crm", type: "note", timestamp: daysAgo(0) }),
        event({ channel: "site", type: "pageview", timestamp: daysAgo(0) }),
        event({ channel: "conversation", type: "chatbot_conversation", timestamp: daysAgo(0) }),
      ],
      NOW,
    );
    expect(threeChannels.score).toBeGreaterThan(oneChannel.score);
  });
});

describe("detectIntentSignals (pure)", () => {
  it("returns no signals for an empty timeline", () => {
    expect(detectIntentSignals([], NOW)).toEqual([]);
  });

  it("detects 3+ pricing-page visits within 7 days", () => {
    const timeline: TimelineEvent[] = [
      event({ channel: "site", type: "pageview", timestamp: daysAgo(1), metadata: { path: "/pricing" } }),
      event({ channel: "site", type: "pageview", timestamp: daysAgo(2), metadata: { path: "/pricing" } }),
      event({ channel: "site", type: "pageview", timestamp: daysAgo(3), metadata: { path: "/pricing" } }),
    ];
    const signals = detectIntentSignals(timeline, NOW);
    expect(signals.some((s) => /pricing-related page 3 time\(s\)/.test(s))).toBe(true);
  });

  it("does NOT fabricate a pricing signal when visits are outside the 7-day window", () => {
    const timeline: TimelineEvent[] = [
      event({ channel: "site", type: "pageview", timestamp: daysAgo(30), metadata: { path: "/pricing" } }),
      event({ channel: "site", type: "pageview", timestamp: daysAgo(31), metadata: { path: "/pricing" } }),
      event({ channel: "site", type: "pageview", timestamp: daysAgo(32), metadata: { path: "/pricing" } }),
    ];
    expect(detectIntentSignals(timeline, NOW)).toEqual([]);
  });

  it("does NOT fabricate a pricing signal below the 3-visit threshold", () => {
    const timeline: TimelineEvent[] = [
      event({ channel: "site", type: "pageview", timestamp: daysAgo(1), metadata: { path: "/pricing" } }),
      event({ channel: "site", type: "pageview", timestamp: daysAgo(2), metadata: { path: "/pricing" } }),
    ];
    expect(detectIntentSignals(timeline, NOW)).toEqual([]);
  });

  it("detects a returning visitor (3+ distinct sessions in 7 days)", () => {
    const timeline: TimelineEvent[] = [
      event({ channel: "site", type: "session_start", timestamp: daysAgo(1), sourceId: "s1" }),
      event({ channel: "site", type: "session_start", timestamp: daysAgo(2), sourceId: "s2" }),
      event({ channel: "site", type: "session_start", timestamp: daysAgo(3), sourceId: "s3" }),
    ];
    const signals = detectIntentSignals(timeline, NOW);
    expect(signals.some((s) => /Returning visitor: 3 distinct sessions/.test(s))).toBe(true);
  });

  it("detects a positive ('interested') most-recent reply, sorted newest-first", () => {
    const timeline: TimelineEvent[] = [
      event({ channel: "crm", type: "reply", timestamp: daysAgo(0), metadata: { classification: "interested" } }),
      event({ channel: "crm", type: "reply", timestamp: daysAgo(10), metadata: { classification: "unsubscribe" } }),
    ];
    const signals = detectIntentSignals(timeline, NOW);
    expect(signals.some((s) => /classified "interested"/.test(s))).toBe(true);
  });

  it("does not report a positive-reply signal when the MOST RECENT reply is negative, even if an older one was positive", () => {
    const timeline: TimelineEvent[] = [
      event({ channel: "crm", type: "reply", timestamp: daysAgo(0), metadata: { classification: "not_now" } }),
      event({ channel: "crm", type: "reply", timestamp: daysAgo(10), metadata: { classification: "interested" } }),
    ];
    const signals = detectIntentSignals(timeline, NOW);
    expect(signals.some((s) => /classified "interested"/.test(s))).toBe(false);
  });

  it("detects an upcoming scheduled meeting", () => {
    const timeline: TimelineEvent[] = [
      event({
        channel: "crm",
        type: "meeting",
        timestamp: daysAgo(-2), // in the future relative to NOW
        metadata: { meetingStatus: "scheduled", scheduledAt: daysAgo(-2) },
      }),
    ];
    const signals = detectIntentSignals(timeline, NOW);
    expect(signals.some((s) => /upcoming meeting scheduled/.test(s))).toBe(true);
  });

  it("does not flag a completed (past) meeting as upcoming", () => {
    const timeline: TimelineEvent[] = [
      event({
        channel: "crm",
        type: "meeting",
        timestamp: daysAgo(5),
        metadata: { meetingStatus: "completed", scheduledAt: daysAgo(5) },
      }),
    ];
    expect(detectIntentSignals(timeline, NOW)).toEqual([]);
  });

  it("detects an in-progress chatbot conversation", () => {
    const timeline: TimelineEvent[] = [
      event({ channel: "conversation", type: "chatbot_conversation", timestamp: daysAgo(0), metadata: { status: "qualifying" } }),
    ];
    const signals = detectIntentSignals(timeline, NOW);
    expect(signals.some((s) => /in-progress chatbot conversation/.test(s))).toBe(true);
  });

  it("does not flag an ended chatbot conversation as in-progress", () => {
    const timeline: TimelineEvent[] = [
      event({ channel: "conversation", type: "chatbot_conversation", timestamp: daysAgo(0), metadata: { status: "ended" } }),
    ];
    expect(detectIntentSignals(timeline, NOW)).toEqual([]);
  });
});

describe("getLifecycleStage (pure)", () => {
  it("returns 'visitor' when there is no lead row at all", () => {
    expect(getLifecycleStage(null, [])).toBe("visitor");
  });

  it("returns 'lead' for a brand-new lead with no deals", () => {
    expect(getLifecycleStage({ status: "new" }, [])).toBe("lead");
  });

  it("returns 'lead' for a rejected/archived lead (not mql/sql — honestly still just 'lead')", () => {
    expect(getLifecycleStage({ status: "rejected" }, [])).toBe("lead");
    expect(getLifecycleStage({ status: "archived" }, [])).toBe("lead");
  });

  it("returns 'mql' for a qualified lead with no deals", () => {
    expect(getLifecycleStage({ status: "qualified" }, [])).toBe("mql");
  });

  it("returns 'sql' for a lead approved for outreach with no deals", () => {
    expect(getLifecycleStage({ status: "approved_for_outreach" }, [])).toBe("sql");
  });

  it("returns 'opportunity' once any deal exists, regardless of lead.status", () => {
    expect(getLifecycleStage({ status: "new" }, [{ stage: "contacted" }])).toBe("opportunity");
    expect(getLifecycleStage({ status: "qualified" }, [{ stage: "proposal" }])).toBe("opportunity");
  });

  it("returns 'customer' when any deal has reached 'won', even if other deals are still open", () => {
    expect(getLifecycleStage({ status: "approved_for_outreach" }, [{ stage: "contacted" }, { stage: "won" }])).toBe(
      "customer",
    );
  });

  it("'won' takes priority over a 'lost' deal existing alongside it", () => {
    expect(getLifecycleStage({ status: "new" }, [{ stage: "lost" }, { stage: "won" }])).toBe("customer");
  });
});

describe("getUnifiedTimeline (mocked pg client)", () => {
  // Same mocking convention as test/leadActivity.test.ts / dealHealth.test.ts:
  // a bare { query } object standing in for the tenant-scoped PoolClient,
  // no real Postgres involved.
  function makeTenantDb(responses: unknown[]) {
    const queryMock = vi.fn();
    for (const r of responses) queryMock.mockResolvedValueOnce(r);
    return { query: queryMock };
  }

  const TENANT_ID = "11111111-1111-1111-1111-111111111111";
  const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
  const LEAD_ID = "55555555-5555-5555-5555-555555555555";

  it("merges CRM, site, and conversation events into one newest-first timeline", async () => {
    const tenantDb = makeTenantDb([
      // getLeadActivityTimeline's own lead-row read is a single `await`
      // BEFORE its inner Promise.all, so — since buildCrmEvents calls
      // getLeadActivityTimeline(...) as one of ITS OWN Promise.all
      // elements, alongside its own meetingMeta/replyMeta queries — the
      // real call order is: leadRow fires first (synchronously, as
      // getLeadActivityTimeline starts), THEN buildCrmEvents' own
      // meetingMeta/replyMeta queries fire (the next array elements,
      // evaluated synchronously by the outer Promise.all), and only THEN,
      // on the next microtask tick, does getLeadActivityTimeline's own
      // inner Promise.all (assignments..scores) actually run.
      { rowCount: 0, rows: [] }, // lead row (not found here — defense in depth, never throws)
      { rowCount: 0, rows: [] }, // meetingMeta
      { rowCount: 1, rows: [{ id: "reply-1", classification: "interested" }] }, // replyMeta
      { rowCount: 0, rows: [] }, // assignments
      {
        rowCount: 1,
        rows: [
          {
            id: "deal-1",
            stage: "proposal",
            value_amount: null,
            stage_changed_at: "2026-11-20T00:00:00Z",
            created_at: "2026-11-18T00:00:00Z",
          },
        ],
      }, // deals
      { rowCount: 0, rows: [] }, // meetings
      { rowCount: 0, rows: [] }, // tasks
      { rowCount: 0, rows: [] }, // notes
      {
        rowCount: 1,
        rows: [
          {
            id: "reply-1",
            channel: "email",
            classification: "interested",
            classification_confidence: "high",
            received_at: "2026-11-21T00:00:00Z",
          },
        ],
      }, // replies
      { rowCount: 0, rows: [] }, // auditEvents
      { rowCount: 0, rows: [] }, // scores
      // --- buildSiteEvents ---
      { rowCount: 1, rows: [{ visitor_id: "visitor-abc" }] }, // leads.visitor_id lookup
      {
        rowCount: 1,
        rows: [{ session_id: "sess-1", started_at: "2026-11-22T00:00:00Z", referrer: "google", landing_url: "/home" }],
      }, // sessions
      {
        rowCount: 1,
        rows: [{ session_id: "sess-1", path: "/pricing", url: "https://x/pricing", viewed_at: "2026-11-22T01:00:00Z" }],
      }, // pageviews
      { rowCount: 0, rows: [] }, // site_events
      // --- buildConversationEvents ---
      {
        rowCount: 1,
        rows: [
          {
            id: "conv-1",
            status: "ended",
            visitor_exchange_count: 4,
            started_at: "2026-11-19T00:00:00Z",
            last_message_at: "2026-11-19T01:00:00Z",
          },
        ],
      }, // chatbot_conversations
      { rowCount: 0, rows: [] }, // chatwoot_contact_leads mapping (none)
    ]);

    const timeline = await getUnifiedTimeline(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);

    // 1 deal stage_change + 1 deal_created (both ported from Phase 2's
    // activityTimeline.ts additions — a deal now contributes two distinct
    // items, see that file's header comment) + 1 reply + 1 session +
    // 1 pageview + 1 chatbot conversation
    expect(timeline.length).toBe(6);
    expect(timeline.map((e) => e.channel).sort()).toEqual(
      ["conversation", "crm", "crm", "crm", "site", "site"].sort(),
    );

    // Newest-first
    const timestamps = timeline.map((e) => new Date(e.timestamp).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));

    // Reply metadata was correctly merged onto the matching CRM event
    const replyEvent = timeline.find((e) => e.type === "reply");
    expect(replyEvent?.metadata.classification).toBe("interested");

    // Pageview path metadata is present for intent-signal detection
    const pageviewEvent = timeline.find((e) => e.type === "pageview");
    expect(pageviewEvent?.metadata.path).toBe("/pricing");
  });

  it("skips the site-analytics queries entirely when the lead has no correlated visitor_id", async () => {
    const tenantDb = makeTenantDb([
      { rowCount: 0, rows: [] }, // lead row (not found here — defense in depth, never throws)
      { rowCount: 0, rows: [] }, // assignments
      { rowCount: 0, rows: [] }, // deals
      { rowCount: 0, rows: [] }, // meetings
      { rowCount: 0, rows: [] }, // tasks
      { rowCount: 0, rows: [] }, // notes
      { rowCount: 0, rows: [] }, // replies
      { rowCount: 0, rows: [] }, // auditEvents
      { rowCount: 0, rows: [] }, // scores
      { rowCount: 0, rows: [] }, // meetingMeta
      { rowCount: 0, rows: [] }, // replyMeta
      { rowCount: 1, rows: [{ visitor_id: null }] }, // leads.visitor_id lookup -> null
      { rowCount: 0, rows: [] }, // chatbot_conversations
      { rowCount: 0, rows: [] }, // chatwoot_contact_leads mapping
    ]);

    const timeline = await getUnifiedTimeline(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(timeline).toEqual([]);
    // Only 14 queries ran (no site_sessions/pageviews/events queries attempted).
    expect(tenantDb.query).toHaveBeenCalledTimes(14);
  });
});
