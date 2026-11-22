import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  apiRequestCounterMiddleware,
  drainPendingApiRequestCounts,
  flushApiRequestCounts,
} from "../src/lib/usageTracking.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  // Drain any counts left over from a previous test (the counter Map is
  // module-level, same as rateLimitMiddleware's buckets).
  drainPendingApiRequestCounts();
});

function buildApp() {
  const app = express();
  app.use(apiRequestCounterMiddleware);
  app.get("/api/v1/tenants/:tenantId/*", (_req, res) => res.json({ ok: true }));
  app.get("/api/v1/health", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("apiRequestCounterMiddleware", () => {
  it("attributes a tenant-scoped request path to that tenant's in-memory counter", async () => {
    const app = buildApp();
    await request(app).get(`/api/v1/tenants/${TENANT_A}/projects`);
    await request(app).get(`/api/v1/tenants/${TENANT_A}/projects`);
    await request(app).get(`/api/v1/tenants/${TENANT_B}/projects`);

    const counts = drainPendingApiRequestCounts();
    expect(counts.get(TENANT_A)).toBe(2);
    expect(counts.get(TENANT_B)).toBe(1);
  });

  it("never attributes a non-tenant-scoped request (e.g. health) to any tenant", async () => {
    const app = buildApp();
    await request(app).get("/api/v1/health");

    const counts = drainPendingApiRequestCounts();
    expect(counts.size).toBe(0);
  });
});

describe("flushApiRequestCounts", () => {
  it("writes one real batched usage_events row per tenant and clears the in-memory counter", async () => {
    const app = buildApp();
    await request(app).get(`/api/v1/tenants/${TENANT_A}/projects`);
    await request(app).get(`/api/v1/tenants/${TENANT_A}/projects`);
    await request(app).get(`/api/v1/tenants/${TENANT_A}/projects`);

    const queryMock = vi.fn();
    const withTenantContext = vi.fn(async (tenantId: string, fn: (client: { query: typeof queryMock }) => Promise<void>) => {
      await fn({ query: queryMock });
    });

    await flushApiRequestCounts(withTenantContext);

    expect(withTenantContext).toHaveBeenCalledWith(TENANT_A, expect.any(Function));
    const insertCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO usage_events"));
    expect(insertCall).toBeDefined();
    expect(insertCall![1][0]).toBe(TENANT_A);
    expect(insertCall![1][1]).toBe(3); // real batched count, never fabricated
    expect(insertCall![0]).toContain("'api_request'");

    // Draining again after a flush must be empty — counts were cleared.
    expect(drainPendingApiRequestCounts().size).toBe(0);
  });

  it("does nothing (no DB call at all) when no requests have come in since the last flush", async () => {
    const withTenantContext = vi.fn();
    await flushApiRequestCounts(withTenantContext);
    expect(withTenantContext).not.toHaveBeenCalled();
  });
});
