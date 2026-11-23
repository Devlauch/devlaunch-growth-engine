import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const tenantDb = { query: queryMock } as unknown as import("pg").PoolClient;

const { segmentVisitors } = await import("../src/lib/behavioralSegmentation.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  queryMock.mockReset();
});

describe("segmentVisitors", () => {
  it("intersects multiple rule results into one matched visitor set", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("FROM site_visitors") && sql.includes("count(*)")) {
        return Promise.resolve({ rows: [{ count: 10 }] });
      }
      if (sql.includes("site_events")) {
        return Promise.resolve({ rows: [{ visitor_id: "v1" }, { visitor_id: "v2" }, { visitor_id: "v3" }] });
      }
      if (sql.includes("site_pageviews")) {
        return Promise.resolve({ rows: [{ visitor_id: "v2" }, { visitor_id: "v3" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await segmentVisitors(tenantDb, TENANT_A, PROJECT_1, [
      { type: "event_count_at_least", eventName: "cta_click", minCount: 2 },
      { type: "page_visited", path: "/pricing" },
    ]);

    expect(result.totalVisitors).toBe(10);
    expect(result.matchedVisitors).toBe(2);
    expect(result.matchRate).toBe(0.2);
    expect(result.sampleVisitorIds.sort()).toEqual(["v2", "v3"]);
  });

  it("matches every visitor when no rules are given", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("count(*)")) return Promise.resolve({ rows: [{ count: 3 }] });
      return Promise.resolve({ rows: [{ visitor_id: "a" }, { visitor_id: "b" }, { visitor_id: "c" }] });
    });

    const result = await segmentVisitors(tenantDb, TENANT_A, PROJECT_1, []);
    expect(result.matchedVisitors).toBe(3);
    expect(result.matchRate).toBe(1);
  });

  it("reports matchRate 0 (never fabricated) when the project has zero visitors", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [{ count: 0 }] });

    const result = await segmentVisitors(tenantDb, TENANT_A, PROJECT_1, [
      { type: "utm_source", value: "google" },
    ]);
    expect(result.totalVisitors).toBe(0);
    expect(result.matchRate).toBe(0);
  });
});
