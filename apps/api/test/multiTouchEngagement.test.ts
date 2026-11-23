import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTouchpointHistory, getCorrelatedSiteEvents } from "../src/lib/multiTouchEngagement.js";

// Same "mock the tenantDb query function directly, no real Postgres"
// convention as dealHealth.ts's own computeDealHealthForDeal tests use for
// a lib-level (not route-level) function — see test/dealHealth.test.ts.
const queryMock = vi.fn();
const tenantDb = { query: queryMock };

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";

beforeEach(() => {
  queryMock.mockReset();
});

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

const empty = { rowCount: 0, rows: [] };

describe("getTouchpointHistory", () => {
  it("returns an empty list, never fabricating a touchpoint, when every source table is empty", async () => {
    queueResponses([
      empty, // activityTimeline: assignments
      empty, // deals
      empty, // meetings
      empty, // tasks
      empty, // notes
      empty, // replies
      empty, // audit_events
      empty, // sequence_enrollments
      empty, // message_drafts
      empty, // chatbot_conversations
      empty, // site_events (getCorrelatedSiteEvents)
    ]);

    const touchpoints = await getTouchpointHistory(tenantDb as any, TENANT_A, PROJECT_1, LEAD_1);
    expect(touchpoints).toEqual([]);
  });

  it("unions real sequence enrollment, message draft, chatbot, meeting, and reply rows into one sorted history", async () => {
    queueResponses([
      empty, // assignments
      empty, // deals
      {
        rowCount: 1,
        rows: [{ id: "m1", type: "demo", status: "completed", scheduled_at: "2026-11-10T00:00:00Z", outcome_notes: null, next_step: null }],
      }, // meetings
      empty, // tasks
      empty, // notes
      {
        rowCount: 1,
        rows: [{ id: "r1", channel: "email", classification: "interested", classification_confidence: "high", received_at: "2026-11-15T00:00:00Z" }],
      }, // replies
      empty, // audit_events
      {
        rowCount: 1,
        rows: [{ id: "e1", sequence_name: "Outbound v1", status: "active", enrolled_at: "2026-11-01T00:00:00Z", stopped_at: null }],
      }, // sequence_enrollments
      {
        rowCount: 1,
        rows: [{ id: "d1", status: "approved", created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-03T00:00:00Z", variant_channel: "whatsapp" }],
      }, // message_drafts
      {
        rowCount: 1,
        rows: [{ id: "c1", status: "captured", visitor_exchange_count: 4, started_at: "2026-11-12T00:00:00Z", last_message_at: "2026-11-12T01:00:00Z" }],
      }, // chatbot_conversations
      {
        rowCount: 1,
        rows: [{ id: "s1", event_name: "pricing_page_viewed", occurred_at: "2026-11-20T00:00:00Z" }],
      }, // site_events
    ]);

    const touchpoints = await getTouchpointHistory(tenantDb as any, TENANT_A, PROJECT_1, LEAD_1);

    // Newest first.
    expect(touchpoints[0].type).toBe("site_visit");
    expect(touchpoints[0].channel).toBe("site");

    const types = touchpoints.map((t) => t.type);
    expect(types).toContain("meeting");
    expect(types).toContain("reply");
    expect(types).toContain("sequence_enrolled");
    expect(types).toContain("message_drafted");
    expect(types).toContain("message_approved"); // status 'approved' produces a second touchpoint
    expect(types).toContain("chatbot_conversation");

    const draftedApproved = touchpoints.filter((t) => t.sourceId === "d1");
    expect(draftedApproved).toHaveLength(2);
    expect(draftedApproved.every((t) => t.channel === "whatsapp")).toBe(true);

    // Every item is sorted strictly descending by timestamp.
    for (let i = 1; i < touchpoints.length; i++) {
      expect(new Date(touchpoints[i - 1].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(touchpoints[i].timestamp).getTime(),
      );
    }
  });
});

describe("getCorrelatedSiteEvents", () => {
  it("returns an empty array (never fabricated) when the lead has no session_id correlation", async () => {
    queueResponses([empty]);
    const events = await getCorrelatedSiteEvents(tenantDb as any, TENANT_A, PROJECT_1, LEAD_1);
    expect(events).toEqual([]);
  });
});
