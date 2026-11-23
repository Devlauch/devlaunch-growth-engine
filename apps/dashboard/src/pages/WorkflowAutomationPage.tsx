import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";

/**
 * Workstream B dashboard page: Workstream B's native lifecycle-workflow
 * automation engine (apps/api/src/lib/workflowEngine.ts), mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/workflow-automation
 * (apps/api/src/routes/workflowAutomation.ts — NOT mounted in app.ts by
 * this change; see this task's report for the exact line to add).
 *
 * Deliberately a separate page/route from the existing WorkflowPage.tsx
 * (the Phase 4 autonomous agent pipeline at .../workflows) — same
 * distinction as the two routers on the API side: unrelated concepts, kept
 * apart on purpose, following that file's own naming/layout conventions
 * (Layout/EmptyState/ErrorBanner/Badge, api.get/api.post, local TS
 * interfaces mirroring the route's real response shapes).
 */

const TRIGGER_TYPES = ["scheduled", "condition", "event"] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

const DEFINITION_STATUSES = ["active", "paused", "draft"] as const;
type DefinitionStatus = (typeof DEFINITION_STATUSES)[number];

interface WorkflowDefinition {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  nodes: Array<{ key: string; type: "condition" | "action"; config: Record<string, unknown> }>;
  status: DefinitionStatus;
  created_at: string;
  updated_at: string;
}

interface WorkflowExecution {
  id: string;
  workflow_id: string;
  status: "running" | "completed" | "failed";
  trigger_payload: Record<string, unknown>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function statusTone(status: DefinitionStatus): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "warn";
    default: // draft
      return "neutral";
  }
}

function executionStatusTone(status: WorkflowExecution["status"]): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    default: // running
      return "info";
  }
}

function triggerSummary(def: WorkflowDefinition): string {
  if (def.trigger_type === "scheduled") {
    const minutes = Number(def.trigger_config.intervalMinutes ?? 60);
    return `Runs every ${minutes} minutes`;
  }
  if (def.trigger_type === "condition") {
    const entity = String(def.trigger_config.entity ?? "leads");
    const statusEquals = def.trigger_config.statusEquals ? ` status = ${def.trigger_config.statusEquals}` : "";
    const inactiveDays = def.trigger_config.inactiveDays ? ` inactive ${def.trigger_config.inactiveDays}+ days` : "";
    return `Fires when a ${entity} row matches:${statusEquals}${inactiveDays}`;
  }
  return "Fires on a direct/event trigger (no polling)";
}

export function WorkflowAutomationPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [definitions, setDefinitions] = useState<WorkflowDefinition[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [executions, setExecutions] = useState<WorkflowExecution[] | null>(null);
  const [executionsError, setExecutionsError] = useState<string | null>(null);

  const [runningId, setRunningId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<TriggerType>("event");
  const [nodesJson, setNodesJson] = useState(
    '[\n  {\n    "key": "notify_step",\n    "type": "action",\n    "config": { "actionType": "notify", "title": "Workflow ran", "body": "" },\n    "next": null\n  }\n]',
  );
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadDefinitions = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const res = await api.get<{ workflowDefinitions: WorkflowDefinition[] }>(
        `/tenants/${tenantId}/projects/${projectId}/workflow-automation`,
      );
      setDefinitions(res.workflowDefinitions);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Could not load workflow automations for this project.");
    }
  }, [tenantId, projectId]);

  const loadExecutions = useCallback(
    async (definitionId: string) => {
      if (!tenantId || !projectId) return;
      setExecutionsError(null);
      try {
        const res = await api.get<{ executions: WorkflowExecution[] }>(
          `/tenants/${tenantId}/projects/${projectId}/workflow-automation/${definitionId}/executions`,
        );
        setExecutions(res.executions);
      } catch (err) {
        setExecutionsError(err instanceof ApiError ? err.message : "Could not load execution history.");
      }
    },
    [tenantId, projectId],
  );

  useEffect(() => {
    loadDefinitions();
  }, [loadDefinitions]);

  useEffect(() => {
    if (selectedId) loadExecutions(selectedId);
  }, [selectedId, loadExecutions]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCreateError(null);

    let nodes: unknown;
    try {
      nodes = JSON.parse(nodesJson);
    } catch {
      setCreateError("Nodes must be valid JSON (an array of {key, type, config, next?} objects).");
      return;
    }

    setCreating(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/workflow-automation`, {
        name,
        triggerType,
        nodes,
        status: "draft",
      });
      setName("");
      setFormOpen(false);
      await loadDefinitions();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this workflow.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRun(definitionId: string) {
    if (!tenantId || !projectId) return;
    setRunError(null);
    setRunningId(definitionId);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/workflow-automation/${definitionId}/run`, {});
      if (selectedId === definitionId) await loadExecutions(definitionId);
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not run this workflow.");
    } finally {
      setRunningId(null);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: "Project", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Workflow Automation" },
      ]}
    >
      <section className="panel">
        <h1>Workflow automation</h1>
        <p className="callout">
          Native lifecycle-workflow automations: a trigger (scheduled, a condition on your data, or a direct event)
          plus a small chain of condition/action steps — follow-up tasks, lead-stage updates, sequence emails, and
          in-app notifications. Four starter templates (inactive-lead reactivation, demo follow-up, trial conversion
          nudge, customer retention check-in) are seeded as drafts for new projects; review and activate them below.
        </p>

        <ErrorBanner message={listError} />
        <ErrorBanner message={runError} />

        {definitions === null ? (
          <p className="muted">Loading...</p>
        ) : definitions.length === 0 ? (
          <EmptyState title="No workflow automations yet" hint="Create one below, or seed the starter library." />
        ) : (
          <ul className="card-list card-list-static">
            {definitions.map((def) => (
              <li
                key={def.id}
                className="card-list-item card-list-item-static"
                style={{ cursor: "pointer" }}
                onClick={() => setSelectedId(def.id)}
              >
                <div>
                  <strong>{def.name}</strong>
                  <p className="muted">{triggerSummary(def)}</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Badge tone={statusTone(def.status)}>{def.status}</Badge>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={runningId === def.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRun(def.id);
                    }}
                  >
                    {runningId === def.id ? "Running..." : "Run now"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(def.id);
                    }}
                  >
                    History
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {!formOpen ? (
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            New workflow automation
          </button>
        ) : (
          <form className="form" onSubmit={handleCreate}>
            <ErrorBanner message={createError} />
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Inactive lead reactivation" required />
            </label>
            <label className="field">
              <span>Trigger type</span>
              <select value={triggerType} onChange={(e) => setTriggerType(e.target.value as TriggerType)}>
                {TRIGGER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Nodes (JSON)</span>
              <textarea value={nodesJson} onChange={(e) => setNodesJson(e.target.value)} rows={10} spellCheck={false} />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? "Creating..." : "Create (as draft)"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      {selectedId ? (
        <section className="panel">
          <h2>Execution history</h2>
          <p className="muted">
            <code>{selectedId}</code>
          </p>

          <ErrorBanner message={executionsError} />

          {executions === null ? (
            <p className="muted">Loading...</p>
          ) : executions.length === 0 ? (
            <EmptyState title="No executions yet" hint="Run this workflow now, or wait for its trigger to fire." />
          ) : (
            <ul className="card-list card-list-static">
              {executions.map((ex) => (
                <li key={ex.id} className="card-list-item card-list-item-static">
                  <div>
                    <strong>{new Date(ex.started_at).toLocaleString()}</strong>
                    {ex.error ? <p className="muted">{ex.error}</p> : null}
                  </div>
                  <Badge tone={executionStatusTone(ex.status)}>{ex.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </Layout>
  );
}
