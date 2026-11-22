import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";

/**
 * Phase 4 autonomous pipeline UI. Talks to the orchestration-core agent's
 * route, mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/workflows
 * (apps/api/src/routes/workflows.ts): POST / (start), GET / (list),
 * GET /:id (run + full stage-result history), POST /:id/advance.
 *
 * Local TS interfaces here (not added to ../api/types.ts — that file is
 * owned by the orchestrator session per this task's file boundaries)
 * mirror apps/api/src/workflow/types.ts's StageResult/WorkflowRunRow shapes
 * and apps/api/src/workflow/engine.ts's WorkflowRunRow/WorkflowStageResultRow.
 *
 * This page only shows status and drives POST /:id/advance. It
 * deliberately does NOT build a second approval UI: when a run is
 * awaiting_approval, it names the real pending entity ids from
 * approvalContext and links out to the existing project screen where
 * message drafts are actually approved/rejected.
 */

const WORKFLOW_STAGES = [
  "client_onboarding",
  "research",
  "lead_generation",
  "content_campaign",
  "approval_compliance_gate",
  "campaign_execution",
  "analytics_learning",
] as const;
type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

const STAGE_LABELS: Record<WorkflowStage, string> = {
  client_onboarding: "Client onboarding",
  research: "Research",
  lead_generation: "Lead generation",
  content_campaign: "Content & campaign",
  approval_compliance_gate: "Approval & compliance gate",
  campaign_execution: "Campaign execution",
  analytics_learning: "Analytics & learning",
};

interface WorkflowRun {
  id: string;
  tenant_id: string;
  project_id: string;
  status: "running" | "awaiting_approval" | "completed" | "failed";
  current_stage: WorkflowStage;
  input_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface WorkflowStageResult {
  id: string;
  tenant_id: string;
  workflow_run_id: string;
  stage: WorkflowStage;
  status: "completed" | "failed" | "needs_approval";
  summary: string;
  data: Record<string, unknown>;
  approval_context: { entityType: string; entityIds: string[] } | null;
  started_at: string;
  completed_at: string;
  created_at: string;
}

function runStatusTone(status: WorkflowRun["status"]): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "awaiting_approval":
      return "warn";
    default: // running
      return "info";
  }
}

function stageResultStatusTone(status: WorkflowStageResult["status"]): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "needs_approval":
      return "warn";
    default:
      return "neutral";
  }
}

/** Most recent stage-result attempt per stage — a stage (e.g. the approval gate) can re-run. */
function latestResultByStage(stageResults: WorkflowStageResult[]): Partial<Record<WorkflowStage, WorkflowStageResult>> {
  const out: Partial<Record<WorkflowStage, WorkflowStageResult>> = {};
  for (const r of stageResults) {
    const existing = out[r.stage];
    if (!existing || new Date(r.created_at) >= new Date(existing.created_at)) {
      out[r.stage] = r;
    }
  }
  return out;
}

export function WorkflowPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [stageResults, setStageResults] = useState<WorkflowStageResult[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [industry, setIndustry] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [budget, setBudget] = useState("");
  const [goals, setGoals] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const res = await api.get<{ workflowRuns: WorkflowRun[] }>(`/tenants/${tenantId}/projects/${projectId}/workflows`);
      setRuns(res.workflowRuns);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Could not load workflow runs for this project.");
    }
  }, [tenantId, projectId]);

  const loadDetail = useCallback(
    async (runId: string) => {
      if (!tenantId || !projectId) return;
      setDetailError(null);
      try {
        const res = await api.get<{ workflowRun: WorkflowRun; stageResults: WorkflowStageResult[] }>(
          `/tenants/${tenantId}/projects/${projectId}/workflows/${runId}`,
        );
        setSelectedRun(res.workflowRun);
        setStageResults(res.stageResults);
      } catch (err) {
        setDetailError(err instanceof ApiError ? err.message : "Could not load this workflow run.");
      }
    },
    [tenantId, projectId],
  );

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (selectedRunId) loadDetail(selectedRunId);
  }, [selectedRunId, loadDetail]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCreateError(null);
    setCreating(true);
    try {
      const inputConfig: Record<string, unknown> = {};
      if (industry.trim()) inputConfig.industry = industry.trim();
      if (targetAudience.trim()) inputConfig.targetAudience = targetAudience.trim();
      if (budget.trim()) inputConfig.budget = budget.trim();
      if (goals.trim()) inputConfig.goals = goals.trim();

      const res = await api.post<{ workflowRun: WorkflowRun }>(
        `/tenants/${tenantId}/projects/${projectId}/workflows`,
        inputConfig,
      );
      setIndustry("");
      setTargetAudience("");
      setBudget("");
      setGoals("");
      setFormOpen(false);
      await loadRuns();
      setSelectedRunId(res.workflowRun.id);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not start a new workflow.");
    } finally {
      setCreating(false);
    }
  }

  async function handleAdvance() {
    if (!tenantId || !projectId || !selectedRun) return;
    setAdvanceError(null);
    setAdvancing(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/workflows/${selectedRun.id}/advance`);
      await loadDetail(selectedRun.id);
      await loadRuns();
    } catch (err) {
      setAdvanceError(err instanceof ApiError ? err.message : "Could not advance this workflow.");
    } finally {
      setAdvancing(false);
    }
  }

  const byStage = stageResults ? latestResultByStage(stageResults) : {};
  const pendingApproval =
    selectedRun?.status === "awaiting_approval"
      ? byStage[selectedRun.current_stage]?.approval_context ?? null
      : null;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: "Project", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Workflow" },
      ]}
    >
      <section className="panel">
        <h1>Autonomous pipeline</h1>
        <p className="callout">
          Chains the client onboarding, research, lead generation, content/campaign, approval & compliance,
          execution, and analytics/learning stages into one run, one stage at a time.
        </p>

        <ErrorBanner message={listError} />

        {runs === null ? (
          <p className="muted">Loading...</p>
        ) : runs.length === 0 ? (
          <EmptyState title="No workflow runs yet" hint="Start one below to run the full pipeline." />
        ) : (
          <ul className="card-list card-list-static">
            {runs.map((r) => (
              <li
                key={r.id}
                className="card-list-item card-list-item-static"
                style={{ cursor: "pointer" }}
                onClick={() => setSelectedRunId(r.id)}
              >
                <div>
                  <strong>{STAGE_LABELS[r.current_stage] ?? r.current_stage}</strong>
                  <span className="muted"> · started {new Date(r.created_at).toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Badge tone={runStatusTone(r.status)}>{r.status}</Badge>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedRunId(r.id);
                    }}
                  >
                    View
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {!formOpen ? (
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            Start new workflow
          </button>
        ) : (
          <form className="form" onSubmit={handleCreate}>
            <ErrorBanner message={createError} />
            <label className="field">
              <span>Industry</span>
              <input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. saas" />
            </label>
            <label className="field">
              <span>Target audience</span>
              <input
                value={targetAudience}
                onChange={(e) => setTargetAudience(e.target.value)}
                placeholder="e.g. mid-market B2B marketing teams"
              />
            </label>
            <label className="field">
              <span>Budget</span>
              <input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. $5,000/month" />
            </label>
            <label className="field">
              <span>Goals</span>
              <input
                value={goals}
                onChange={(e) => setGoals(e.target.value)}
                placeholder="e.g. 20 qualified leads per month"
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? "Starting..." : "Start workflow"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      {selectedRunId ? (
        <section className="panel">
          <h2>Workflow run</h2>
          <p className="muted">
            <code>{selectedRunId}</code>
          </p>

          <ErrorBanner message={detailError} />

          {!selectedRun ? (
            <p className="muted">Loading...</p>
          ) : (
            <>
              <p>
                Status: <Badge tone={runStatusTone(selectedRun.status)}>{selectedRun.status}</Badge>
              </p>

              {pendingApproval ? (
                <div className="error-banner" role="alert">
                  This run is waiting on a human decision: {pendingApproval.entityIds.length}{" "}
                  {pendingApproval.entityType} ({pendingApproval.entityIds.join(", ")}) are pending approval.
                  Approve or reject them on the project screen, then come back and advance this workflow.{" "}
                  <a href={`/tenants/${tenantId}/projects/${projectId}`}>Go to project</a>
                </div>
              ) : null}

              <ul className="card-list card-list-static">
                {WORKFLOW_STAGES.map((stage) => {
                  const result = byStage[stage];
                  const isCurrent = selectedRun.current_stage === stage && selectedRun.status !== "completed";
                  return (
                    <li
                      key={stage}
                      className="card-list-item card-list-item-static"
                      style={isCurrent ? { borderLeft: "4px solid var(--accent, #2563eb)" } : undefined}
                    >
                      <div>
                        <strong>{STAGE_LABELS[stage]}</strong>
                        {isCurrent ? <span className="muted"> · current stage</span> : null}
                        {result ? <p className="muted">{result.summary}</p> : <p className="muted">Not run yet.</p>}
                      </div>
                      {result ? <Badge tone={stageResultStatusTone(result.status)}>{result.status}</Badge> : null}
                    </li>
                  );
                })}
              </ul>

              <ErrorBanner message={advanceError} />
              <button
                type="button"
                className="btn btn-primary"
                disabled={advancing || selectedRun.status === "completed" || selectedRun.status === "failed"}
                onClick={handleAdvance}
              >
                {advancing
                  ? "Advancing..."
                  : selectedRun.status === "completed"
                    ? "Workflow complete"
                    : selectedRun.status === "failed"
                      ? "Workflow failed"
                      : "Advance"}
              </button>
            </>
          )}
        </section>
      ) : null}
    </Layout>
  );
}
