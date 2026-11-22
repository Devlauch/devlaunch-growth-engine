import { describe, it, expect, vi, beforeEach } from "vitest";
import { enforceQuota, getQuotaUsage } from "../src/lib/quota.js";
import { HttpError } from "../src/lib/httpError.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

// A minimal fake pg.PoolClient: enforceQuota/getQuotaUsage only ever call
// client.query(sql, params), so that's all we need to fake per test. Each
// test configures the mock to answer, in order: (1) the tenant's plan
// lookup, (2) the real COUNT(*) query for the resource being checked.
function fakeClient(plan: string, count: number) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ plan }] }) // SELECT plan FROM tenants
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ count }] }); // SELECT COUNT(*) ...
  return { query } as unknown as import("pg").PoolClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enforceQuota", () => {
  it("allows creation when usage is under the plan's limit", async () => {
    // free plan: maxProjects = 1; 0 existing projects -> allowed.
    const client = fakeClient("free", 0);
    await expect(enforceQuota(client, TENANT_A, "projects")).resolves.toBeUndefined();
  });

  it("blocks creation when usage is already at the plan's limit", async () => {
    // free plan: maxProjects = 1; already has 1 -> blocked with a real 402.
    const client = fakeClient("free", 1);
    await expect(enforceQuota(client, TENANT_A, "projects")).rejects.toMatchObject({
      status: 402,
      code: "plan_limit_exceeded",
    });
    await expect(enforceQuota(fakeClient("free", 1), TENANT_A, "projects")).rejects.toBeInstanceOf(HttpError);
  });

  it("blocks creation when usage is already over the plan's limit", async () => {
    const client = fakeClient("free", 5);
    await expect(enforceQuota(client, TENANT_A, "projects")).rejects.toMatchObject({ status: 402 });
  });

  it("names the limit and current plan in the rejection message", async () => {
    const client = fakeClient("starter", 3);
    try {
      await enforceQuota(client, TENANT_A, "projects");
      throw new Error("expected enforceQuota to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const message = (err as HttpError).message;
      expect(message).toContain("starter");
      expect(message).toContain("3"); // the starter plan's maxProjects limit
    }
  });

  it("never blocks an enterprise plan (unlimited / null limit)", async () => {
    const client = fakeClient("enterprise", 1_000_000);
    await expect(enforceQuota(client, TENANT_A, "projects")).resolves.toBeUndefined();
  });

  it("enforces the agentRunsPerDay resource against its own limit", async () => {
    // free plan: maxAgentRunsPerDay = 10
    await expect(enforceQuota(fakeClient("free", 9), TENANT_A, "agentRunsPerDay")).resolves.toBeUndefined();
    await expect(enforceQuota(fakeClient("free", 10), TENANT_A, "agentRunsPerDay")).rejects.toMatchObject({
      status: 402,
    });
  });
});

describe("getQuotaUsage", () => {
  it("returns the real current count and the plan's limit, never a fabricated number", async () => {
    const client = fakeClient("growth", 4);
    const usage = await getQuotaUsage(client, TENANT_A, "discoverySources");
    expect(usage).toEqual({ plan: "growth", resource: "discoverySources", current: 4, limit: 10 });
  });

  it("reports limit: null for an enterprise (unlimited) plan", async () => {
    const client = fakeClient("enterprise", 42);
    const usage = await getQuotaUsage(client, TENANT_A, "teamMembers");
    expect(usage.limit).toBeNull();
    expect(usage.current).toBe(42);
  });
});
