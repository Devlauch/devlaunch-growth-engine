import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as campaigns.test.ts / analytics.test.ts: fake the
// pg pool so this is a true unit test with no real Postgres. Also mocks
// src/lib/queue.ts (BullMQ/ioredis) so enqueueing a run never needs a real
// Redis connection.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const enqueueAgentRunMock = vi.fn(async () => undefined);
vi.mock("../src/lib/queue.js", () => ({
  enqueueAgentRun: enqueueAgentRunMock,
}));

const { agentRunsRouter } = await import("../src/routes/agentRuns.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/agent-runs", agentRunsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const AGENT_INSTANCE_1 = "44444444-4444-4444-4444-444444444444";
const USER_1 = "user-1";
const USER_2 = "user-2";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  enqueueAgentRunMock.mockClear();
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

describe("tenant isolation on agent-runs routes", () => {
  it("denies a user with no active membership in the target tenant", async () => {
    const app = buildApp();
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 0, rows: [] }, // membership lookup: none
      undefined, // ROLLBACK
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_B}/projects/${PROJECT_1}/agent-runs`)
      .set("X-Dev-User-Id", USER_2)
      .send({ agentInstanceId: AGENT_INSTANCE_1, input: {} });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO agent_executions"), expect.anything());
  });
});

describe("POST /api/v1/tenants/:tenantId/projects/:projectId/agent-runs — real usage tracking", () => {
  it("writes a real usage_events row (event_type=agent_run) when a run is actually queued", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 1,
        rows: [{ id: AGENT_INSTANCE_1, status: "active", agent_key: "market-research" }],
      }, // agent instance lookup
      { rowCount: 1, rows: [{ plan: "free" }] }, // enforceQuota: SELECT plan
      { rowCount: 1, rows: [{ count: 0 }] }, // enforceQuota: SELECT COUNT(*) agent_executions today
      { rowCount: 1, rows: [{ id: "execution-1" }] }, // insert agent_executions
      undefined, // insert usage_event (agent_run)
      undefined, // insert audit_event
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/agent-runs`)
      .set("X-Dev-User-Id", USER_1)
      .send({ agentInstanceId: AGENT_INSTANCE_1, input: { industry: "x", geography: "y", segment: "z", question: "q" } });

    expect(res.status).toBe(202);
    expect(res.body.executionId).toBe("execution-1");
    expect(enqueueAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "execution-1", tenantId: TENANT_A, projectId: PROJECT_1 }),
    );

    const usageCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO usage_events"),
    );
    expect(usageCall).toBeDefined();
    const [, params] = usageCall!;
    expect(params[0]).toBe(TENANT_A); // tenant_id
    expect(params[1]).toBe(PROJECT_1); // project_id
    expect(params[2]).toBe("agent_run"); // event_type
    expect(params[3]).toBe(1); // quantity — a real count, never fabricated
  });

  it("never writes a usage_events row when the agent instance lookup fails (nothing was actually queued)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // agent instance lookup: none found
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/agent-runs`)
      .set("X-Dev-User-Id", USER_1)
      .send({ agentInstanceId: AGENT_INSTANCE_1, input: {} });

    expect(res.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO usage_events"), expect.anything());
  });
});
