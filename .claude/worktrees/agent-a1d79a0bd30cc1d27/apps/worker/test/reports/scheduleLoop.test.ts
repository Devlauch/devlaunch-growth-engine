import { describe, it, expect, vi, beforeEach } from "vitest";

// withTenantContext is mocked so this test never touches a real Postgres
// connection — same idea as the DB-mocking pattern used in apps/api's
// route tests (e.g. campaigns.test.ts), applied to the worker side.
const withTenantContextMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  withTenantContext: withTenantContextMock,
  pool: {},
}));

const { isScheduleDue, periodForSchedule, checkAndEnqueueDueSchedules } = await import(
  "../../src/reports/scheduleLoop.js"
);

beforeEach(() => {
  withTenantContextMock.mockReset();
});

describe("isScheduleDue (pure due-date logic)", () => {
  it("is always due when it has never been generated", () => {
    expect(isScheduleDue("weekly", null, new Date("2026-11-22T00:00:00Z"))).toBe(true);
    expect(isScheduleDue("monthly", null, new Date("2026-11-22T00:00:00Z"))).toBe(true);
  });

  it("is NOT due for a weekly schedule generated less than 7 days ago", () => {
    const lastGeneratedAt = new Date("2026-11-20T00:00:00Z"); // 2 days before "now"
    const now = new Date("2026-11-22T00:00:00Z");
    expect(isScheduleDue("weekly", lastGeneratedAt, now)).toBe(false);
  });

  it("IS due for a weekly schedule generated exactly 7 days ago", () => {
    const lastGeneratedAt = new Date("2026-11-15T00:00:00Z");
    const now = new Date("2026-11-22T00:00:00Z");
    expect(isScheduleDue("weekly", lastGeneratedAt, now)).toBe(true);
  });

  it("is NOT due for a monthly schedule generated 10 days ago", () => {
    const lastGeneratedAt = new Date("2026-11-12T00:00:00Z");
    const now = new Date("2026-11-22T00:00:00Z");
    expect(isScheduleDue("monthly", lastGeneratedAt, now)).toBe(false);
  });

  it("IS due for a monthly schedule generated 31 days ago", () => {
    const lastGeneratedAt = new Date("2026-10-22T00:00:00Z");
    const now = new Date("2026-11-22T00:00:00Z");
    expect(isScheduleDue("monthly", lastGeneratedAt, now)).toBe(true);
  });
});

describe("periodForSchedule", () => {
  it("covers the full interval ending now when it has never run", () => {
    const now = new Date("2026-11-22T00:00:00Z");
    const { periodStart, periodEnd } = periodForSchedule("weekly", null, now);
    expect(periodEnd).toEqual(now);
    expect(periodStart).toEqual(new Date("2026-11-15T00:00:00Z"));
  });

  it("starts from last_generated_at when it has run before", () => {
    const lastGeneratedAt = new Date("2026-11-10T00:00:00Z");
    const now = new Date("2026-11-22T00:00:00Z");
    const { periodStart, periodEnd } = periodForSchedule("weekly", lastGeneratedAt, now);
    expect(periodStart).toEqual(lastGeneratedAt);
    expect(periodEnd).toEqual(now);
  });
});

describe("checkAndEnqueueDueSchedules", () => {
  it("enqueues only the due, enabled schedule and skips the not-yet-due one", async () => {
    const now = new Date("2026-11-22T00:00:00Z");
    const poolQueryMock = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "schedule-due",
          tenant_id: "tenant-1",
          project_id: "project-1",
          frequency: "weekly",
          last_generated_at: null,
          enabled: true,
        },
        {
          id: "schedule-not-due",
          tenant_id: "tenant-1",
          project_id: "project-1",
          frequency: "weekly",
          last_generated_at: "2026-11-20T00:00:00Z", // 2 days ago, not due
          enabled: true,
        },
      ],
    });

    withTenantContextMock.mockImplementation(async (_tenantId: string, fn: (client: unknown) => unknown) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: "generated-report-1" }] }) };
      return fn(client);
    });

    const enqueueMock = vi.fn().mockResolvedValue(undefined);

    const result = await checkAndEnqueueDueSchedules({ query: poolQueryMock } as never, enqueueMock, now);

    expect(result.checked).toBe(2);
    expect(result.enqueued).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: "generated-report-1",
        tenantId: "tenant-1",
        projectId: "project-1",
        scheduleId: "schedule-due",
      }),
    );
  });

  it("enqueues nothing when no schedule is enabled/due", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({ rows: [] });
    const enqueueMock = vi.fn();

    const result = await checkAndEnqueueDueSchedules({ query: poolQueryMock } as never, enqueueMock, new Date());

    expect(result.checked).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(withTenantContextMock).not.toHaveBeenCalled();
  });
});
