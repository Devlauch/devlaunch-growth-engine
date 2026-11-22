import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { integrationsRouter } = await import("../src/routes/integrations.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations", integrationsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const USER_1 = "user-1";
const USER_2 = "user-2";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

describe("tenant isolation on integrations routes", () => {
  it("denies a user with no active membership in the target tenant", async () => {
    const app = buildApp();
    queueResponses([
      undefined,
      undefined,
      { rowCount: 0, rows: [] },
      undefined,
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_B}/projects/${PROJECT_1}/integrations`)
      .set("X-Dev-User-Id", USER_2);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("FROM integrations"), expect.anything());
    expect(releaseMock).toHaveBeenCalled();
  });
});

describe("GET /integrations — real registry, never a fabricated 'connected' state", () => {
  it("defaults every provider to not_connected when no rows exist yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // no integrations rows yet
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.integrations).toHaveLength(6);
    expect(res.body.integrations.every((i: { status: string }) => i.status === "not_connected")).toBe(true);
    expect(res.body.note).toMatch(/no provider is actually connected/i);
  });

  it("merges in a real existing row's status instead of fabricating it", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      {
        rowCount: 1,
        rows: [{ id: "int-1", provider: "listmonk", status: "pending_setup", scopes: [], updated_at: "2026-11-20" }],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const listmonk = res.body.integrations.find((i: { provider: string }) => i.provider === "listmonk");
    expect(listmonk.status).toBe("pending_setup");
    const others = res.body.integrations.filter((i: { provider: string }) => i.provider !== "listmonk");
    expect(others.every((i: { status: string }) => i.status === "not_connected")).toBe(true);
  });
});

describe("POST /integrations/:provider/connect — placeholder only, never a real connection", () => {
  it("rejects an unknown provider", async () => {
    const app = buildApp();
    queueResponses([...mockMembership()]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/not-a-real-provider/connect`)
      .set("X-Dev-User-Id", USER_1)
      .send({ placeholderLabel: "my-instance" });

    expect(res.status).toBe(400);
  });

  it("sets status to pending_setup and returns an explicit non-functional note, never 'connected'", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: "int-1", provider: "mautic", status: "pending_setup", scopes: [], updated_at: "2026-11-21" }],
      }, // INSERT ... ON CONFLICT ... RETURNING
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/integrations/mautic/connect`)
      .set("X-Dev-User-Id", USER_1)
      .send({ placeholderLabel: "acme-mautic" });

    expect(res.status).toBe(201);
    expect(res.body.integration.status).toBe("pending_setup");
    expect(res.body.note).toMatch(/not implemented yet/i);

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO integrations"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual([TENANT_A, PROJECT_1, "mautic", "acme-mautic", USER_1]);
  });
});
