import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge, sourceBadgeTone, sourceLabel, statusTone } from "../components/Badge";
import { CopyButton } from "../components/CopyButton";
import { StatCard, StatGrid } from "../components/StatCard";
import { StatusBarChart } from "../components/charts/StatusBarChart";
import { IconKey, IconUsers, IconZap } from "../components/Icons";
import { colorForExecutionStatus, colorForIndex } from "../lib/chartColors";
import { api, ApiError, API_BASE_URL } from "../api/client";
import type { AgentExecutionSummary, AgentInstance, AgentRunResult, AgentTemplate, Lead, Project } from "../api/types";

const MARKET_RESEARCH_KEY = "market-research";

function apiOrigin(): string {
  // API_BASE_URL looks like "http://localhost:4000/api/v1" — the embed
  // widget's data-api-base is everything up to (and not including) the
  // "/api/v1" suffix, since embed.js appends the full path itself.
  return API_BASE_URL.replace(/\/api\/v1\/?$/, "");
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

export function ProjectPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [agentInstances, setAgentInstances] = useState<AgentInstance[] | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [executions, setExecutions] = useState<AgentExecutionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [provisioning, setProvisioning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runFormOpen, setRunFormOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<AgentRunResult | null>(null);

  const [industry, setIndustry] = useState("");
  const [geography, setGeography] = useState("");
  const [segment, setSegment] = useState("");
  const [question, setQuestion] = useState("");

  const [snippet, setSnippet] = useState("");

  // Widget settings form state (allowed origins + enable toggle) — mirrors
  // the real project fields, kept in sync whenever `project` reloads.
  const [originsDraft, setOriginsDraft] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState("");
  const [widgetEnabledDraft, setWidgetEnabledDraft] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, instancesRes, leadsRes, executionsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ agentInstances: AgentInstance[] }>(`/tenants/${tenantId}/projects/${projectId}/agent-instances`),
        api.get<{ leads: Lead[] }>(`/tenants/${tenantId}/projects/${projectId}/leads`),
        api.get<{ agentExecutions: AgentExecutionSummary[] }>(
          `/tenants/${tenantId}/projects/${projectId}/agent-executions`,
        ),
      ]);
      setProject(projectRes.project);
      setAgentInstances(instancesRes.agentInstances);
      setLeads(leadsRes.leads);
      setExecutions(executionsRes.agentExecutions);
      setOriginsDraft(projectRes.project.allowed_origins ?? []);
      setWidgetEnabledDraft(Boolean(projectRes.project.public_widget_enabled));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const defaultSnippet = useMemo(() => {
    if (!project?.public_api_key) return "";
    const base = apiOrigin();
    return `<form data-devlaunch-lead-form
      data-api-base="${base}"
      data-project-key="${project.public_api_key}"
      data-success-message="Thanks! We'll be in touch soon.">
  <label>Name <input type="text" name="name" required></label>
  <label>Email <input type="email" name="email" required></label>
  <label>Company <input type="text" name="company"></label>
  <label>Message <textarea name="message"></textarea></label>
  <button type="submit">Request a demo</button>
</form>
<script src="${base}/embed/embed.js" defer></script>`;
  }, [project?.public_api_key]);

  useEffect(() => {
    setSnippet(defaultSnippet);
  }, [defaultSnippet]);

  const marketResearchInstance = agentInstances?.find((a) => a.agent_key === MARKET_RESEARCH_KEY) ?? null;

  async function provisionMarketResearch() {
    if (!tenantId || !projectId) return;
    setRunError(null);
    setProvisioning(true);
    try {
      const templatesRes = await api.get<{ agentTemplates: AgentTemplate[] }>("/agent-templates");
      const template = templatesRes.agentTemplates.find((t) => t.key === MARKET_RESEARCH_KEY);
      if (!template) {
        throw new ApiError(404, "The market-research agent template isn't available yet.");
      }
      await api.post(`/tenants/${tenantId}/projects/${projectId}/agent-instances`, {
        templateId: template.id,
        name: "Market Research",
      });
      await load();
      setRunFormOpen(true);
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not set up the market-research agent.");
    } finally {
      setProvisioning(false);
    }
  }

  async function handleRun(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId || !marketResearchInstance) return;
    setRunError(null);
    setRunning(true);
    try {
      const res = await api.post<AgentRunResult>(`/tenants/${tenantId}/projects/${projectId}/agent-runs`, {
        agentInstanceId: marketResearchInstance.id,
        input: { industry, geography, segment, question },
      });
      setLastRun(res);
      setRunFormOpen(false);
      await load();
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not start the market-research run.");
    } finally {
      setRunning(false);
    }
  }

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setSettingsError(null);
    setSettingsSaved(false);
    setSavingSettings(true);
    try {
      const res = await api.patch<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`, {
        allowedOrigins: originsDraft,
        publicWidgetEnabled: widgetEnabledDraft,
      });
      setProject((prev) => (prev ? { ...prev, ...res.project } : prev));
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : "Could not save widget settings.");
    } finally {
      setSavingSettings(false);
    }
  }

  function addOrigin() {
    const value = newOrigin.trim();
    if (!value) return;
    if (!originsDraft.includes(value)) setOriginsDraft((prev) => [...prev, value]);
    setNewOrigin("");
  }

  function removeOrigin(origin: string) {
    setOriginsDraft((prev) => prev.filter((o) => o !== origin));
  }

  const steps = [
    { done: Boolean(project), label: "Project created" },
    { done: Boolean(project?.public_api_key), label: "Embed snippet ready" },
    { done: Boolean(leads && leads.length > 0), label: "First lead received" },
    { done: Boolean(marketResearchInstance?.last_run_at), label: "Market research run" },
  ];

  const leadStatusCounts = countBy(leads ?? [], (l) => l.status);
  const leadStatusLabels = Object.keys(leadStatusCounts);
  const executionStatusCounts = countBy(executions ?? [], (e) => e.status);

  const runningExecutions = (executionStatusCounts.running ?? 0) + (executionStatusCounts.queued ?? 0);

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "..." },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <StatGrid>
        <StatCard icon={<IconUsers />} label="Total leads" value={leads === null ? "…" : leads.length} />
        <StatCard
          icon={<IconZap />}
          label="Agent executions"
          value={executions === null ? "…" : executions.length}
          hint={executions && executions.length > 0 ? `${runningExecutions} in progress` : undefined}
        />
        <StatCard
          icon={<IconKey />}
          label="Widget"
          value={
            project ? (
              <Badge tone={project.public_widget_enabled ? "success" : "neutral"}>
                {project.public_widget_enabled ? "Enabled" : "Disabled"}
              </Badge>
            ) : (
              "…"
            )
          }
        />
      </StatGrid>

      <section className="panel">
        <h1>{project?.name ?? "Project"}</h1>
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={i} className={s.done ? "step step-done" : "step"}>
              <span className="step-check">{s.done ? "✓" : i + 1}</span>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel" id="agents-section">
        <h2>Agents &amp; executions</h2>
        <p className="muted">Run the market-research agent to get a structured answer about your market.</p>

        <ErrorBanner message={runError} />

        {agentInstances === null ? (
          <p className="muted">Loading...</p>
        ) : agentInstances.length === 0 ? (
          <EmptyState title="No agents configured yet" hint="Set up the market-research agent to get started." />
        ) : (
          <ul className="card-list card-list-static">
            {agentInstances.map((a) => (
              <li key={a.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{a.name}</strong>
                  <span className="muted"> ({a.agent_key} v{a.agent_version})</span>
                </div>
                <Badge tone={statusTone(a.status)}>{a.status}</Badge>
              </li>
            ))}
          </ul>
        )}

        {!marketResearchInstance ? (
          <button type="button" className="btn btn-primary" onClick={provisionMarketResearch} disabled={provisioning}>
            {provisioning ? "Setting up..." : "Set up market-research agent"}
          </button>
        ) : !runFormOpen ? (
          <button type="button" className="btn btn-primary" onClick={() => setRunFormOpen(true)}>
            Run market-research
          </button>
        ) : (
          <form className="form" onSubmit={handleRun}>
            <label className="field">
              <span>Industry</span>
              <input required value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. education" />
            </label>
            <label className="field">
              <span>Geography</span>
              <input required value={geography} onChange={(e) => setGeography(e.target.value)} placeholder="e.g. United States" />
            </label>
            <label className="field">
              <span>Segment</span>
              <input required value={segment} onChange={(e) => setSegment(e.target.value)} placeholder="e.g. career switchers" />
            </label>
            <label className="field">
              <span>Question</span>
              <input
                required
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What should we know about this market?"
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={running}>
                {running ? "Starting..." : "Start run"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setRunFormOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {lastRun ? (
          <div className="run-result">
            <p>
              Run started — execution <code>{lastRun.executionId}</code> ({lastRun.status}).
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => navigate(`/tenants/${tenantId}/executions/${lastRun.executionId}`)}
            >
              View execution status
            </button>
          </div>
        ) : null}

        <h3>Execution history</h3>
        {executions === null ? (
          <p className="muted">Loading...</p>
        ) : executions.length === 0 ? (
          <EmptyState title="No executions yet" hint="Runs you start above will show up here with their status." />
        ) : (
          <>
            <div className="chart-grid">
              <StatusBarChart
                title="Executions by status"
                segments={Object.entries(executionStatusCounts).map(([status, value]) => ({
                  key: status,
                  label: status,
                  value,
                  color: colorForExecutionStatus(status),
                }))}
              />
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Trigger</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.slice(0, 10).map((e) => (
                    <tr
                      key={e.id}
                      onClick={() => navigate(`/tenants/${tenantId}/executions/${e.id}`)}
                      style={{ cursor: "pointer" }}
                    >
                      <td>{e.agent_instance_name}</td>
                      <td>
                        <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                      </td>
                      <td>{e.trigger}</td>
                      <td>{e.started_at ? new Date(e.started_at).toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="panel" id="leads-section">
        <h2>Lead capture &amp; leads</h2>
        <p className="muted">
          Paste this snippet into any website to start collecting leads. Each submission shows up below, tagged
          "Public widget".
        </p>

        <div className="field">
          <span>Embed snippet</span>
          <textarea
            className="snippet"
            rows={10}
            value={snippet}
            onChange={(e) => setSnippet(e.target.value)}
            spellCheck={false}
          />
          <div className="form-actions">
            <CopyButton value={snippet} label="Copy snippet" />
            <button type="button" className="btn-link" onClick={() => setSnippet(defaultSnippet)}>
              Reset to default
            </button>
          </div>
        </div>

        <h3>Captured leads</h3>
        {leads === null ? (
          <p className="muted">Loading...</p>
        ) : leads.length === 0 ? (
          <EmptyState
            title="No leads yet"
            hint="Leads submitted through the widget above (or added manually) will appear here."
          />
        ) : (
          <>
            <div className="chart-grid">
              <StatusBarChart
                title="Leads by status"
                segments={leadStatusLabels.map((status, i) => ({
                  key: status,
                  label: status,
                  value: leadStatusCounts[status],
                  color: colorForIndex(i),
                }))}
              />
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Company</th>
                    <th>Source</th>
                    <th>Captured</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id}>
                      <td>{lead.name ?? "—"}</td>
                      <td>{lead.email ?? "—"}</td>
                      <td>{lead.company ?? "—"}</td>
                      <td>
                        <Badge tone={sourceBadgeTone(lead.source)}>{sourceLabel(lead.source)}</Badge>
                      </td>
                      <td>{new Date(lead.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="panel" id="settings-section">
        <h2>Widget settings</h2>
        <p className="muted">
          Control the public key, allowed embedding origins, and whether the lead-capture widget accepts submissions.
        </p>

        {project?.public_api_key ? (
          <div className="field" style={{ marginBottom: 16 }}>
            <span>Project public key</span>
            <div className="input-with-action">
              <input type="text" readOnly value={project.public_api_key} />
              <CopyButton value={project.public_api_key} />
            </div>
          </div>
        ) : null}

        <ErrorBanner message={settingsError} />

        <form className="settings-grid" onSubmit={handleSaveSettings}>
          <label className="field checkbox-field">
            <input
              type="checkbox"
              checked={widgetEnabledDraft}
              onChange={(e) => setWidgetEnabledDraft(e.target.checked)}
            />
            <span>Public widget enabled</span>
          </label>

          <div className="field">
            <span>Allowed origins</span>
            {originsDraft.length === 0 ? (
              <p className="muted hint" style={{ margin: "4px 0" }}>
                No origins allow-listed yet — the embed widget will reject submissions until one is added.
              </p>
            ) : (
              <ul className="origin-list">
                {originsDraft.map((origin) => (
                  <li key={origin}>
                    <span>{origin}</span>
                    <button
                      type="button"
                      className="origin-remove"
                      aria-label={`Remove ${origin}`}
                      onClick={() => removeOrigin(origin)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="input-with-action" style={{ marginTop: 8 }}>
              <input
                type="text"
                value={newOrigin}
                onChange={(e) => setNewOrigin(e.target.value)}
                placeholder="https://www.your-site.com"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOrigin();
                  }
                }}
              />
              <button type="button" className="btn btn-secondary btn-small" onClick={addOrigin}>
                Add
              </button>
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={savingSettings}>
              {savingSettings ? "Saving..." : "Save settings"}
            </button>
            {settingsSaved ? <span className="muted hint">Saved.</span> : null}
          </div>
        </form>
      </section>
    </Layout>
  );
}
