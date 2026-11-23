import { describe, it, expect, vi } from "vitest";
import { recordQuotaOverageEvent } from "../src/lib/billingOverage.js";

function fakeClient(queryImpl: (sql: string, params: unknown[]) => Promise<unknown>) {
  return { query: vi.fn(queryImpl) };
}

describe("recordQuotaOverageEvent", () => {
  it("records a real overage row when the tenant is at/over its plan's limit", async () => {
    const client = fakeClient(async (sql) => {
      if (sql.includes("SELECT plan FROM tenants")) return { rowCount: 1, rows: [{ plan: "starter" }] };
      if (sql.includes("COUNT(*)::int AS count FROM projects")) return { rowCount: 1, rows: [{ count: 3 }] }; // starter limit is 3
      if (sql.includes("INSERT INTO billing_overage_events")) {
        return { rowCount: 1, rows: [{ id: "overage-1", recorded_at: "2026-01-01T00:00:00.000Z" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const event = await recordQuotaOverageEvent(client as never, "tenant-1", "projects");

    expect(event).toEqual({
      id: "overage-1",
      tenantId: "tenant-1",
      resource: "projects",
      plan: "starter",
      limitAtTime: 3,
      usageAtTime: 3,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns null (no overage row written) when usage is within limit", async () => {
    const client = fakeClient(async (sql) => {
      if (sql.includes("SELECT plan FROM tenants")) return { rowCount: 1, rows: [{ plan: "starter" }] };
      if (sql.includes("COUNT(*)::int AS count FROM projects")) return { rowCount: 1, rows: [{ count: 1 }] };
      throw new Error(`unexpected query for within-limit case: ${sql}`);
    });

    const event = await recordQuotaOverageEvent(client as never, "tenant-1", "projects");
    expect(event).toBeNull();
  });

  it("returns null for an unlimited (null-limit) resource on enterprise — no overage concept applies", async () => {
    const client = fakeClient(async (sql) => {
      if (sql.includes("SELECT plan FROM tenants")) return { rowCount: 1, rows: [{ plan: "enterprise" }] };
      if (sql.includes("COUNT(*)::int AS count FROM projects")) return { rowCount: 1, rows: [{ count: 500 }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const event = await recordQuotaOverageEvent(client as never, "tenant-1", "projects");
    expect(event).toBeNull();
  });
});
