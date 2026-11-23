import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import { z } from "zod";

/**
 * Lib-level tests against a minimal fake PoolClient — same fakeClient()
 * pattern as aiSalesAssistant.test.ts / llmBudget.test.ts. Covers the
 * honest-stub discipline (not_configured / budget_exceeded never
 * fabricate a result), the valid-JSON-retry-once behavior, and tool
 * evidence gathering.
 */
function fakeClient() {
  const q = vi.fn().mockResolvedValue({ rows: [{ total: "0", id: "run-1" }] });
  return { client: { query: q } as unknown as PoolClient, q };
}

const TENANT_ID = "tenant-1";
const PROJECT_ID = "project-1";

const fixtureDefinition = {
  key: "test_agent",
  label: "Test Agent",
  systemPrompt: "You are a test fixture agent.",
  inputSchema: z.object({ subjectId: z.string() }),
  outputSchema: z.object({ findings: z.array(z.string()), evidence: z.array(z.string()) }),
  outputFormatDescription: '{ "findings": string[], "evidence": string[] }',
};

beforeEach(() => {
  vi.resetModules();
});

describe("runAgent", () => {
  it("reports not_configured honestly and never calls the provider when no LLM key is set", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const { runAgent } = await import("../src/lib/agentPlatform/core/agentRunner.js");
    const { client, q } = fakeClient();

    const result = await runAgent(fixtureDefinition as any, { subjectId: "s1" }, {
      tenantDb: client,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      actorUserId: null,
    });

    expect(result).toEqual({ status: "not_configured", output: null, tokensUsed: 0 });
    // The only query made is the (best-effort) agent_runs persistence insert.
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0][0]).toMatch(/INSERT INTO agent_runs/);
  });

  it("rejects invalid input before ever touching the LLM provider or the database", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const { runAgent } = await import("../src/lib/agentPlatform/core/agentRunner.js");
    const { client, q } = fakeClient();

    await expect(
      runAgent(fixtureDefinition as any, { subjectId: 123 } as any, {
        tenantDb: client,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        actorUserId: null,
      }),
    ).rejects.toThrow();
    expect(q).not.toHaveBeenCalled();
  });

  it("reports budget_exceeded honestly and never calls the provider once this tenant's monthly LLM budget is used up", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: "real-key", anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: 500, logLevel: "silent" },
    }));
    const { runAgent } = await import("../src/lib/agentPlatform/core/agentRunner.js");
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ total: "1000" }] }); // getLlmTokenUsageThisMonth SUM

    const result = await runAgent(fixtureDefinition as any, { subjectId: "s1" }, {
      tenantDb: client,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      actorUserId: null,
    });

    expect(result).toEqual({ status: "budget_exceeded", output: null, tokensUsed: 0 });
  });

  it("returns a real ok result on the first valid completion, recording real token usage", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: "real-key", anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const complete = vi.fn().mockResolvedValueOnce({
      text: JSON.stringify({ findings: ["Finding A"], evidence: ["[tool:x] A"] }),
      inputTokens: 50,
      outputTokens: 20,
    });
    vi.doMock("../src/lib/llmProvider.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/llmProvider.js")>();
      return { ...actual, getLlmProvider: () => ({ name: "fake", isConfigured: true, complete }) };
    });
    const { runAgent } = await import("../src/lib/agentPlatform/core/agentRunner.js");
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ total: "0" }] }); // budget check

    const result = await runAgent(fixtureDefinition as any, { subjectId: "s1" }, {
      tenantDb: client,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      actorUserId: null,
    });

    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ findings: ["Finding A"], evidence: ["[tool:x] A"] });
    expect(result.tokensUsed).toBe(70);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once on an invalid-JSON first completion, then succeeds", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: "real-key", anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ text: "not json at all", inputTokens: 10, outputTokens: 5 })
      .mockResolvedValueOnce({
        text: JSON.stringify({ findings: ["Finding A"], evidence: ["[tool:x] A"] }),
        inputTokens: 15,
        outputTokens: 8,
      });
    vi.doMock("../src/lib/llmProvider.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/llmProvider.js")>();
      return { ...actual, getLlmProvider: () => ({ name: "fake", isConfigured: true, complete }) };
    });
    const { runAgent } = await import("../src/lib/agentPlatform/core/agentRunner.js");
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const result = await runAgent(fixtureDefinition as any, { subjectId: "s1" }, {
      tenantDb: client,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      actorUserId: null,
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    expect(result.tokensUsed).toBe(10 + 5 + 15 + 8);
  });

  it("honestly reports status: error (never a fabricated output) when both attempts fail validation", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: "real-key", anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const complete = vi.fn().mockResolvedValue({ text: "still not json", inputTokens: 1, outputTokens: 1 });
    vi.doMock("../src/lib/llmProvider.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/llmProvider.js")>();
      return { ...actual, getLlmProvider: () => ({ name: "fake", isConfigured: true, complete }) };
    });
    const { runAgent } = await import("../src/lib/agentPlatform/core/agentRunner.js");
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const result = await runAgent(fixtureDefinition as any, { subjectId: "s1" }, {
      tenantDb: client,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      actorUserId: null,
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("error");
    expect(result.output).toBeNull();
  });

  it("gathers tool evidence up front and includes it on the result, tolerating a failing tool without crashing the run", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: "real-key", anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const complete = vi.fn().mockResolvedValueOnce({
      text: JSON.stringify({ findings: [], evidence: [] }),
      inputTokens: 5,
      outputTokens: 5,
    });
    vi.doMock("../src/lib/llmProvider.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/llmProvider.js")>();
      return { ...actual, getLlmProvider: () => ({ name: "fake", isConfigured: true, complete }) };
    });
    const { runAgent } = await import("../src/lib/agentPlatform/core/agentRunner.js");
    const failingTool = {
      name: "always_fails",
      description: "a tool that always throws",
      inputSchema: z.object({}),
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const definitionWithTool = { ...fixtureDefinition, tools: [failingTool] };
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const result = await runAgent(definitionWithTool as any, { subjectId: "s1" }, {
      tenantDb: client,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      actorUserId: null,
    });

    expect(result.status).toBe("ok");
    expect(result.evidence?.[0]).toMatch(/\[tool:always_fails\] ERROR: boom/);
  });
});
