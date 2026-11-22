import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type {
  GrowthAdvisorAction,
  GrowthAdvisorPreparedApproval,
  GrowthAdvisorRecommendation,
  GrowthAdvisorRecommendationStatus,
  Project,
} from "../api/types";

// NOTE: this page is intentionally NOT wired into apps/dashboard/src/App.tsx
// (route) or apps/dashboard/src/components/Layout.tsx (nav link) by this
// change — both files are off-limits this round (another process wires
// pages in there to avoid merge conflicts). Once wired, this page is reached
// at a route like /tenants/:tenantId/projects/:projectId/growth-advisor.
//
// Every number/recommendation shown here comes from a real SQL rule run
// against this project's own data (apps/api/src/lib/growthAdvisor.ts) —
// never an LLM-narrated or invented "fact". The one action this page can
// trigger (auto-assign unassigned leads) only drafts a row in the existing
// `approvals` table; nothing is actually assigned until a human approves it
// elsewhere (the Approvals queue page).
const SEVERITY_LABEL: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge badge-${severity}`}>{SEVERITY_LABEL[severity] ?? severity}</span>;
}

export function GrowthAdvisorPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [recommendations, setRecommendations] = useState<GrowthAdvisorRecommendation[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<GrowthAdvisorRecommendationStatus | "">("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [actingId, setActingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preparedResult, setPreparedResult] = useState<{
    recommendationId: string;
    action: GrowthAdvisorAction;
    approval: GrowthAdvisorPreparedApproval;
  } | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const query = statusFilter ? `?status=${statusFilter}` : "";
      const [projectRes, recsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ recommendations: GrowthAdvisorRecommendation[] }>(
          `/tenants/${tenantId}/projects/${projectId}/growth-advisor/recommendations${query}`,
        ),
      ]);
      setProject(projectRes.project);
      setRecommendations(recsRes.recommendations);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load growth advisor recommendations.");
    }
  }, [tenantId, projectId, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const runAdvisor = useCallback(async () => {
    if (!tenantId || !projectId) return;
    setRunning(true);
    setRunError(null);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/growth-advisor/run`, {});
      await load();
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not run the growth advisor.");
    } finally {
      setRunning(false);
    }
  }, [tenantId, projectId, load]);

  const dismiss = useCallback(
    async (recommendationId: string) => {
      if (!tenantId || !projectId) return;
      setActingId(recommendationId);
      setActionError(null);
      try {
        await api.post(
          `/tenants/${tenantId}/projects/${projectId}/growth-advisor/recommendations/${recommendationId}/dismiss`,
          {},
        );
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : "Could not dismiss this recommendation.");
      } finally {
        setActingId(null);
      }
    },
    [tenantId, projectId, load],
  );

  const prepareAction = useCallback(
    async (recommendationId: string) => {
      if (!tenantId || !projectId) return;
      setActingId(recommendationId);
      setActionError(null);
      setPreparedResult(null);
      try {
        const res = await api.post<{ action: GrowthAdvisorAction; approval: GrowthAdvisorPreparedApproval }>(
          `/tenants/${tenantId}/projects/${projectId}/growth-advisor/recommendations/${recommendationId}/prepare-action`,
          {},
        );
        setPreparedResult({ recommendationId, action: res.action, approval: res.approval });
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : "Could not prepare this action.");
      } finally {
        setActingId(null);
      }
    },
    [tenantId, projectId, load],
  );

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Growth Advisor" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>AI Growth Advisor</h1>
        <p className="muted">
          A real, rule-based recommendation feed — every item here comes from a live SQL query against this
          project's own data (prospecting campaigns, leads, landing pages, deals, SEO audits), never an invented
          number. Dismiss what isn't actionable; prepare the one approval-gated action (auto-assign unassigned
          leads) and a human reviews it in the Approvals queue before anything real happens.
        </p>
        <div className="form-row">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as GrowthAdvisorRecommendationStatus | "")}>
            <option value="">All statuses</option>
            <option value="new">New</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="dismissed">Dismissed</option>
            <option value="actioned">Actioned</option>
          </select>
          <button type="button" onClick={runAdvisor} disabled={running}>
            {running ? "Running..." : "Run growth advisor now"}
          </button>
        </div>
        <ErrorBanner message={runError} />
      </section>

      {recommendations === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : recommendations.length === 0 ? (
        <section className="panel">
          <EmptyState
            title="No recommendations yet"
            hint="Click 'Run growth advisor now' above to evaluate this project's real data against every rule."
          />
        </section>
      ) : (
        <section className="panel">
          <h2>Recommendations</h2>
          <ErrorBanner message={actionError} />
          <div className="list">
            {recommendations.map((rec) => (
              <article key={rec.id} className="card">
                <header style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <IconZap />
                  <strong>{rec.title}</strong>
                  <SeverityBadge severity={rec.severity} />
                  <span className="badge">{rec.status}</span>
                </header>
                <p>{rec.description}</p>
                <details>
                  <summary>Evidence</summary>
                  <pre>{JSON.stringify(rec.evidence, null, 2)}</pre>
                </details>

                {rec.status !== "dismissed" ? (
                  <div className="form-row">
                    <button type="button" onClick={() => dismiss(rec.id)} disabled={actingId === rec.id}>
                      {actingId === rec.id ? "Working..." : "Dismiss"}
                    </button>
                    {rec.rule_key === "too_many_unassigned_leads" && rec.status !== "actioned" ? (
                      <button type="button" onClick={() => prepareAction(rec.id)} disabled={actingId === rec.id}>
                        {actingId === rec.id ? "Working..." : "Prepare auto-assign action"}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {preparedResult?.recommendationId === rec.id ? (
                  <div className="panel-note">
                    Prepared action <code>{preparedResult.action.id}</code> ({preparedResult.action.payload.leadIds.length}{" "}
                    lead(s)) — approval <code>{preparedResult.approval.id}</code> is now pending in the Approvals
                    queue. Nothing is assigned until a human approves it there.
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      )}
    </Layout>
  );
}

export default GrowthAdvisorPage;
