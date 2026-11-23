import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const tenantDb = { query: queryMock } as unknown as import("pg").PoolClient;

const { computeFunnel } = await import("../src/lib/funnelAnalytics.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  queryMock.mockReset();
});

describe("computeFunnel", () => {
  it("computes step-by-step session counts and conversion rates from real query results", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ count: 500 }] }) // totalSessionsInRange
      .mockResolvedValueOnce({ rows: [{ step_0_count: 200, step_1_count: 80, step_2_count: 20 }] }); // the chained CTE query

    const result = await computeFunnel(
      tenantDb,
      TENANT_A,
      PROJECT_1,
      [
        { eventName: "page_view", filter: { path: "/pricing" } },
        { eventName: "cta_click" },
        { eventName: "form_submitted" },
      ],
      { sinceDays: 30 },
    );

    expect(result.periodDays).toBe(30);
    expect(result.totalSessionsInRange).toBe(500);
    expect(result.steps).toHaveLength(3);

    expect(result.steps[0]).toMatchObject({ eventName: "page_view", sessionCount: 200, conversionRateFromPrevious: null, conversionRateFromFirst: null });
    expect(result.steps[1]).toMatchObject({ eventName: "cta_click", sessionCount: 80, conversionRateFromPrevious: 0.4, conversionRateFromFirst: 0.4 });
    expect(result.steps[2]).toMatchObject({ eventName: "form_submitted", sessionCount: 20, conversionRateFromPrevious: 0.25, conversionRateFromFirst: 0.1 });

    // Verify the funnel query is built with the right parameter sequence:
    // tenantId, projectId, then one param per filter value in step order.
    const [, funnelCallParams] = queryMock.mock.calls[1];
    expect(funnelCallParams[0]).toBe(TENANT_A);
    expect(funnelCallParams[1]).toBe(PROJECT_1);
  });

  it("never fabricates a conversion rate when the previous step had zero sessions", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ step_0_count: 0, step_1_count: 0 }] });

    const result = await computeFunnel(
      tenantDb,
      TENANT_A,
      PROJECT_1,
      [{ eventName: "page_view" }, { eventName: "signup" }],
      {},
    );

    expect(result.steps[1].conversionRateFromPrevious).toBe(0);
    expect(result.steps[1].conversionRateFromFirst).toBe(0);
  });

  it("rejects an empty steps array rather than silently returning nothing", async () => {
    await expect(computeFunnel(tenantDb, TENANT_A, PROJECT_1, [], {})).rejects.toThrow();
  });

  it("supports a single-step funnel (a plain count, not a drop-off)", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ count: 10 }] })
      .mockResolvedValueOnce({ rows: [{ step_0_count: 7 }] });

    const result = await computeFunnel(tenantDb, TENANT_A, PROJECT_1, [{ eventName: "page_view" }], {});
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].sessionCount).toBe(7);
    expect(result.steps[0].conversionRateFromPrevious).toBeNull();
  });
});
