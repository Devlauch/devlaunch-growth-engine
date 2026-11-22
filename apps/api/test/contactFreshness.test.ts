import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  computeContactFreshness,
  getContactVerificationFreshness,
  DEFAULT_STALE_VERIFICATION_THRESHOLD_DAYS,
} from "../src/lib/contactFreshness.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const CONTACT_1 = "33333333-3333-3333-3333-333333333333";

function fakeTenantDb(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>) {
  return { query: vi.fn(queryImpl) } as unknown as Pick<PoolClient, "query">;
}

describe("computeContactFreshness", () => {
  it("reports everVerified: false (never a fabricated date) when there's no prior check", () => {
    const freshness = computeContactFreshness(null, null, null, new Date("2026-11-22T00:00:00Z"));
    expect(freshness.everVerified).toBe(false);
    expect(freshness.lastVerifiedAt).toBeNull();
    expect(freshness.daysSinceVerified).toBeNull();
    expect(freshness.isStale).toBe(true); // "no data" is treated as "needs attention"
  });

  it("computes days-since-verified and is not stale within the threshold", () => {
    const verifiedAt = new Date("2026-11-10T00:00:00Z"); // 12 days before `now`
    const now = new Date("2026-11-22T00:00:00Z");
    const freshness = computeContactFreshness(verifiedAt, "hunter", "valid", now, 30);
    expect(freshness.everVerified).toBe(true);
    expect(freshness.daysSinceVerified).toBe(12);
    expect(freshness.provider).toBe("hunter");
    expect(freshness.status).toBe("valid");
    expect(freshness.isStale).toBe(false);
  });

  it("marks a verification stale once it crosses the threshold", () => {
    const verifiedAt = new Date("2026-10-01T00:00:00Z"); // 52 days before `now`
    const now = new Date("2026-11-22T00:00:00Z");
    const freshness = computeContactFreshness(verifiedAt, "hunter", "unknown", now, 30);
    expect(freshness.daysSinceVerified).toBe(52);
    expect(freshness.isStale).toBe(true);
  });

  it("uses the documented 30-day default when no threshold is supplied", () => {
    const verifiedAt = new Date("2026-11-21T00:00:00Z"); // 1 day before `now`
    const now = new Date("2026-11-22T00:00:00Z");
    const freshness = computeContactFreshness(verifiedAt, "hunter", "valid", now);
    expect(freshness.staleThresholdDays).toBe(DEFAULT_STALE_VERIFICATION_THRESHOLD_DAYS);
    expect(freshness.isStale).toBe(false);
  });
});

describe("getContactVerificationFreshness", () => {
  it("queries contact_provenance_events by contact_id, scoped to verification events, ordering by verified_at DESC", async () => {
    let capturedSql: string | undefined;
    let capturedParams: unknown[] | undefined;
    const tenantDb = fakeTenantDb(async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rowCount: 1,
        rows: [{ provider: "hunter", verification_result: "valid", verified_at: new Date("2026-11-20T00:00:00Z") }],
      };
    });

    const freshness = await getContactVerificationFreshness(tenantDb, {
      tenantId: TENANT_1,
      contactId: CONTACT_1,
      now: new Date("2026-11-22T00:00:00Z"),
    });

    expect(capturedSql).toMatch(/FROM contact_provenance_events/);
    expect(capturedSql).toMatch(/event_type = 'verification'/);
    expect(capturedSql).toMatch(/ORDER BY verified_at DESC/);
    expect(capturedParams).toEqual([TENANT_1, CONTACT_1]);
    expect(freshness.everVerified).toBe(true);
    expect(freshness.provider).toBe("hunter");
    expect(freshness.status).toBe("valid");
    expect(freshness.daysSinceVerified).toBe(2);
  });

  it("returns everVerified: false when no ledger row exists yet, rather than throwing", async () => {
    const tenantDb = fakeTenantDb(async () => ({ rowCount: 0, rows: [] }));
    const freshness = await getContactVerificationFreshness(tenantDb, { tenantId: TENANT_1, contactId: CONTACT_1 });
    expect(freshness.everVerified).toBe(false);
    expect(freshness.isStale).toBe(true);
  });

  it("rejects when contactId is not supplied", async () => {
    const tenantDb = fakeTenantDb(async () => ({ rowCount: 0, rows: [] }));
    await expect(
      getContactVerificationFreshness(tenantDb, { tenantId: TENANT_1, contactId: "" }),
    ).rejects.toThrow(/requires contactId/);
  });
});
