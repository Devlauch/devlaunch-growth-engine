import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// Mock the DB pool so this is a true unit test: no real Postgres needed.
// requireTenantMembership gets a fake pg client whose query() we control
// per test, so we can simulate "no active membership row" (cross-tenant
// access attempt) deterministically.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { requireTenantMembership } = await import("../src/middleware/tenant.js");

function makeReqRes(tenantId: string, userId = "user-1") {
  const req = {
    userId,
    params: { tenantId },
  } as unknown as Request;
  const res = {
    statusCode: 200,
    once: vi.fn(),
  } as unknown as Response;
  return { req, res };
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

describe("requireTenantMembership", () => {
  it("denies access when the user has no active membership for the requested tenant (cross-tenant access)", async () => {
    // BEGIN, set_config, then the membership SELECT returns zero rows.
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // membership lookup
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const { req, res } = makeReqRes(TENANT_A);
    const next = vi.fn();

    await requireTenantMembership(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(403);
    expect(req.tenantId).toBeUndefined();
    expect(req.tenantDb).toBeUndefined();
    // Must roll back and release the connection rather than leaking it.
    expect(queryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("grants access and attaches tenantDb when an active membership exists", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] });

    const { req, res } = makeReqRes(TENANT_A);
    const next = vi.fn();

    await requireTenantMembership(req, res, next);

    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.tenantId).toBe(TENANT_A);
    expect(req.membershipRole).toBe("owner");
    expect(req.tenantDb).toBeDefined();
  });

  it("rejects a non-UUID tenantId without ever touching the database", async () => {
    const { req, res } = makeReqRes("not-a-uuid");
    const next = vi.fn();

    await requireTenantMembership(req, res, next);

    expect(connectMock).not.toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.status).toBe(400);
  });
});
