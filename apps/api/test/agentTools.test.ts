import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  leadActivityTimelineTool,
  siteAnalyticsSummaryTool,
  webSearchTool,
  semanticSearchTool,
  getToolsForAgent,
  getTool,
} from "../src/lib/agentPlatform/core/agentTools.js";
import * as webSearchProvider from "../src/lib/webSearchProvider.js";
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

describe("webSearchTool", () => {
  const context = { tenantDb: fakeClient().client, tenantId: TENANT_ID, projectId: PROJECT_ID, actorUserId: null };

  it("returns { status: \"not_configured\", results: [] } rather than throwing when no web-search provider is configured — an expected, non-error state", async () => {
    vi.spyOn(webSearchProvider, "getWebSearchProvider").mockReturnValue(new webSearchProvider.NotConfiguredWebSearchProvider());

    const result = await webSearchTool.execute({ query: "DevLaunch competitors" }, context);

    expect(result).toEqual({ status: "not_configured", results: [] });
  });

  it("returns { status: \"ok\", results } from the configured provider's real search() call", async () => {
    const fakeResults = [{ title: "T", url: "https://example.com", snippet: "s", publishedDate: null }];
    const fakeProvider = {
      name: "tavily",
      isConfigured: true,
      search: vi.fn().mockResolvedValue(fakeResults),
    };
    vi.spyOn(webSearchProvider, "getWebSearchProvider").mockReturnValue(fakeProvider as any);

    const result = await webSearchTool.execute({ query: "DevLaunch competitors", maxResults: 3 }, context);

    expect(result).toEqual({ status: "ok", results: fakeResults });
    expect(fakeProvider.search).toHaveBeenCalledWith("DevLaunch competitors", { maxResults: 3 });
  });

  it("only accepts query (required) and maxResults (optional, 1-10), rejecting an out-of-range maxResults", () => {
    expect(() => webSearchTool.inputSchema.parse({ query: "x", maxResults: 11 })).toThrow();
    expect(webSearchTool.inputSchema.parse({ query: "x" })).toEqual({ query: "x" });
  });
});

describe("semanticSearchTool", () => {
  it("is registered but NOT assigned to any agent (deliberate scope limit — no indexing pipeline exists yet)", () => {
    expect(getTool("semantic_search")).toBeDefined();
  });

  it("returns { status: 'not_configured', results: [] } rather than throwing when no embedding provider/Qdrant instance is configured (the real state of this test environment: no OPENAI_API_KEY/QDRANT_URL)", async () => {
    const { client } = fakeClient();
    const result = await semanticSearchTool.execute(
      { query: "how do refunds work", collection: "docs" },
      { tenantDb: client, tenantId: TENANT_ID, projectId: PROJECT_ID, actorUserId: null },
    );
    expect(result).toEqual({ status: "not_configured", results: [] });
  });
});
