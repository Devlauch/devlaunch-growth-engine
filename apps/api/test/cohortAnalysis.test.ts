import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const tenantDb = { query: queryMock } as unknown as import("pg").PoolClient;

const { computeCohortRetention } = await import("../src/lib/cohortAnalysis.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  queryMock.mockReset();
});

describe("computeCohortRetention", () => {
  it("builds a real week-over-week retention table from grouped rows", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { cohort_week: "2026-01-05T00:00:00.000Z", week_offset: 0, active_visitors: 100 },
        { cohort_week: "2026-01-05T00:00:00.000Z", week_offset: 1, active_visitors: 40 },
        { cohort_week: "2026-01-05T00:00:00.000Z", week_offset: 2, active_visitors: 10 },
        { cohort_week: "2026-01-12T00:00:00.000Z", week_offset: 0, active_visitors: 50 },
        { cohort_week: "2026-01-12T00:00:00.000Z", week_offset: 1, active_visitors: 20 },
      ],
    });

    const table = await computeCohortRetention(tenantDb, TENANT_A, PROJECT_1, "first_visit_week", {
      sinceDays: 60,
      maxWeekOffset: 4,
    });

    expect(table.cohortBy).toBe("first_visit_week");
    expect(table.cohorts).toHaveLength(2);

    const firstCohort = table.cohorts[0];
    expect(firstCohort.cohortSize).toBe(100);
    expect(firstCohort.weeks).toHaveLength(5); // offsets 0..4
    expect(firstCohort.weeks[0]).toMatchObject({ weekOffset: 0, activeVisitors: 100, retentionRate: 1 });
    expect(firstCohort.weeks[1]).toMatchObject({ weekOffset: 1, activeVisitors: 40, retentionRate: 0.4 });
    expect(firstCohort.weeks[2]).toMatchObject({ weekOffset: 2, activeVisitors: 10, retentionRate: 0.1 });
    // Week offsets with no row in the result (never queried for this cohort) are real zeros, not omitted.
    expect(firstCohort.weeks[3]).toMatchObject({ weekOffset: 3, activeVisitors: 0, retentionRate: 0 });

    const secondCohort = table.cohorts[1];
    expect(secondCohort.cohortSize).toBe(50);
    expect(secondCohort.weeks[1].retentionRate).toBe(0.4);
  });

  it("never divides by zero when a cohort's size is somehow zero", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const table = await computeCohortRetention(tenantDb, TENANT_A, PROJECT_1, "first_visit_week", {});
    expect(table.cohorts).toEqual([]);
  });

  it("clamps sinceDays and maxWeekOffset to sane bounds", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const table = await computeCohortRetention(tenantDb, TENANT_A, PROJECT_1, "first_visit_week", {
      sinceDays: 99999,
      maxWeekOffset: 999,
    });

    expect(table.periodDays).toBe(3650);
    expect(table.maxWeekOffset).toBe(52);
  });
});
