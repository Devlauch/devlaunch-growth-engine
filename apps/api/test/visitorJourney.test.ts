import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const tenantDb = { query: queryMock } as unknown as import("pg").PoolClient;

const getLeadActivityTimelineMock = vi.fn();
vi.mock("../src/lib/activityTimeline.js", () => ({
  getLeadActivityTimeline: getLeadActivityTimelineMock,
}));

const { getVisitorJourney } = await import("../src/lib/visitorJourney.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const VISITOR_1 = "v_abc123";

beforeEach(() => {
  queryMock.mockReset();
  getLeadActivityTimelineMock.mockReset();
});

describe("getVisitorJourney", () => {
  it("merges sessions, pageviews, and events into one chronological timeline", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            session_id: "s1",
            started_at: "2026-01-01T10:00:00.000Z",
            referrer: "https://google.com/",
            landing_url: "https://site.example/",
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: null,
            is_bot: false,
          },
        ],
      }) // sessions
      .mockResolvedValueOnce({
        rows: [{ path: "/pricing", url: "https://site.example/pricing", viewed_at: "2026-01-01T10:01:00.000Z", session_id: "s1" }],
      }) // pageviews
      .mockResolvedValueOnce({
        rows: [
          {
            event_name: "cta_click",
            properties: { button: "signup" },
            occurred_at: "2026-01-01T10:02:00.000Z",
            session_id: "s1",
          },
        ],
      }) // events
      .mockResolvedValueOnce({ rows: [] }); // no matching lead

    const journey = await getVisitorJourney(tenantDb, TENANT_A, PROJECT_1, VISITOR_1);

    expect(journey).toHaveLength(3);
    expect(journey[0].type).toBe("session_start");
    expect(journey[1].type).toBe("pageview");
    expect(journey[1].summary).toBe("Viewed /pricing");
    expect(journey[2].type).toBe("event");
    expect(journey[2].summary).toBe("Event: cta_click");
    expect(getLeadActivityTimelineMock).not.toHaveBeenCalled();
  });

  it("merges in a correlated lead's CRM activity timeline when leads.visitor_id matches", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // sessions
      .mockResolvedValueOnce({ rows: [] }) // pageviews
      .mockResolvedValueOnce({ rows: [] }) // events
      .mockResolvedValueOnce({ rows: [{ id: "lead-1" }] }); // matching lead

    getLeadActivityTimelineMock.mockResolvedValueOnce([
      { type: "note", timestamp: "2026-01-02T00:00:00.000Z", summary: "Note added", detail: "Called them", sourceId: "note-1" },
    ]);

    const journey = await getVisitorJourney(tenantDb, TENANT_A, PROJECT_1, VISITOR_1);

    expect(getLeadActivityTimelineMock).toHaveBeenCalledWith(tenantDb, TENANT_A, PROJECT_1, "lead-1");
    expect(journey).toHaveLength(1);
    expect(journey[0].type).toBe("crm_activity");
    expect(journey[0].summary).toBe("[CRM] Note added");
  });

  it("returns an empty array for a visitor with no tracked activity at all", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const journey = await getVisitorJourney(tenantDb, TENANT_A, PROJECT_1, VISITOR_1);
    expect(journey).toEqual([]);
  });
});
