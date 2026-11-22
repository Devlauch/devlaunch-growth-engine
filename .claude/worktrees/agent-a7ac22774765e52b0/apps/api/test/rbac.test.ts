import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { requireRole, ROLES, ADMIN_ROLES, GTM_ROLES } from "../src/middleware/rbac.js";

function makeReq(membershipRole?: string): Request {
  return { membershipRole } as unknown as Request;
}

describe("requireRole", () => {
  it("denies a viewer from a restricted (owner/admin-only) action", () => {
    const middleware = requireRole(...ADMIN_ROLES);
    const req = makeReq("viewer");
    const next = vi.fn();

    middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(403);
  });

  it("allows an owner to perform an owner/admin-only action", () => {
    const middleware = requireRole(...ADMIN_ROLES);
    const req = makeReq("owner");
    const next = vi.fn();

    middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // called with no error
  });

  it("denies when no membership role is resolved on the request at all", () => {
    const middleware = requireRole(...ADMIN_ROLES);
    const req = makeReq(undefined);
    const next = vi.fn();

    middleware(req, {} as Response, next);

    const err = next.mock.calls[0][0];
    expect(err.status).toBe(403);
  });

  it("allows a marketer for a go-to-market (approvals/campaigns) action but denies an analyst", () => {
    const middleware = requireRole(...GTM_ROLES);

    const marketerNext = vi.fn();
    middleware(makeReq("marketer"), {} as Response, marketerNext);
    expect(marketerNext).toHaveBeenCalledWith();

    const analystNext = vi.fn();
    middleware(makeReq("analyst"), {} as Response, analystNext);
    expect(analystNext.mock.calls[0][0].status).toBe(403);
  });

  it("ROLES matches the product spec exactly", () => {
    expect(ROLES).toEqual(["owner", "admin", "marketer", "sales", "analyst", "viewer"]);
  });
});
