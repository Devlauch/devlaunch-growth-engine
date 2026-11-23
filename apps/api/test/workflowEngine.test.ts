import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Same mocked-pg-pool-free unit-test style as
 * workflowApprovalAndExecutionStage.test.ts: workflowEngine.ts's
 * runWorkflow takes a PoolClient directly, so we fake just enough of it
 * (query) rather than standing up a real Postgres. The two real
 * downstream capabilities action executors call (advanceDueEnrollments /
 * notify / notifyTenantOwnersAndAdmins) are mocked here so this suite
 * tests workflowEngine.ts's OWN orchestration logic (condition evaluation,
 * dedupe idempotency, per-node failure isolation, execution/step
 * persistence) in isolation from those other modules' own already-tested
 * behavior.
 */
const advanceDueEnrollmentsMock = vi.fn();
vi.mock("../src/lib/advanceSequences.js", () => ({
  advanceDueEnrollments: (...args: unknown[]) => advanceDueEnrollmentsMock(...args),
}));

const notifyMock = vi.fn();
const notifyTenantOwnersAndAdminsMock = vi.fn();
vi.mock("../src/lib/notify.js", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
  notifyTenantOwnersAndAdmins: (...args: unknown[]) => notifyTenantOwnersAndAdminsMock(...args),
}));

const { runWorkflow, evaluateCondition, computeDedupeKey, readContextPath } = await import(
  "../src/lib/workflowEngine.js"
);

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const DEF_1 = "44444444-4444-4444-4444-444444444444";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";

function makeQueryMock(responses: unknown[]) {
  const queryMock = vi.fn();
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
  return queryMock;
}

beforeEach(() => {
  advanceDueEnrollmentsMock.mockReset();
  notifyMock.mockReset();
  notifyTenantOwnersAndAdminsMock.mockReset();
  notifyTenantOwnersAndAdminsMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// evaluateCondition / readContextPath — pure, no I/O
// ---------------------------------------------------------------------------

describe("readContextPath", () => {
  it("reads a nested dot-path", () => {
    expect(readContextPath({ lead: { status: "new" } }, "lead.status")).toBe("new");
  });

  it("returns undefined for a missing path instead of throwing", () => {
    expect(readContextPath({ lead: { status: "new" } }, "lead.missing.deeper")).toBeUndefined();
    expect(readContextPath({}, "a.b.c")).toBeUndefined();
  });
});

describe("evaluateCondition", () => {
  const context = { trigger: { daysInactive: 14, leadStatus: "new" }, leadId: LEAD_1 };

  it("eq: true only when the field exactly matches", () => {
    expect(
      evaluateCondition({ key: "n1", type: "condition", config: { field: "trigger.leadStatus", operator: "eq", value: "new" } }, context),
    ).toBe(true);
    expect(
      evaluateCondition(
        { key: "n1", type: "condition", config: { field: "trigger.leadStatus", operator: "eq", value: "qualified" } },
        context,
      ),
    ).toBe(false);
  });

  it("gte: numeric comparison", () => {
    expect(
      evaluateCondition({ key: "n1", type: "condition", config: { field: "trigger.daysInactive", operator: "gte", value: 14 } }, context),
    ).toBe(true);
    expect(
      evaluateCondition({ key: "n1", type: "condition", config: { field: "trigger.daysInactive", operator: "gte", value: 15 } }, context),
    ).toBe(false);
  });

  it("exists / not_exists", () => {
    expect(evaluateCondition({ key: "n1", type: "condition", config: { field: "leadId", operator: "exists" } }, context)).toBe(true);
    expect(evaluateCondition({ key: "n1", type: "condition", config: { field: "missing", operator: "not_exists" } }, context)).toBe(
      true,
    );
  });

  it("in: membership against a value array", () => {
    expect(
      evaluateCondition(
        { key: "n1", type: "condition", config: { field: "trigger.leadStatus", operator: "in", value: ["new", "qualified"] } },
        context,
      ),
    ).toBe(true);
  });

  it("an unknown operator is false, never throws", () => {
    expect(
      evaluateCondition({ key: "n1", type: "condition", config: { field: "trigger.leadStatus", operator: "bogus" as any } }, context),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeDedupeKey — idempotency hash
// ---------------------------------------------------------------------------

describe("computeDedupeKey", () => {
  it("is stable for the same payload regardless of key order", () => {
    const a = computeDedupeKey(DEF_1, { leadId: LEAD_1, triggerType: "condition" });
    const b = computeDedupeKey(DEF_1, { triggerType: "condition", leadId: LEAD_1 });
    expect(a).toBe(b);
  });

  it("differs for a different workflow id", () => {
    const a = computeDedupeKey(DEF_1, { leadId: LEAD_1 });
    const b = computeDedupeKey("99999999-9999-9999-9999-999999999999", { leadId: LEAD_1 });
    expect(a).not.toBe(b);
  });

  it("differs for a different payload", () => {
    const a = computeDedupeKey(DEF_1, { leadId: LEAD_1 });
    const b = computeDedupeKey(DEF_1, { leadId: "66666666-6666-6666-6666-666666666666" });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// runWorkflow — persistence, idempotency, per-node failure isolation
// ---------------------------------------------------------------------------

const NODES = [
  { key: "check_flag", type: "condition", config: { field: "trigger.flag", operator: "eq", value: true }, onTrue: "notify_step", onFalse: null },
  { key: "notify_step", type: "action", config: { actionType: "notify", title: "hi", body: "body" }, next: "task_step" },
  {
    key: "task_step",
    type: "action",
    config: { actionType: "create_task", taskType: "follow_up", title: "Follow up" },
    next: null,
  },
];

function definitionRow(nodes: unknown = NODES) {
  return { rowCount: 1, rows: [{ id: DEF_1, tenant_id: TENANT_A, project_id: PROJECT_1, nodes, status: "active" }] };
}

describe("runWorkflow", () => {
  it("walks condition -> action -> action, persisting one execution + one step per node, and completes", async () => {
    const queryMock = makeQueryMock([
      definitionRow(), // SELECT workflow_definitions
      { rowCount: 0, rows: [] }, // SELECT existing non-failed execution (none)
      { rowCount: 1, rows: [{ id: "exec-1" }] }, // INSERT workflow_executions
      { rowCount: 1, rows: [{}] }, // INSERT workflow_execution_steps (check_flag)
      { rowCount: 1, rows: [{}] }, // INSERT workflow_execution_steps (notify_step)
      { rowCount: 1, rows: [{ id: "task-1" }] }, // INSERT crm_tasks (task_step's create_task executor)
      { rowCount: 1, rows: [{}] }, // INSERT workflow_execution_steps (task_step)
      { rowCount: 1, rows: [{}] }, // UPDATE workflow_executions (completed)
    ]);

    const executionId = await runWorkflow(
      DEF_1,
      { flag: true },
      { tenantDb: { query: queryMock } as any, tenantId: TENANT_A, projectId: PROJECT_1, leadId: LEAD_1 },
    );

    expect(executionId).toBe("exec-1");
    expect(notifyTenantOwnersAndAdminsMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(8);
    // Final call marks the execution completed, not failed.
    const finalCall = queryMock.mock.calls[7];
    expect(finalCall[0]).toMatch(/UPDATE workflow_executions/);
    expect(finalCall[1][0]).toBe("completed");
  });

  it("is idempotent: returns the existing execution id without inserting a new one or running any node", async () => {
    const queryMock = makeQueryMock([
      definitionRow(),
      { rowCount: 1, rows: [{ id: "already-ran-1" }] }, // an existing non-failed execution for this exact dedupe key
    ]);

    const executionId = await runWorkflow(
      DEF_1,
      { flag: true },
      { tenantDb: { query: queryMock } as any, tenantId: TENANT_A, projectId: PROJECT_1, leadId: LEAD_1 },
    );

    expect(executionId).toBe("already-ran-1");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(notifyTenantOwnersAndAdminsMock).not.toHaveBeenCalled();
  });

  it("isolates a single node's failure: marks that step + the whole execution failed, but never throws, and does not run later nodes", async () => {
    notifyTenantOwnersAndAdminsMock.mockRejectedValueOnce(new Error("notification backend down"));

    const queryMock = makeQueryMock([
      definitionRow(),
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: "exec-2" }] },
      { rowCount: 1, rows: [{}] }, // check_flag step succeeds
      { rowCount: 1, rows: [{}] }, // notify_step's step row, written as 'failed' by the catch block
      { rowCount: 1, rows: [{}] }, // final UPDATE workflow_executions -> failed
    ]);

    const executionId = await runWorkflow(
      DEF_1,
      { flag: true },
      { tenantDb: { query: queryMock } as any, tenantId: TENANT_A, projectId: PROJECT_1, leadId: LEAD_1 },
    );

    expect(executionId).toBe("exec-2");
    // Only 6 queries ran: definition, dedupe check, insert, 2 step rows
    // (check_flag succeeded, notify_step failed), final update — task_step
    // never ran because the walk stops at the first failure.
    expect(queryMock).toHaveBeenCalledTimes(6);

    const notifyStepInsert = queryMock.mock.calls[4];
    expect(notifyStepInsert[0]).toMatch(/INSERT INTO workflow_execution_steps/);
    expect(notifyStepInsert[0]).toMatch(/'failed'/);
    expect(JSON.parse(notifyStepInsert[1][4] as string).error).toMatch(/notification backend down/);

    const finalCall = queryMock.mock.calls[5];
    expect(finalCall[0]).toMatch(/UPDATE workflow_executions/);
    expect(finalCall[1][0]).toBe("failed");
    expect(finalCall[1][1]).toMatch(/Node "notify_step" failed/);
  });

  it("evaluates a false condition and stops at onFalse (null), never reaching the action nodes", async () => {
    const queryMock = makeQueryMock([
      definitionRow(),
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: "exec-3" }] },
      { rowCount: 1, rows: [{}] }, // check_flag step (condition evaluates false)
      { rowCount: 1, rows: [{}] }, // final UPDATE -> completed
    ]);

    const executionId = await runWorkflow(
      DEF_1,
      { flag: false },
      { tenantDb: { query: queryMock } as any, tenantId: TENANT_A, projectId: PROJECT_1, leadId: LEAD_1 },
    );

    expect(executionId).toBe("exec-3");
    expect(queryMock).toHaveBeenCalledTimes(5);
    expect(notifyTenantOwnersAndAdminsMock).not.toHaveBeenCalled();
    const finalCall = queryMock.mock.calls[4];
    expect(finalCall[1][0]).toBe("completed");
  });

  it("throws for an unknown definitionId (a caller bug, not a node runtime failure)", async () => {
    const queryMock = makeQueryMock([{ rowCount: 0, rows: [] }]);
    await expect(
      runWorkflow(
        "99999999-9999-9999-9999-999999999999",
        {},
        { tenantDb: { query: queryMock } as any, tenantId: TENANT_A, projectId: PROJECT_1 },
      ),
    ).rejects.toThrow(/not found/);
  });
});
