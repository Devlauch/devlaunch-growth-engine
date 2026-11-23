import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  computeProviderCostRows,
  getProviderCostReport,
  PROVIDER_COST_CONFIG,
  PROVIDER_CALL_EVENT_TYPES,
  DEFAULT_PROVIDER_COST_WINDOW_DAYS,
} from "../src/lib/providerCostReporting.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";

function fakeTenantDb(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>) {
  return { query: vi.fn(queryImpl) } as unknown as PoolClient;
}

describe("PROVIDER_CALL_EVENT_TYPES — rebuilt against master's richer Hunter scheme", () => {
  it("tracks google_search_call and all four real Hunter event types from migration 440, never phase2's single hunter_api_call", () => {
    expect([...PROVIDER_CALL_EVENT_TYPES].sort()).toEqual(
      ["google_search_call", "hunter_api_request", "hunter_discovery", "hunter_request_failed", "hunter_verification"].sort(),
    );
  });
});

describe("computeProviderCostRows", () => {
  it("multiplies real call counts by the configured estimate for google_search_call", () => {
    const rows = computeProviderCostRows({ google_search_call: 200 });
    const google = rows.find((r) => r.eventType === "google_search_call");
    expect(google?.callCount).toBe(200);
    expect(google?.estimatedCostCentsPerCall).toBe(PROVIDER_COST_CONFIG.google_search_call!.estimatedCostCentsPerCall);
    expect(google?.estimatedCostCents).toBeCloseTo(200 * 0.5);
    expect(google?.realCreditsUsed).toBeNull(); // google isn't credit-metered
  });

  it("reports an honest real zero call count, never omitting a configured event type with no calls", () => {
    const rows = computeProviderCostRows({});
    const google = rows.find((r) => r.eventType === "google_search_call");
    expect(google?.callCount).toBe(0);
    expect(google?.estimatedCostCents).toBe(0);
  });

  it("reports estimatedCostCents as honestly null (never 0 or a guess) for every Hunter event type — no uniform published $/call price", () => {
    const rows = computeProviderCostRows({ hunter_api_request: 50, hunter_discovery: 5, hunter_verification: 3, hunter_request_failed: 1 });
    for (const eventType of ["hunter_api_request", "hunter_discovery", "hunter_verification", "hunter_request_failed"] as const) {
      const row = rows.find((r) => r.eventType === eventType);
      expect(row?.estimatedCostCentsPerCall).toBeNull();
      expect(row?.estimatedCostCents).toBeNull();
      expect(row?.note).toMatch(/no \$ cost estimate is configured/i);
    }
    expect(rows.find((r) => r.eventType === "hunter_api_request")?.callCount).toBe(50);
  });

  it("prefers a REAL credits-used figure over an estimate for hunter_api_request when supplied, labeled distinctly from estimatedCostCents", () => {
    const rows = computeProviderCostRows({ hunter_api_request: 10 }, { hunter_api_request: { used: 37, unit: "requests" } });
    const row = rows.find((r) => r.eventType === "hunter_api_request")!;
    expect(row.callCount).toBe(10);
    expect(row.realCreditsUsed).toBe(37);
    expect(row.realCreditsUnit).toBe("requests");
    expect(row.estimatedCostCents).toBeNull(); // still no $ estimate — credits != dollars
    expect(row.note).toMatch(/37 real credit\(s\)/);
  });

  it("leaves realCreditsUsed null when no credits data is supplied for a credit-metered event type (never guessed)", () => {
    const rows = computeProviderCostRows({ hunter_discovery: 5 });
    const row = rows.find((r) => r.eventType === "hunter_discovery")!;
    expect(row.realCreditsUsed).toBeNull();
    expect(row.realCreditsUnit).toBeNull();
  });

  it("always returns exactly one row per known provider-call event type", () => {
    const rows = computeProviderCostRows({
      google_search_call: 1,
      hunter_api_request: 1,
      hunter_discovery: 1,
      hunter_verification: 1,
      hunter_request_failed: 1,
    });
    expect(rows.map((r) => r.eventType).sort()).toEqual(
      ["google_search_call", "hunter_api_request", "hunter_discovery", "hunter_request_failed", "hunter_verification"].sort(),
    );
  });
});

describe("getProviderCostReport", () => {
  it("queries usage_events scoped to the tenant/project/window, excludes credit-marker rows from callCount, and computes the real-count-based estimate", async () => {
    let capturedSql: string | undefined;
    let capturedParams: unknown[] | undefined;
    const tenantDb = fakeTenantDb(async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rowCount: 2,
        rows: [
          { event_type: "google_search_call", count: "40", credits_used_sum: null, credits_unit: null },
          { event_type: "hunter_api_request", count: "12", credits_used_sum: "37", credits_unit: "requests" },
        ],
      };
    });

    const report = await getProviderCostReport(tenantDb, { tenantId: TENANT_1 });

    expect(capturedSql).toMatch(/FROM usage_events/);
    expect(capturedSql).toMatch(/GROUP BY event_type/);
    expect(capturedSql).toMatch(/creditsUnit/);
    expect(capturedParams?.[0]).toBe(TENANT_1);
    expect(capturedParams?.[3]).toBe(String(DEFAULT_PROVIDER_COST_WINDOW_DAYS));

    const google = report.rows.find((r) => r.eventType === "google_search_call");
    expect(google?.callCount).toBe(40);
    expect(google?.estimatedCostCents).toBeCloseTo(20);
    expect(google?.realCreditsUsed).toBeNull();

    const hunterRequest = report.rows.find((r) => r.eventType === "hunter_api_request");
    expect(hunterRequest?.callCount).toBe(12); // credit-marker rows already excluded by the FILTER in SQL
    expect(hunterRequest?.estimatedCostCents).toBeNull(); // no uniform published Hunter $/call price
    expect(hunterRequest?.realCreditsUsed).toBe(37); // real, header-derived — preferred over any estimate
    expect(hunterRequest?.realCreditsUnit).toBe("requests");

    const hunterDiscovery = report.rows.find((r) => r.eventType === "hunter_discovery");
    expect(hunterDiscovery?.callCount).toBe(0); // real honest zero — no calls this window
    expect(hunterDiscovery?.realCreditsUsed).toBeNull();

    expect(report.totalEstimatedCostCents).toBeCloseTo(20); // only the priced row (google) counts toward the total
    expect(report.creditsRemaining).toBeNull(); // never a fabricated balance

    // Apollo genuinely has no usage_events event type on master yet — real
    // gap, reported honestly, not invented.
    expect(report.notTracked).toEqual([
      expect.objectContaining({ provider: "apollo" }),
    ]);
  });

  it("honestly reports a real zero when a tenant has made no provider calls in the window", async () => {
    const tenantDb = fakeTenantDb(async () => ({ rowCount: 0, rows: [] }));
    const report = await getProviderCostReport(tenantDb, { tenantId: TENANT_1 });
    expect(report.rows.every((r) => r.callCount === 0)).toBe(true);
    expect(report.rows.every((r) => r.realCreditsUsed === null)).toBe(true);
    expect(report.totalEstimatedCostCents).toBe(0);
  });

  it("respects a caller-supplied windowDays override instead of the 30-day default", async () => {
    let capturedParams: unknown[] | undefined;
    const tenantDb = fakeTenantDb(async (_sql, params) => {
      capturedParams = params;
      return { rowCount: 0, rows: [] };
    });
    await getProviderCostReport(tenantDb, { tenantId: TENANT_1, windowDays: 7 });
    expect(capturedParams?.[3]).toBe("7");
  });

  it("rejects a non-positive windowDays rather than silently using it", async () => {
    const tenantDb = fakeTenantDb(async () => ({ rowCount: 0, rows: [] }));
    await expect(getProviderCostReport(tenantDb, { tenantId: TENANT_1, windowDays: 0 })).rejects.toThrow(/positive/);
  });
});
