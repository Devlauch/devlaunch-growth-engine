import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { computeLostDealAnalysis, MIN_LOST_DEALS_FOR_ANALYSIS } from "../src/lib/lostDealAnalysis.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("computeLostDealAnalysis (lib, direct tenantDb mock)", () => {
  it("reports insufficientData honestly with fewer than MIN_LOST_DEALS_FOR_ANALYSIS lost deals", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        { id: "d1", lead_id: "l1", created_at: daysAgoIso(10), stage_changed_at: daysAgoIso(5) },
        { id: "d2", lead_id: "l2", created_at: daysAgoIso(10), stage_changed_at: daysAgoIso(5) },
      ],
    });
    const result = await computeLostDealAnalysis({ query } as any, TENANT_A, PROJECT_1);

    expect(result.lostDealCount).toBe(2);
    expect(result.insufficientData).toBe(true);
    expect(result.note).toMatch(new RegExp(`${MIN_LOST_DEALS_FOR_ANALYSIS}`));
    expect(result.timeToLoss).toBeUndefined();
  });

  it("computes real time-to-loss, reply correlation, and objection themes with enough lost deals", async () => {
    const lostDeals = [
      { id: "d1", lead_id: "l1", created_at: daysAgoIso(20), stage_changed_at: daysAgoIso(10) }, // 10 days to loss
      { id: "d2", lead_id: "l2", created_at: daysAgoIso(30), stage_changed_at: daysAgoIso(10) }, // 20 days to loss
      { id: "d3", lead_id: "l3", created_at: daysAgoIso(20), stage_changed_at: daysAgoIso(10) }, // 10 days to loss
    ];
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: lostDeals }) // lost deals
      .mockResolvedValueOnce({
        rows: [
          { lead_id: "l1", classification: "unsubscribe" },
          { lead_id: "l2", classification: "not_now" },
        ],
      }) // most-recent reply per lead
      .mockResolvedValueOnce({
        rows: [
          { lead_id: "l1", raw_content: "Please unsubscribe, it's too expensive for us anyway." },
          { lead_id: "l2", raw_content: "Not right now, bad timing." },
        ],
      }) // reply text
      .mockResolvedValueOnce({ rows: [] }); // note text

    const result = await computeLostDealAnalysis({ query } as any, TENANT_A, PROJECT_1);

    expect(result.lostDealCount).toBe(3);
    expect(result.insufficientData).toBe(false);
    expect(result.timeToLoss!.averageDays).toBeCloseTo((10 + 20 + 10) / 3, 1);
    expect(result.timeToLoss!.note).toMatch(/no deal_stage_history table/);

    expect(result.replyClassificationCorrelation!.leadsWithNoReplyOnRecord).toBe(1); // l3 has none
    const unsub = result.replyClassificationCorrelation!.byClassification.find(
      (b) => b.classification === "unsubscribe",
    );
    expect(unsub?.count).toBe(1);
    expect(unsub?.percentage).toBeCloseTo((1 / 3) * 100, 1);

    expect(result.objectionThemes!.dealsWithNoTextOnRecord).toBe(1); // d3 has no text
    const priceTheme = result.objectionThemes!.byTheme.find((b) => b.theme === "price");
    expect(priceTheme?.count).toBe(1);
    const timingTheme = result.objectionThemes!.byTheme.find((b) => b.theme === "timing");
    expect(timingTheme?.count).toBe(1);
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

describe("GET /deals/lost-analysis (route)", () => {
  it("returns insufficientData for a project with no lost deals yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // no lost deals
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/lost-analysis`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.lostDealAnalysis.insufficientData).toBe(true);
    expect(res.body.lostDealAnalysis.lostDealCount).toBe(0);
  });
});
