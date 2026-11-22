import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { computePipelineForecast, STAGE_FORECAST_WEIGHTS } from "../src/lib/pipelineForecast.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";

describe("computePipelineForecast (lib, direct tenantDb mock)", () => {
  it("weights each stage's real total value by its documented default probability-to-close", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        { stage: "new", deal_count: "2", deals_with_value_count: "1", total_value: "1000" },
        { stage: "qualified", deal_count: "1", deals_with_value_count: "1", total_value: "2000" },
      ],
    });
    const forecast = await computePipelineForecast({ query } as any, TENANT_A, PROJECT_1);

    expect(forecast.insufficientData).toBe(false);
    const newStage = forecast.byStage.find((s) => s.stage === "new")!;
    expect(newStage.totalValue).toBe(1000);
    expect(newStage.weightedValue).toBeCloseTo(1000 * STAGE_FORECAST_WEIGHTS.new, 5);

    const qualifiedStage = forecast.byStage.find((s) => s.stage === "qualified")!;
    expect(qualifiedStage.weightedValue).toBeCloseTo(2000 * STAGE_FORECAST_WEIGHTS.qualified, 5);

    expect(forecast.totals.dealCount).toBe(3);
    expect(forecast.totals.totalValue).toBe(3000);
    expect(forecast.totals.weightedValue).toBeCloseTo(
      1000 * STAGE_FORECAST_WEIGHTS.new + 2000 * STAGE_FORECAST_WEIGHTS.qualified,
      5,
    );
  });

  it("never fabricates a dollar value for stages/deals with no value_amount — still counts them", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ stage: "contacted", deal_count: "3", deals_with_value_count: "0", total_value: "0" }],
    });
    const forecast = await computePipelineForecast({ query } as any, TENANT_A, PROJECT_1);

    const contacted = forecast.byStage.find((s) => s.stage === "contacted")!;
    expect(contacted.dealCount).toBe(3);
    expect(contacted.dealsWithValueCount).toBe(0);
    expect(contacted.totalValue).toBe(0);
  });

  it("reports insufficientData honestly when zero open deals have a value set, even if deals exist", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ stage: "new", deal_count: "5", deals_with_value_count: "0", total_value: "0" }],
    });
    const forecast = await computePipelineForecast({ query } as any, TENANT_A, PROJECT_1);

    expect(forecast.insufficientData).toBe(true);
    expect(forecast.note).toMatch(/not available/i);
    expect(forecast.totals.dealCount).toBe(5);
  });

  it("returns a zeroed forecast with insufficientData when there are no open deals at all", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const forecast = await computePipelineForecast({ query } as any, TENANT_A, PROJECT_1);

    expect(forecast.insufficientData).toBe(true);
    expect(forecast.totals.dealCount).toBe(0);
    expect(forecast.byStage).toHaveLength(Object.keys(STAGE_FORECAST_WEIGHTS).length);
  });
});

// --- Route-level test (mocked pg client, same convention as deals.test.ts) ---

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { dealHealthRouter } = await import("../src/routes/dealHealth.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/deals", dealHealthRouter);
  app.use(errorHandler);
  return app;
}

const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "sales") {
  return [undefined, undefined, { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

describe("GET /deals/forecast (route)", () => {
  it("returns a real forecast for this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ stage: "proposal", deal_count: "1", deals_with_value_count: "1", total_value: "4000" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/forecast`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.forecast.insufficientData).toBe(false);
    expect(res.body.forecast.totals.totalValue).toBe(4000);
  });
});
