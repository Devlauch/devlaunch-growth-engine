import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconZap, IconSearch, IconTarget } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Workstream A1: AI Agent Center — lists the fixed set of native,
// tenant-aware research agents (apps/api/src/lib/agentPlatform/agents/) and
// lets a user run one against this project's real data and see the real
// result + execution history. Nothing here is fabricated client-side: every
// agent's result, status, and run history row below is a direct read from
// GET/POST .../agents* (apps/api/src/routes/agentPlatform.ts). When no
// ANTHROPIC_API_KEY is configured on the server (every environment this
// codebase has actually run in today), a run honestly comes back with
// status "not_configured" rather than a fabricated result.
interface AgentSummary {
  key: string;
  label: string;
  description: string | null;
  requiresApproval: boolean;
}

interface AgentRunResult {
  status: "ok" | "not_configured" | "budget_exceeded" | "error";
  output: Record<string, unknown> | null;
  evidence?: string[];
  tokensUsed: number;
  error?: string;
}

interface AgentRunRow {
  id: string;
  agentKey: string;
  input: unknown;
  output: unknown;
  status: string;
  tokensUsed: number;
  createdAt: string;
}

const STATUS_LABELS: Record<AgentRunResult["status"], string> = {
  ok: "Completed",
  not_configured: "LLM not configured",
  budget_exceeded: "Monthly LLM budget exceeded",
  error: "Error",
};

export function AiAgentCenterPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedAgentKey, setSelectedAgentKey] = useState<string>("");
  const [inputJson, setInputJson] = useState<string>("{}");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AgentRunResult | null>(null);

  const [runs, setRuns] = useState<AgentRunRow[] | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, agentsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ agents: AgentSummary[] }>(`/tenants/${tenantId}/projects/${projectId}/agents`),
      ]);
      setProject(projectRes.project);
      setAgents(agentsRes.agents);
      if (agentsRes.agents.length > 0 && !selectedAgentKey) {
        setSelectedAgentKey(agentsRes.agents[0].key);
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the AI Agent Center for this project.");
    }
    // selectedAgentKey intentionally excluded: only used to seed the initial selection once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadRuns = useCallback(
    async (agentKey: string) => {
      if (!tenantId || !projectId || !agentKey) return;
      try {
        const res = await api.get<{ runs: AgentRunRow[] }>(`/tenants/${tenantId}/projects/${projectId}/agents/${agentKey}/runs`);
        setRuns(res.runs);
      } catch (err) {
        setRuns(null);
      }
    },
    [tenantId, projectId],
  );

  useEffect(() => {
    if (selectedAgentKey) loadRuns(selectedAgentKey);
  }, [selectedAgentKey, loadRuns]);

  const runAgent = useCallback(async () => {
    if (!tenantId || !projectId || !selectedAgentKey) return;
    setRunning(true);
    setRunError(null);
    setLastResult(null);
    try {
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(inputJson || "{}");
      } catch {
        setRunError("Input must be valid JSON (e.g. { \"leadId\": \"...\" }).");
        setRunning(false);
        return;
      }
      const res = await api.post<{ run: AgentRunResult }>(
        `/tenants/${tenantId}/projects/${projectId}/agents/${selectedAgentKey}/run`,
        parsedInput,
      );
      setLastResult(res.run);
      loadRuns(selectedAgentKey);
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not run this agent.");
    } finally {
      setRunning(false);
    }
  }, [tenantId, projectId, selectedAgentKey, inputJson, loadRuns]);

  const selectedAgent = agents?.find((a) => a.key === selectedAgentKey) ?? null;
  const okRunCount = runs?.filter((r) => r.status === "ok").length ?? 0;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "AI Agent Center" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>AI Agent Center</h1>
        <p className="muted">
          Native, tenant-aware research agents grounded entirely in this project&apos;s real, existing data (site
          analysis, competitor snapshots, ICP conversion performance, lead activity timelines). Nothing here is
          fabricated — when no LLM provider is configured on the server, a run honestly reports that instead of
          returning invented output.
        </p>
      </section>

      {agents === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : agents.length === 0 ? (
        <section className="panel">
          <EmptyState title="No agents available" />
        </section>
      ) : (
        <>
          <StatGrid>
            <StatCard icon={<IconZap />} label="Available agents" value={agents.length} />
            <StatCard icon={<IconSearch />} label="Runs for selected agent" value={runs?.length ?? 0} />
            <StatCard icon={<IconTarget />} label="Completed runs" value={okRunCount} />
          </StatGrid>

          <section className="panel">
            <h2>Run an agent</h2>
            <label htmlFor="agent-select">Agent</label>
            <select
              id="agent-select"
              value={selectedAgentKey}
              onChange={(e) => {
                setSelectedAgentKey(e.target.value);
                setLastResult(null);
                setRunError(null);
              }}
            >
              {agents.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </select>
            {selectedAgent?.description ? <p className="muted">{selectedAgent.description}</p> : null}

            <label htmlFor="agent-input">
              Input (JSON) — e.g. {"{"}&quot;leadId&quot;: &quot;...&quot;{"}"}, {"{"}&quot;competitorId&quot;:
              &quot;...&quot;{"}"}, {"{"}&quot;growthAnalysisId&quot;: &quot;...&quot;{"}"}, or {"{"}&quot;icpProfileId&quot;:
              &quot;...&quot;{"}"} depending on the agent selected above.
            </label>
            <textarea
              id="agent-input"
              rows={3}
              value={inputJson}
              onChange={(e) => setInputJson(e.target.value)}
              spellCheck={false}
            />

            <button type="button" onClick={runAgent} disabled={running || !selectedAgentKey}>
              {running ? "Running..." : "Run agent"}
            </button>
            <ErrorBanner message={runError} />

            {lastResult ? (
              <div className="panel" style={{ marginTop: "1rem" }}>
                <h3>Result — {STATUS_LABELS[lastResult.status]}</h3>
                {lastResult.status === "not_configured" ? (
                  <p className="muted">
                    No LLM provider is configured in this environment, so this agent cannot run yet. This is an honest
                    report, not an error — nothing was fabricated.
                  </p>
                ) : lastResult.status === "budget_exceeded" ? (
                  <p className="muted">This tenant&apos;s monthly LLM token budget has already been used up this month.</p>
                ) : lastResult.status === "error" ? (
                  <p className="muted">{lastResult.error ?? "The agent run failed."}</p>
                ) : (
                  <>
                    <pre className="code-block">{JSON.stringify(lastResult.output, null, 2)}</pre>
                    {lastResult.evidence && lastResult.evidence.length > 0 ? (
                      <>
                        <h4>Grounding evidence used</h4>
                        <ul>
                          {lastResult.evidence.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    <p className="muted">Tokens used: {lastResult.tokensUsed}</p>
                  </>
                )}
              </div>
            ) : null}
          </section>

          <section className="panel">
            <h2>Execution history</h2>
            {runs === null || runs.length === 0 ? (
              <EmptyState title="No runs yet" hint="Run this agent above to see its history here." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Status</th>
                    <th>Tokens used</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.createdAt).toLocaleString()}</td>
                      <td>{STATUS_LABELS[r.status as AgentRunResult["status"]] ?? r.status}</td>
                      <td>{r.tokensUsed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Layout>
  );
}
