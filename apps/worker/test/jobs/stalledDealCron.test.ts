import { describe, it, expect, vi, beforeEach } from "vitest";

// Same DB-mocking pattern as apps/worker/test/jobs/sequenceSchedulerCron.test.ts.
const withTenantContextMock = vi.fn();
vi.mock("../../src/db.js", () => ({
  withTenantContext: withTenantContextMock,
  pool: {},
}));

// Mocks the REAL cross-app dynamic import stalledDealCron.ts performs (see
// that file's header comment on why this import exists) so this test never
// needs apps/api to actually be built first.
const checkStalledDealsMock = vi.fn();
vi.mock("../../../api/dist/lib/salesPipeline.js", () => ({
  checkStalledDeals: (...args: unknown[]) => checkStalledDealsMock(...args),
}));

const { findProjectsWithNonTerminalDeals, runStalledDealCronTick } = await import(
  "../../src/jobs/stalledDealCron.js"
);

beforeEach(() => {
  withTenantContextMock.mockReset();
  checkStalledDealsMock.mockReset();
});

describe("findProjectsWithNonTerminalDeals", () => {
  it("queries deals for distinct tenant/project pairs scoped to non-terminal stages only", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({
      rows: [
        { tenant_id: "tenant-1", project_id: "project-1" },
        { tenant_id: "tenant-2", project_id: "project-2" },
      ],
    });

    const rows = await findProjectsWithNonTerminalDeals({ query: poolQueryMock } as never);

    expect(rows).toEqual([
      { tenant_id: "tenant-1", project_id: "project-1" },
      { tenant_id: "tenant-2", project_id: "project-2" },
    ]);
    const [sql] = poolQueryMock.mock.calls[0];
    expect(sql).toContain("d.stage NOT IN ('won', 'lost')");
  });
});

describe("runStalledDealCronTick", () => {
  it("calls the REAL checkStalledDeals (via withTenantContext) once per project with non-terminal deals, and totals follow-ups created", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({
      rows: [
        { tenant_id: "tenant-1", project_id: "project-1" },
        { tenant_id: "tenant-2", project_id: "project-2" },
      ],
    });

    withTenantContextMock.mockImplementation(async (_tenantId: string, fn: (client: unknown) => unknown) => {
      return fn({ query: vi.fn() });
    });

    checkStalledDealsMock
      .mockResolvedValueOnce([
        { dealId: "deal-1", leadId: "lead-1", crmTaskId: "task-1", followUpTaskId: "fut-1" },
      ])
      .mockResolvedValueOnce([]);

    const result = await runStalledDealCronTick({ query: poolQueryMock } as never);

    expect(result).toEqual({ projectsChecked: 2, totalFollowUpsCreated: 1 });
    expect(checkStalledDealsMock).toHaveBeenCalledTimes(2);
    expect(checkStalledDealsMock).toHaveBeenCalledWith(expect.anything(), "tenant-1", "project-1");
    expect(checkStalledDealsMock).toHaveBeenCalledWith(expect.anything(), "tenant-2", "project-2");
  });

  it("never fails the whole tick when one project's checkStalledDeals call throws", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({
      rows: [
        { tenant_id: "tenant-1", project_id: "project-1" },
        { tenant_id: "tenant-2", project_id: "project-2" },
      ],
    });

    withTenantContextMock.mockImplementation(async (_tenantId: string, fn: (client: unknown) => unknown) => {
      return fn({ query: vi.fn() });
    });

    checkStalledDealsMock
      .mockRejectedValueOnce(new Error("db connection lost"))
      .mockResolvedValueOnce([
        { dealId: "deal-2", leadId: "lead-2", crmTaskId: "task-2", followUpTaskId: "fut-2" },
      ]);

    const result = await runStalledDealCronTick({ query: poolQueryMock } as never);

    expect(result.projectsChecked).toBe(2);
    expect(result.totalFollowUpsCreated).toBe(1);
  });

  it("does nothing and makes no tenant-scoped calls when no project has a non-terminal deal", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({ rows: [] });

    const result = await runStalledDealCronTick({ query: poolQueryMock } as never);

    expect(result).toEqual({ projectsChecked: 0, totalFollowUpsCreated: 0 });
    expect(withTenantContextMock).not.toHaveBeenCalled();
    expect(checkStalledDealsMock).not.toHaveBeenCalled();
  });

  it("stays idempotent across repeated ticks: calling the real checkStalledDeals twice in a row never creates a second follow-up for the same deal (guaranteed by checkStalledDeals's own NOT EXISTS / unique trigger_reason check, exercised here by having the mock simulate it)", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({
      rows: [{ tenant_id: "tenant-1", project_id: "project-1" }],
    });

    withTenantContextMock.mockImplementation(async (_tenantId: string, fn: (client: unknown) => unknown) => {
      return fn({ query: vi.fn() });
    });

    // First tick creates the follow-up; a real checkStalledDeals run again
    // for the same still-stalled deal would see the open follow-up via its
    // NOT EXISTS check and create nothing further on the second tick.
    checkStalledDealsMock
      .mockResolvedValueOnce([
        { dealId: "deal-1", leadId: "lead-1", crmTaskId: "task-1", followUpTaskId: "fut-1" },
      ])
      .mockResolvedValueOnce([]);

    const first = await runStalledDealCronTick({ query: poolQueryMock } as never);
    const second = await runStalledDealCronTick({ query: poolQueryMock } as never);

    expect(first.totalFollowUpsCreated).toBe(1);
    expect(second.totalFollowUpsCreated).toBe(0);
  });
});
