import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  leadActivityTimelineTool,
  siteAnalyticsSummaryTool,
  getToolsForAgent,
  getTool,
} from "../src/lib/agentPlatform/core/agentTools.js";
// Importing the agent definitions registry triggers each agent module's
// assignAgentTools() side effect (see agents/leadResearchAgent.ts etc.) —
// same "import for its registration side effect" pattern as routes/*.ts
// importing a router module. Without this, getToolsForAgent() would see no
// assignments at all, since nothing else in this test file imports the
// agent definitions themselves.
import "../src/lib/agentPlatform/agents/index.js";

function fakeClient() {
  const q = vi.fn();
  return { client: { query: q } as unknown as PoolClient, q };
}

const TENANT_ID = "tenant-1";
const PROJECT_ID = "project-1";

describe("agentTools registry", () => {
  it("registers the real tools used by the four shipped agents and resolves them by assigned agent key", () => {
    expect(getTool("lead_activity_timeline")).toBeDefined();
    expect(getTool("site_analytics_summary")).toBeDefined();
    expect(getTool("competitor_snapshot_read")).toBeDefined();
    expect(getTool("growth_analysis_read")).toBeDefined();
    expect(getTool("icp_conversion_performance")).toBeDefined();

    expect(getToolsForAgent("lead_research").map((t) => t.name)).toEqual(["lead_activity_timeline"]);
    expect(getToolsForAgent("unknown_agent_key")).toEqual([]);
  });
});

describe("leadActivityTimelineTool", () => {
  it("scopes its lookup to the given tenantId + projectId and refuses a lead that doesn't belong to them", async () => {
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // lead existence check fails

    await expect(
      leadActivityTimelineTool.execute(
        { leadId: "11111111-1111-1111-1111-111111111111" },
        { tenantDb: client, tenantId: TENANT_ID, projectId: PROJECT_ID, actorUserId: null },
      ),
    ).rejects.toThrow(/not found in this tenant\/project/);

    const [sql, params] = q.mock.calls[0];
    expect(sql).toMatch(/FROM leads WHERE id = \$1 AND tenant_id = \$2 AND project_id = \$3/);
    expect(params).toEqual(["11111111-1111-1111-1111-111111111111", TENANT_ID, PROJECT_ID]);
  });

  it("refuses to run at all without a projectId in context — a tool never infers scope from elsewhere", async () => {
    const { client } = fakeClient();
    await expect(
      leadActivityTimelineTool.execute(
        { leadId: "11111111-1111-1111-1111-111111111111" },
        { tenantDb: client, tenantId: TENANT_ID, projectId: null, actorUserId: null },
      ),
    ).rejects.toThrow(/requires a projectId/);
  });
});

describe("siteAnalyticsSummaryTool", () => {
  it("only accepts the fields it declares (sinceDays), ignoring any other input fields handed to it", () => {
    const parsed = siteAnalyticsSummaryTool.inputSchema.parse({ sinceDays: 14, leadId: "ignored-by-this-tool" } as any);
    expect(parsed).toEqual({ sinceDays: 14 });
  });
});
