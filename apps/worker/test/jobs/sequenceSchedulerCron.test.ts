import { describe, it, expect, vi, beforeEach } from "vitest";

// Same DB-mocking pattern as apps/worker/test/reports/scheduleLoop.test.ts.
const withTenantContextMock = vi.fn();
vi.mock("../../src/db.js", () => ({
  withTenantContext: withTenantContextMock,
  pool: {},
}));

// Mocks the REAL cross-app dynamic import sequenceSchedulerCron.ts performs
// (see that file's header comment on why this import exists) so this test
// never needs apps/api to actually be built first.
const advanceDueEnrollmentsMock = vi.fn();
vi.mock("../../../api/dist/lib/advanceSequences.js", () => ({
  advanceDueEnrollments: (...args: unknown[]) => advanceDueEnrollmentsMock(...args),
}));

const { findProjectsWithActiveSequences, runSequenceSchedulerTick } = await import(
  "../../src/jobs/sequenceSchedulerCron.js"
);

beforeEach(() => {
  withTenantContextMock.mockReset();
  advanceDueEnrollmentsMock.mockReset();
});

describe("findProjectsWithActiveSequences", () => {
  it("queries sequences joined to an EXISTS check for an active enrollment, scoped to is_active sequences only", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({
      rows: [
        { tenant_id: "tenant-1", project_id: "project-1" },
        { tenant_id: "tenant-2", project_id: "project-2" },
      ],
    });

    const rows = await findProjectsWithActiveSequences({ query: poolQueryMock } as never);

    expect(rows).toEqual([
      { tenant_id: "tenant-1", project_id: "project-1" },
      { tenant_id: "tenant-2", project_id: "project-2" },
    ]);
    const [sql] = poolQueryMock.mock.calls[0];
    expect(sql).toContain("s.is_active = true");
    expect(sql).toContain("se.status = 'active'");
  });
});

describe("runSequenceSchedulerTick", () => {
  it("calls the REAL advanceDueEnrollments (via withTenantContext) once per due project, and totals its results", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({
      rows: [
        { tenant_id: "tenant-1", project_id: "project-1" },
        { tenant_id: "tenant-2", project_id: "project-2" },
      ],
    });

    withTenantContextMock.mockImplementation(async (_tenantId: string, fn: (client: unknown) => unknown) => {
      return fn({ query: vi.fn() });
    });

    advanceDueEnrollmentsMock
      .mockResolvedValueOnce({ advanced: 3, tasksCreated: 1, skipped: [], stoppedForReply: 1, emailsSent: 2 })
      .mockResolvedValueOnce({ advanced: 0, tasksCreated: 0, skipped: [], stoppedForReply: 0, emailsSent: 0 });

    const result = await runSequenceSchedulerTick({ query: poolQueryMock } as never);

    expect(result).toEqual({
      projectsChecked: 2,
      totalAdvanced: 3,
      totalEmailsSent: 2,
      totalStoppedForReply: 1,
    });
    expect(advanceDueEnrollmentsMock).toHaveBeenCalledTimes(2);
    expect(advanceDueEnrollmentsMock).toHaveBeenCalledWith(expect.anything(), "tenant-1", "project-1");
    expect(advanceDueEnrollmentsMock).toHaveBeenCalledWith(expect.anything(), "tenant-2", "project-2");
  });

  it("never fails the whole tick when one project's advanceDueEnrollments call throws", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({
      rows: [
        { tenant_id: "tenant-1", project_id: "project-1" },
        { tenant_id: "tenant-2", project_id: "project-2" },
      ],
    });

    withTenantContextMock.mockImplementation(async (_tenantId: string, fn: (client: unknown) => unknown) => {
      return fn({ query: vi.fn() });
    });

    advanceDueEnrollmentsMock
      .mockRejectedValueOnce(new Error("db connection lost"))
      .mockResolvedValueOnce({ advanced: 5, tasksCreated: 0, skipped: [], stoppedForReply: 0, emailsSent: 1 });

    const result = await runSequenceSchedulerTick({ query: poolQueryMock } as never);

    expect(result.projectsChecked).toBe(2);
    expect(result.totalAdvanced).toBe(5);
    expect(result.totalEmailsSent).toBe(1);
  });

  it("does nothing and makes no tenant-scoped calls when no project has active sequence work", async () => {
    const poolQueryMock = vi.fn().mockResolvedValue({ rows: [] });

    const result = await runSequenceSchedulerTick({ query: poolQueryMock } as never);

    expect(result).toEqual({ projectsChecked: 0, totalAdvanced: 0, totalEmailsSent: 0, totalStoppedForReply: 0 });
    expect(withTenantContextMock).not.toHaveBeenCalled();
    expect(advanceDueEnrollmentsMock).not.toHaveBeenCalled();
  });
});
