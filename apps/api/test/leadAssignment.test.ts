import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import { assignLead, getCurrentAssignment, getAssignmentHistory } from "../src/lib/leadAssignment.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "22222222-2222-2222-2222-222222222222";
const LEAD_1 = "33333333-3333-3333-3333-333333333333";
const USER_1 = "44444444-4444-4444-4444-444444444444";
const USER_2 = "55555555-5555-5555-5555-555555555555";

function fakeTenantDb(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>) {
  return { query: vi.fn(queryImpl) } as unknown as PoolClient;
}

describe("assignLead", () => {
  it("rejects assigning to a user who is not an active tenant member", async () => {
    const tenantDb = fakeTenantDb(async (sql) => {
      if (sql.includes("FROM memberships")) return { rowCount: 0, rows: [] };
      throw new Error("should not reach the INSERT when membership check fails");
    });
    await expect(
      assignLead(tenantDb, {
        tenantId: TENANT_1,
        projectId: PROJECT_1,
        leadId: LEAD_1,
        assignedUserId: USER_1,
        assignedBy: null,
      }),
    ).rejects.toThrow(/active member/);
  });

  it("inserts a new assignment row after confirming active membership", async () => {
    const tenantDb = fakeTenantDb(async (sql) => {
      if (sql.includes("FROM memberships")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("INSERT INTO lead_assignments")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "a1",
              lead_id: LEAD_1,
              assigned_user_id: USER_1,
              assigned_by: USER_2,
              assigned_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await assignLead(tenantDb, {
      tenantId: TENANT_1,
      projectId: PROJECT_1,
      leadId: LEAD_1,
      assignedUserId: USER_1,
      assignedBy: USER_2,
    });
    expect(result).toEqual({
      id: "a1",
      leadId: LEAD_1,
      assignedUserId: USER_1,
      assignedBy: USER_2,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("getCurrentAssignment", () => {
  it("returns null when a lead has never been assigned", async () => {
    const tenantDb = fakeTenantDb(async () => ({ rowCount: 0, rows: [] }));
    expect(await getCurrentAssignment(tenantDb, LEAD_1)).toBeNull();
  });

  it("returns the most recent assignment row (query orders by assigned_at DESC)", async () => {
    const tenantDb = fakeTenantDb(async (sql) => {
      expect(sql).toMatch(/ORDER BY assigned_at DESC/);
      return {
        rowCount: 1,
        rows: [{ id: "a2", lead_id: LEAD_1, assigned_user_id: USER_2, assigned_by: null, assigned_at: "2026-02-01T00:00:00.000Z" }],
      };
    });
    const result = await getCurrentAssignment(tenantDb, LEAD_1);
    expect(result?.assignedUserId).toBe(USER_2);
  });
});

describe("getAssignmentHistory", () => {
  it("returns every assignment row for a lead, most recent first", async () => {
    const tenantDb = fakeTenantDb(async () => ({
      rowCount: 2,
      rows: [
        { id: "a2", lead_id: LEAD_1, assigned_user_id: USER_2, assigned_by: USER_1, assigned_at: "2026-02-01T00:00:00.000Z" },
        { id: "a1", lead_id: LEAD_1, assigned_user_id: USER_1, assigned_by: null, assigned_at: "2026-01-01T00:00:00.000Z" },
      ],
    }));
    const history = await getAssignmentHistory(tenantDb, LEAD_1);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe("a2");
    expect(history[1].id).toBe("a1");
  });
});
