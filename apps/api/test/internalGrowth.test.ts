import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { internalGrowthRouter } = await import("../src/routes/internalGrowth.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/internal-growth", internalGrowthRouter);
  app.use(errorHandler);
  return app;
}

const INTERNAL_TENANT_ID = "d3f6a1b0-0000-4000-8000-000000000001";
const INTERNAL_PROJECT_ID = "d3f6a1b0-0000-4000-8000-000000000002";
const CLIENT_TENANT_ID = "99999999-9999-9999-9999-999999999999";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config (tenant + user)
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership lookup
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

describe("tenant-id restriction (assertInternalTenant)", () => {
  it("403s for a real, otherwise-valid owner membership on a DIFFERENT (client) tenant — this router never serves client-tenant data", async () => {
    queueResponses([...mockMembership("owner")]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${CLIENT_TENANT_ID}/projects/${INTERNAL_PROJECT_ID}/internal-growth/trials`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
    // No trial_signups query was ever reached.
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("FROM trial_signups"))).toBe(false);
  });
});

describe("RBAC (requireRole owner/admin)", () => {
  it("403s a 'viewer' membership on the correct internal tenant", async () => {
    queueResponses([...mockMembership("viewer")]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${INTERNAL_TENANT_ID}/projects/${INTERNAL_PROJECT_ID}/internal-growth/trials`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });

  it("allows an 'admin' membership on the correct internal tenant", async () => {
    queueResponses([
      ...mockMembership("admin"),
      { rowCount: 1, rows: [{ id: INTERNAL_PROJECT_ID }] }, // project exists
      { rowCount: 0, rows: [] }, // trials query
    ]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${INTERNAL_TENANT_ID}/projects/${INTERNAL_PROJECT_ID}/internal-growth/trials`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.trials).toEqual([]);
  });
});

describe("PATCH /trials/:id/status", () => {
  it("allows a valid transition (trial_started -> trial_active)", async () => {
    const trialId = "11111111-1111-1111-1111-111111111111";
    queueResponses([
      ...mockMembership("owner"),
      { rowCount: 1, rows: [{ id: INTERNAL_PROJECT_ID }] }, // project exists
      { rowCount: 1, rows: [{ id: trialId, status: "trial_started" }] }, // existing trial
      { rows: [{ id: trialId, status: "trial_active" }] }, // update
      undefined, // audit_events insert
    ]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/api/v1/tenants/${INTERNAL_TENANT_ID}/projects/${INTERNAL_PROJECT_ID}/internal-growth/trials/${trialId}/status`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "trial_active" });

    expect(res.status).toBe(200);
    expect(res.body.trial.status).toBe("trial_active");
  });

  it("rejects an invalid transition (converted -> trial_active) with 400, and never issues the UPDATE", async () => {
    const trialId = "11111111-1111-1111-1111-111111111111";
    queueResponses([
      ...mockMembership("owner"),
      { rowCount: 1, rows: [{ id: INTERNAL_PROJECT_ID }] }, // project exists
      { rowCount: 1, rows: [{ id: trialId, status: "converted" }] }, // existing trial, already converted
    ]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/api/v1/tenants/${INTERNAL_TENANT_ID}/projects/${INTERNAL_PROJECT_ID}/internal-growth/trials/${trialId}/status`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "trial_active" });

    expect(res.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("UPDATE trial_signups"))).toBe(false);
  });

  it("recording 'converted' always attributes it to the real authenticated staff user, never a payment webhook", async () => {
    const trialId = "11111111-1111-1111-1111-111111111111";
    queueResponses([
      ...mockMembership("owner"),
      { rowCount: 1, rows: [{ id: INTERNAL_PROJECT_ID }] },
      { rowCount: 1, rows: [{ id: trialId, status: "trial_active" }] },
      { rows: [{ id: trialId, status: "converted", converted_by: USER_1 }] },
      undefined,
    ]);

    const app = buildApp();
    const res = await request(app)
      .patch(`/api/v1/tenants/${INTERNAL_TENANT_ID}/projects/${INTERNAL_PROJECT_ID}/internal-growth/trials/${trialId}/status`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "converted" });

    expect(res.status).toBe(200);
    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("UPDATE trial_signups"));
    expect(updateCall![1]).toContain(USER_1);
  });
});

describe("GET /cac", () => {
  it("returns insufficient_data (never a guessed/zero-masked number) when no trial converted in the period", async () => {
    queueResponses([
      ...mockMembership("owner"),
      { rowCount: 1, rows: [{ id: INTERNAL_PROJECT_ID }] },
      { rows: [{ total_cents: "50000" }] }, // real spend exists
      { rows: [{ converted_count: 0 }] }, // but nothing converted
    ]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${INTERNAL_TENANT_ID}/projects/${INTERNAL_PROJECT_ID}/internal-growth/cac`)
      .query({ periodStart: "2026-01-01", periodEnd: "2026-01-31" })
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.cacCents).toBeNull();
    expect(res.body.reason).toBe("insufficient_data");
    expect(res.body.totalCostCents).toBe(50000);
  });

  it("computes real spend / real converted count when both are present", async () => {
    queueResponses([
      ...mockMembership("owner"),
      { rowCount: 1, rows: [{ id: INTERNAL_PROJECT_ID }] },
      { rows: [{ total_cents: "40000" }] },
      { rows: [{ converted_count: 4 }] },
    ]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/tenants/${INTERNAL_TENANT_ID}/projects/${INTERNAL_PROJECT_ID}/internal-growth/cac`)
      .query({ periodStart: "2026-01-01", periodEnd: "2026-01-31" })
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.cacCents).toBe(10000);
    expect(res.body.reason).toBeNull();
  });
});

describe("POST /acquisition-costs", () => {
  it("persists a real staff-entered spend row tied to the authenticated user", async () => {
    queueResponses([
      ...mockMembership("owner"),
      { rowCount: 1, rows: [{ id: INTERNAL_PROJECT_ID }] },
      { rows: [{ id: "cost-1", channel: "google_ads", amount_cents: 15000 }] },
    ]);

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/tenants/${INTERNAL_TENANT_ID}/projects/${INTERNAL_PROJECT_ID}/internal-growth/acquisition-costs`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "google_ads", periodStart: "2026-01-01", periodEnd: "2026-01-31", amountCents: 15000 });

    expect(res.status).toBe(201);
    expect(res.body.acquisitionCost.id).toBe("cost-1");
    const insertCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO acquisition_costs"));
    expect(insertCall![1]).toContain(USER_1);
  });
});
