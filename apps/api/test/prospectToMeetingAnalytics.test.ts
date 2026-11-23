import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeConversionFunnelStats } from "../src/lib/prospectToMeetingAnalytics.js";

const queryMock = vi.fn();
const tenantDb = { query: queryMock };

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const RANGE = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };

beforeEach(() => {
  queryMock.mockReset();
});

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

describe("computeConversionFunnelStats", () => {
  it("returns all-null conversion rates (never divide-by-zero or a fabricated 0%) when nothing happened in range", async () => {
    queueResponses([
      { rows: [{ count: 0 }] }, // prospectsContacted
      { rows: [{ count: 0 }] }, // repliesReceived
      { rows: [{ count: 0 }] }, // leadsWhoReplied
      { rows: [{ count: 0 }] }, // meetingsBooked
      { rows: [{ count: 0 }] }, // leadsWithMeetingBooked
      { rows: [{ count: 0 }] }, // meetingsCompleted
    ]);

    const stats = await computeConversionFunnelStats(tenantDb as any, TENANT_A, PROJECT_1, RANGE);

    expect(stats.prospectsContacted).toBe(0);
    expect(stats.conversionRates.contactToReply).toBeNull();
    expect(stats.conversionRates.replyToMeeting).toBeNull();
    expect(stats.conversionRates.contactToMeeting).toBeNull();
    expect(stats.conversionRates.meetingToCompleted).toBeNull();
  });

  it("computes real ratios from real counts", async () => {
    queueResponses([
      { rows: [{ count: 100 }] }, // prospectsContacted
      { rows: [{ count: 30 }] }, // repliesReceived (raw event count)
      { rows: [{ count: 25 }] }, // leadsWhoReplied (distinct)
      { rows: [{ count: 12 }] }, // meetingsBooked
      { rows: [{ count: 10 }] }, // leadsWithMeetingBooked (distinct)
      { rows: [{ count: 8 }] }, // meetingsCompleted
    ]);

    const stats = await computeConversionFunnelStats(tenantDb as any, TENANT_A, PROJECT_1, RANGE);

    expect(stats.prospectsContacted).toBe(100);
    expect(stats.repliesReceived).toBe(30);
    expect(stats.leadsWhoReplied).toBe(25);
    expect(stats.meetingsBooked).toBe(12);
    expect(stats.leadsWithMeetingBooked).toBe(10);
    expect(stats.meetingsCompleted).toBe(8);

    expect(stats.conversionRates.contactToReply).toBeCloseTo(25 / 100);
    expect(stats.conversionRates.replyToMeeting).toBeCloseTo(10 / 25);
    expect(stats.conversionRates.contactToMeeting).toBeCloseTo(10 / 100);
    expect(stats.conversionRates.meetingToCompleted).toBeCloseTo(8 / 12);
  });

  it("passes the exact tenant/project/date-range parameters to every query", async () => {
    queueResponses(Array.from({ length: 6 }, () => ({ rows: [{ count: 0 }] })));
    await computeConversionFunnelStats(tenantDb as any, TENANT_A, PROJECT_1, RANGE);

    for (const call of queryMock.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[0]).toBe(TENANT_A);
      expect(params[1]).toBe(PROJECT_1);
      expect(params[2]).toBe(RANGE.from);
      expect(params[3]).toBe(RANGE.to);
    }
    expect(queryMock).toHaveBeenCalledTimes(6);
  });
});
