import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the DB pool so this is a true unit test: no real Postgres needed.
// Same pattern as projects.test.ts / campaigns.test.ts / tenantMiddleware.test.ts.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { membershipsRouter } = await import("../src/routes/memberships.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/memberships", membershipsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const MEMBERSHIP_1 = "66666666-6666-6666-6666-666666666666";
const TARGET_USER = "77777777-7777-7777-7777-777777777777";
const OWNER_USER = "user-owner";
const VIEWER_USER = "user-viewer";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m-self", role, status: "active" }] }, // membership lookup
  ];
}

describe("POST /api/v1/tenants/:tenantId/memberships (invite)", () => {
  it("denies a viewer from inviting a new member", async () => {
    const app = buildApp();
    for (const r of mockMembership("viewer")) queryMock.mockResolvedValueOnce(r);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/memberships`)
      .set("X-Dev-User-Id", VIEWER_USER)
      .send({ email: "new@example.com", role: "marketer" });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO memberships"), expect.anything());
  });

  it("allows an owner to invite an existing user by email, tenant-scoped, and writes an audit_events row", async () => {
    const app = buildApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m-self", role: "owner", status: "active" }] }) // self membership
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: TARGET_USER }] }) // SELECT users WHERE email
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: MEMBERSHIP_1, tenant_id: TENANT_A, user_id: TARGET_USER, role: "marketer", status: "invited", created_at: "2026-01-01" }],
      }) // INSERT memberships ... RETURNING
      .mockResolvedValueOnce(undefined); // INSERT audit_events

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/memberships`)
      .set("X-Dev-User-Id", OWNER_USER)
      .send({ email: "new@example.com", role: "marketer" });

    expect(res.status).toBe(201);
    expect(res.body.membership.role).toBe("marketer");

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO memberships"),
    );
    expect(insertCall![1]).toEqual([TENANT_A, TARGET_USER, "marketer", OWNER_USER]);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1][0]).toBe(TENANT_A);
    expect(auditCall![0]).toContain("'membership.created'");
    expect(JSON.parse(auditCall![1][3])).toEqual({ invitedEmail: "new@example.com", role: "marketer" });
  });

  it("404s inviting an email with no registered user, without fabricating one", async () => {
    const app = buildApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m-self", role: "owner", status: "active" }] }) // self membership
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // SELECT users WHERE email: none

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/memberships`)
      .set("X-Dev-User-Id", OWNER_USER)
      .send({ email: "ghost@example.com", role: "viewer" });

    expect(res.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO memberships"), expect.anything());
  });

  it("denies a cross-tenant actor with no membership in the target tenant", async () => {
    const app = buildApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no membership
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_B}/memberships`)
      .set("X-Dev-User-Id", VIEWER_USER)
      .send({ email: "new@example.com", role: "viewer" });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO memberships"), expect.anything());
  });
});

describe("PATCH /api/v1/tenants/:tenantId/memberships/:membershipId (role change)", () => {
  it("denies a viewer from changing another member's role", async () => {
    const app = buildApp();
    for (const r of mockMembership("viewer")) queryMock.mockResolvedValueOnce(r);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/memberships/${MEMBERSHIP_1}`)
      .set("X-Dev-User-Id", VIEWER_USER)
      .send({ role: "admin" });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE memberships"), expect.anything());
  });

  it("allows an owner to change a member's role, tenant-scoped, and audits it", async () => {
    const app = buildApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m-self", role: "owner", status: "active" }] }) // self membership
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: "analyst", status: "active" }] }) // assertNotLastActiveOwner: target lookup (not an owner, short-circuits)
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: MEMBERSHIP_1, tenant_id: TENANT_A, user_id: TARGET_USER, role: "sales", status: "active", updated_at: "2026-01-02" }],
      }) // UPDATE ... RETURNING
      .mockResolvedValueOnce(undefined); // INSERT audit_events

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/memberships/${MEMBERSHIP_1}`)
      .set("X-Dev-User-Id", OWNER_USER)
      .send({ role: "sales" });

    expect(res.status).toBe(200);
    expect(res.body.membership.role).toBe("sales");

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE memberships"),
    );
    expect(updateCall![1]).toEqual([MEMBERSHIP_1, TENANT_A, "sales", null]);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall![0]).toContain("'membership.updated'");
    expect(JSON.parse(auditCall![1][3])).toEqual({ role: "sales" });
  });

  it("refuses to demote the tenant's only active owner (lockout protection)", async () => {
    const app = buildApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m-self", role: "owner", status: "active" }] }) // self membership
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: "owner", status: "active" }] }) // target is an active owner
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // no other active owners

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/memberships/${MEMBERSHIP_1}`)
      .set("X-Dev-User-Id", OWNER_USER)
      .send({ role: "admin" });

    expect(res.status).toBe(409);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE memberships"), expect.anything());
  });
});

describe("DELETE /api/v1/tenants/:tenantId/memberships/:membershipId (remove)", () => {
  it("denies a viewer from removing a member", async () => {
    const app = buildApp();
    for (const r of mockMembership("viewer")) queryMock.mockResolvedValueOnce(r);

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_A}/memberships/${MEMBERSHIP_1}`)
      .set("X-Dev-User-Id", VIEWER_USER);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("DELETE FROM memberships"), expect.anything());
  });

  it("allows an admin to remove a member, tenant-scoped, and audits it", async () => {
    const app = buildApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m-self", role: "admin", status: "active" }] }) // self membership
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: "analyst", status: "active" }] }) // target lookup (not owner)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: MEMBERSHIP_1, user_id: TARGET_USER, role: "analyst" }] }) // DELETE ... RETURNING
      .mockResolvedValueOnce(undefined); // INSERT audit_events

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_A}/memberships/${MEMBERSHIP_1}`)
      .set("X-Dev-User-Id", "user-admin");

    expect(res.status).toBe(204);

    const deleteCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("DELETE FROM memberships"),
    );
    expect(deleteCall![1]).toEqual([MEMBERSHIP_1, TENANT_A]);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall![0]).toContain("'membership.removed'");
    expect(JSON.parse(auditCall![1][3])).toEqual({ removedUserId: TARGET_USER });
  });

  it("denies a cross-tenant actor from removing a membership in another tenant", async () => {
    const app = buildApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no membership in TENANT_B
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_B}/memberships/${MEMBERSHIP_1}`)
      .set("X-Dev-User-Id", VIEWER_USER);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("DELETE FROM memberships"), expect.anything());
  });
});
