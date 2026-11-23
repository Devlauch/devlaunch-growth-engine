import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

interface ExperimentVariant {
  key: string;
  label: string;
  weight: number;
}

type ExperimentStatus = "draft" | "running" | "concluded" | "abandoned";

interface GrowthExperiment {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  hypothesis: string | null;
  target_entity_type: "landing_page" | "form" | "email_subject" | "cta";
  target_entity_id: string;
  status: ExperimentStatus;
  variants: ExperimentVariant[];
  primary_metric_event: string;
  min_sample_size: number;
  started_at: string | null;
  concluded_at: string | null;
  winning_variant_key: string | null;
  created_at: string;
}

interface VariantStats {
  variantKey: string;
  label: string;
  exposures: number;
  conversions: number;
  conversionRate: number;
}

interface EvaluationResult {
  experimentId: string;
  sampleSize: number;
  minSampleSize: number;
  variantStats: VariantStats[];
  controlVariantKey: string | null;
  bestVariantKey: string | null;
  zScore: number | null;
  pValue: number | null;
  isSignificant: boolean;
  reason?: string;
}

interface ApplyWinnerOutcome {
  action: { id: string; status: string };
  approval: { id: string; status: string };
  evaluation: EvaluationResult;
}

function StatusBadge({ status }: { status: ExperimentStatus }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export function GrowthExperimentsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [experiments, setExperiments] = useState<GrowthExperiment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [evaluations, setEvaluations] = useState<Record<string, EvaluationResult>>({});
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ experimentId: string; outcome: ApplyWinnerOutcome } | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const projectRes = await api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`);
      const experimentsRes = await api.get<{ experiments: GrowthExperiment[] }>(
        `/tenants/${tenantId}/projects/${projectId}/growth-experiments`,
      );
      setProject(projectRes.project);
      setExperiments(experimentsRes.experiments);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load growth experiments.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const evaluate = useCallback(
    async (experimentId: string) => {
      if (!tenantId || !projectId) return;
      setEvaluatingId(experimentId);
      setEvalError(null);
      try {
        const res = await api.get<{ evaluation: EvaluationResult }>(
          `/tenants/${tenantId}/projects/${projectId}/growth-experiments/${experimentId}/evaluate`,
        );
        setEvaluations((prev) => ({ ...prev, [experimentId]: res.evaluation }));
      } catch (err) {
        setEvalError(err instanceof ApiError ? err.message : "Could not evaluate this experiment.");
      } finally {
        setEvaluatingId(null);
      }
    },
    [tenantId, projectId],
  );

  const applyWinner = useCallback(
    async (experimentId: string) => {
      if (!tenantId || !projectId) return;
      setApplyingId(experimentId);
      setApplyError(null);
      setApplyResult(null);
      try {
        const outcome = await api.post<ApplyWinnerOutcome>(
          `/tenants/${tenantId}/projects/${projectId}/growth-experiments/${experimentId}/apply-winner`,
          {},
        );
        setApplyResult({ experimentId, outcome });
        await load();
      } catch (err) {
        setApplyError(err instanceof ApiError ? err.message : "Could not apply a winner for this experiment.");
      } finally {
        setApplyingId(null);
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
        { label: "Growth Experiments" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Growth Experiments</h1>
        <p className="muted">
          A real A/B testing engine: deterministic per-visitor variant assignment, and a genuine two-proportion
          z-test before any winner is ever declared. An experiment never reports significance below its configured
          minimum sample size, no matter how large the observed gap looks. Applying a winner never rewrites the
          live landing page/CTA directly -- it only drafts a request in the existing Approvals queue.
        </p>
      </section>

      {experiments === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : experiments.length === 0 ? (
        <section className="panel">
          <EmptyState
            title="No growth experiments yet"
            hint="Create one from the API (POST .../growth-experiments) to start an A/B test on a landing page, form, email subject line, or CTA."
          />
        </section>
      ) : (
        <section className="panel">
          <h2>Experiments</h2>
          <ErrorBanner message={evalError} />
          <ErrorBanner message={applyError} />
          <div className="list">
            {experiments.map((exp) => {
              const evaluation = evaluations[exp.id];
              return (
                <article key={exp.id} className="card">
                  <header style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <strong>{exp.name}</strong>
                    <StatusBadge status={exp.status} />
                    <span className="badge">{exp.target_entity_type}</span>
                  </header>
                  {exp.hypothesis ? <p>{exp.hypothesis}</p> : null}
                  <p className="muted">
                    Primary metric: <code>{exp.primary_metric_event}</code> -- min sample size{" "}
                    {exp.min_sample_size.toLocaleString()}
                    {exp.winning_variant_key ? (
                      <>
                        {" "}
                        -- winner: <strong>{exp.winning_variant_key}</strong>
                      </>
                    ) : null}
                  </p>

                  <table className="table">
                    <thead>
                      <tr>
                        <th>Variant</th>
                        <th>Weight</th>
                        <th>Exposures</th>
                        <th>Conversions</th>
                        <th>Conversion rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exp.variants.map((variant) => {
                        const stats = evaluation?.variantStats.find((v) => v.variantKey === variant.key);
                        return (
                          <tr key={variant.key}>
                            <td>
                              {variant.label}
                              {evaluation?.controlVariantKey === variant.key ? " (control)" : ""}
                              {evaluation?.bestVariantKey === variant.key ? " (winner)" : ""}
                            </td>
                            <td>{variant.weight}</td>
                            <td>{stats?.exposures ?? "--"}</td>
                            <td>{stats?.conversions ?? "--"}</td>
                            <td>{stats ? `${(stats.conversionRate * 100).toFixed(2)}%` : "--"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {evaluation ? (
                    <p className={evaluation.isSignificant ? "panel-note" : "muted"}>
                      {evaluation.isSignificant
                        ? `Statistically significant (p=${evaluation.pValue?.toFixed(4)}, n=${evaluation.sampleSize}).`
                        : evaluation.reason === "insufficient_sample_size"
                          ? `Not yet significant -- sample size ${evaluation.sampleSize} is below the configured minimum ${evaluation.minSampleSize}.`
                          : `Not yet significant (${evaluation.reason ?? "no clear winner yet"}).`}
                    </p>
                  ) : null}

                  <div className="form-row">
                    <button type="button" onClick={() => evaluate(exp.id)} disabled={evaluatingId === exp.id}>
                      {evaluatingId === exp.id ? "Evaluating..." : "Evaluate significance"}
                    </button>
                    {exp.status === "running" && evaluation?.isSignificant ? (
                      <button type="button" onClick={() => applyWinner(exp.id)} disabled={applyingId === exp.id}>
                        {applyingId === exp.id ? "Requesting..." : "Apply winner"}
                      </button>
                    ) : null}
                  </div>

                  {applyResult?.experimentId === exp.id ? (
                    <div className="panel-note">
                      Prepared action <code>{applyResult.outcome.action.id}</code> -- approval{" "}
                      <code>{applyResult.outcome.approval.id}</code> is now pending in the Approvals queue. Nothing
                      is rewritten on the live page until a human approves it there.
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </Layout>
  );
}

export default GrowthExperimentsPage;
