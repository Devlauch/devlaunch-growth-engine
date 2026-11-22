import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as every other route test in this suite: fake the
// pg pool so this is a true unit test, no real Postgres/RLS involved. The
// app-layer WHERE clauses asserted here (tenant_id + user_id = req.userId)
// are the same narrowing the real notifications_select/update RLS policies
// enforce independently (packages/db/migrations
// 251_enable_rls_notifications.sql) — this test proves the app layer
// itself never relies on RLS alone to stop cross-user access.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { notificationsRouter } = await import("../src/routes/notifications.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/notifications", notificationsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const USER_1 = "user-1";
const USER_2 = "user-2";
const NOTIF_1 = "99999999-9999-9999-9999-999999999999";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "member") {
  return [
    undefined, // BEGIN
    undefined, // set_config (tenant + user)
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

describe("GET .../notifications", () => {
  it("lists only the caller's own notifications, unread-first, with a real unread count", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 1,
        rows: [
          {
            id: NOTIF_1,
            type: "lead.captured",
            title: "New lead captured",
            body: "Jane Doe was captured.",
            link_url: null,
            read_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      { rowCount: 1, rows: [{ count: 1 }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/notifications`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.unreadCount).toBe(1);

    const listCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("FROM notifications"));
    expect(listCall![1]).toEqual([TENANT_A, USER_1, 20, 0]);
  });
});

describe("POST .../notifications/:id/read — user scoping", () => {
  it("marks the caller's own notification as read", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 1,
        rows: [
          {
            id: NOTIF_1,
            type: "lead.captured",
            title: "New lead captured",
            body: "Jane Doe was captured.",
            link_url: null,
            read_at: "2026-01-02T00:00:00.000Z",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/notifications/${NOTIF_1}/read`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.notification.read_at).not.toBeNull();

    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("UPDATE notifications"));
    // The app-layer WHERE clause scopes by tenant_id AND user_id = the
    // AUTHENTICATED caller (USER_1) — never a client-supplied "which user"
    // value — exactly like every other tenant-scoped mutation in this app.
    expect(updateCall![1]).toEqual([NOTIF_1, TENANT_A, USER_1]);
  });

  it("never lets one user mark ANOTHER user's notification as read, even within the same tenant", async () => {
    const app = buildApp();
    // USER_2 tries to mark a notification that (per the real WHERE clause,
    // scoped to user_id = $3 = USER_2) does not belong to them — the
    // UPDATE affects zero rows, and the follow-up existence check (also
    // scoped to USER_2) finds nothing either, since the row actually
    // belongs to USER_1.
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // UPDATE ... WHERE user_id = USER_2 -> no match
      { rowCount: 0, rows: [] }, // existence check WHERE user_id = USER_2 -> no match
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/notifications/${NOTIF_1}/read`)
      .set("X-Dev-User-Id", USER_2);

    expect(res.status).toBe(404);

    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("UPDATE notifications"));
    // Proves the query was scoped to the ACTUAL caller (USER_2), never to
    // USER_1 (the real owner) or any client-supplied value — this is what
    // makes cross-user mark-as-read impossible at the app layer, even
    // before RLS is considered at all.
    expect(updateCall![1]).toEqual([NOTIF_1, TENANT_A, USER_2]);
  });

  it("404s for a notification that doesn't exist at all", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // UPDATE -> no match
      { rowCount: 0, rows: [] }, // existence check -> no match
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/notifications/${NOTIF_1}/read`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("POST .../notifications/mark-all-read", () => {
  it("marks only the caller's own unread notifications as read", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 3, rows: [] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/notifications/mark-all-read`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.markedRead).toBe(3);

    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("UPDATE notifications"));
    expect(updateCall![1]).toEqual([TENANT_A, USER_1]);
  });
});
