import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";

/**
 * Phase 2 item 5, "Conversion Optimization Agent" dashboard page. Follows
 * DiscoveryPage.tsx's conventions: Layout/Badge/EmptyState/ErrorBanner,
 * local TS interfaces (not api/types.ts, which this build leaves untouched),
 * real empty/insufficient-data states instead of placeholders.
 */

interface Project {
  id: string;
  name: string;
}

interface LandingPageFinding {
  issue: string;
  detail: string;
  severity: "low" | "medium" | "high";
}

interface LandingPageAudit {
  id: string;
  url: string;
  audited_at: string;
  has_cta: boolean;
  has_form: boolean;
  word_count: number;
  heading_count: number;
  load_status: "ok" | "error" | "timeout";
  findings: LandingPageFinding[];
}

type FunnelStageName = "discovered" | "qualified" | "contacted" | "replied";

interface FunnelStageCount {
  stage: FunnelStageName;
  count: number;
}

interface FunnelStageDropoff {
  fromStage: FunnelStageName;
  toStage: FunnelStageName;
  dropoffPercent: number;
}

interface FunnelDropoffResult {
  stages: FunnelStageCount[];
  dropoffs: FunnelStageDropoff[];
}

interface ExperimentSuggestion {
  name: string;
  hypothesis: string;
  variantADescription: string;
  variantBDescription: string;
}

type ExperimentStatus = "suggested" | "running" | "completed" | "abandoned";

interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  variant_a_description: string;
  variant_b_description: string;
  status: ExperimentStatus;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface VariantTotals {
  visitors: number;
  conversions: number;
  conversionRate: number;
}

interface ExperimentResultsResponse {
  variants: { a: VariantTotals; b: VariantTotals };
  winner: "a" | "b" | null;
  note: string | null;
}

function severityTone(severity: LandingPageFinding["severity"]): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (severity) {
    case "high":
      return "danger";
    case "medium":
      return "warn";
    default:
      return "neutral";
  }
}

function statusToneFor(status: ExperimentStatus): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "running":
      return "info";
    case "completed":
      return "success";
    case "abandoned":
      return "neutral";
    default:
      return "warn";
  }
}

export function ConversionOptimizationPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [audits, setAudits] = useState<LandingPageAudit[] | null>(null);
  const [dropoff, setDropoff] = useState<FunnelDropoffResult | null>(null);
  const [suggestions, setSuggestions] = useState<ExperimentSuggestion[] | null>(null);
  const [experiments, setExperiments] = useState<Experiment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [auditUrl, setAuditUrl] = useState("");
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const [creatingFromSuggestion, setCreatingFromSuggestion] = useState<number | null>(null);
  const [createExperimentError, setCreateExperimentError] = useState<string | null>(null);

  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const [resultsByExperiment, setResultsByExperiment] = useState<Record<string, ExperimentResultsResponse>>({});
  const [recordFormOpenId, setRecordFormOpenId] = useState<string | null>(null);
  const [recordVariant, setRecordVariant] = useState<"a" | "b">("a");
  const [recordVisitors, setRecordVisitors] = useState("");
  const [recordConversions, setRecordConversions] = useState("");
  const [recordingResult, setRecordingResult] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  const base = `/tenants/${tenantId}/projects/${projectId}/conversion-optimization`;

  const loadResultsFor = useCallback(
    async (experimentId: string) => {
      try {
        const res = await api.get<ExperimentResultsResponse>(`${base}/experiments/${experimentId}/results`);
        setResultsByExperiment((prev) => ({ ...prev, [experimentId]: res }));
      } catch {
        // Non-fatal: the experiments table still renders without live results.
      }
    },
    [base],
  );

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, auditsRes, dropoffRes, suggestionsRes, experimentsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ audits: LandingPageAudit[] }>(`${base}/landing-page-audits`),
        api.get<FunnelDropoffResult>(`${base}/funnel-dropoff`),
        api.get<{ suggestions: ExperimentSuggestion[] }>(`${base}/experiment-suggestions`),
        api.get<{ experiments: Experiment[] }>(`${base}/experiments`),
      ]);
      setProject(projectRes.project);
      setAudits(auditsRes.audits);
      setDropoff(dropoffRes);
      setSuggestions(suggestionsRes.suggestions);
      setExperiments(experimentsRes.experiments);

      for (const exp of experimentsRes.experiments) {
        if (exp.status === "running" || exp.status === "completed") {
          void loadResultsFor(exp.id);
        }
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load conversion optimization data for this project.");
    }
  }, [tenantId, projectId, base, loadResultsFor]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, projectId]);

  async function handleAudit(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setAuditError(null);
    setAuditing(true);
    try {
      await api.post(`${base}/landing-page-audits`, { url: auditUrl });
      setAuditUrl("");
      await load();
    } catch (err) {
      setAuditError(err instanceof ApiError ? err.message : "Could not audit this landing page.");
    } finally {
      setAuditing(false);
    }
  }

  async function handleCreateFromSuggestion(index: number, suggestion: ExperimentSuggestion) {
    setCreateExperimentError(null);
    setCreatingFromSuggestion(index);
    try {
      await api.post(`${base}/experiments`, {
        name: suggestion.name,
        hypothesis: suggestion.hypothesis,
        variantADescription: suggestion.variantADescription,
        variantBDescription: suggestion.variantBDescription,
      });
      await load();
    } catch (err) {
      setCreateExperimentError(err instanceof ApiError ? err.message : "Could not create an experiment from this suggestion.");
    } finally {
      setCreatingFromSuggestion(null);
    }
  }

  async function handleTransition(experimentId: string, status: ExperimentStatus) {
    setTransitionError(null);
    setTransitioningId(experimentId);
    try {
      await api.patch(`${base}/experiments/${experimentId}`, { status });
      await load();
    } catch (err) {
      setTransitionError(err instanceof ApiError ? err.message : "Could not update this experiment's status.");
    } finally {
      setTransitioningId(null);
    }
  }

  async function handleRecordResult(e: FormEvent, experimentId: string) {
    e.preventDefault();
    setRecordError(null);
    setRecordingResult(true);
    try {
      await api.post(`${base}/experiments/${experimentId}/results`, {
        variant: recordVariant,
        visitors: Number(recordVisitors),
        conversions: Number(recordConversions),
      });
      setRecordVisitors("");
      setRecordConversions("");
      setRecordFormOpenId(null);
      await loadResultsFor(experimentId);
    } catch (err) {
      setRecordError(err instanceof ApiError ? err.message : "Could not record this experiment result.");
    } finally {
      setRecordingResult(false);
    }
  }

  const maxStageCount = dropoff ? Math.max(1, ...dropoff.stages.map((s) => s.count)) : 1;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Conversion Optimization" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Landing page audit</h1>
        <p className="callout">
          Fetches the page live and checks it with a simple, real regex heuristic for a conversion path (a CTA or a
          form) and basic content signals. A network failure or timeout is reported honestly, not faked.
        </p>

        <form className="form" onSubmit={handleAudit}>
          <ErrorBanner message={auditError} />
          <label className="field">
            <span>Landing page URL</span>
            <input
              required
              type="url"
              value={auditUrl}
              onChange={(e) => setAuditUrl(e.target.value)}
              placeholder="https://example.com/landing"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={auditing}>
              {auditing ? "Auditing..." : "Audit page"}
            </button>
          </div>
        </form>

        {audits === null ? (
          <p className="muted">Loading...</p>
        ) : audits.length === 0 ? (
          <EmptyState title="No landing page audits yet" hint="Audit a URL above to see its conversion findings." />
        ) : (
          <ul className="card-list card-list-static">
            {audits.map((audit) => (
              <li key={audit.id} className="card-list-item card-list-item-static" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <strong>{audit.url}</strong>
                    <span className="muted"> · {new Date(audit.audited_at).toLocaleString()}</span>
                  </div>
                  <Badge tone={audit.load_status === "ok" ? "success" : "danger"}>{audit.load_status}</Badge>
                </div>
                {audit.load_status === "ok" ? (
                  <p className="muted">
                    CTA: {audit.has_cta ? "yes" : "no"} · Form: {audit.has_form ? "yes" : "no"} · {audit.word_count} words ·{" "}
                    {audit.heading_count} heading(s)
                  </p>
                ) : (
                  <p className="muted">This fetch did not succeed — no content signals available for this attempt.</p>
                )}
                {audit.findings.length === 0 ? (
                  <p className="muted">No issues found.</p>
                ) : (
                  <ul>
                    {audit.findings.map((f, i) => (
                      <li key={i}>
                        <Badge tone={severityTone(f.severity)}>{f.severity}</Badge> {f.issue}: {f.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Funnel drop-off</h2>
        {dropoff === null ? (
          <p className="muted">Loading...</p>
        ) : dropoff.stages.every((s) => s.count === 0) ? (
          <EmptyState title="No funnel data yet" hint="Once leads flow through discovery/qualification/outreach, drop-off will show here." />
        ) : (
          <>
            <ul className="card-list card-list-static">
              {dropoff.stages.map((s) => (
                <li key={s.stage} className="card-list-item card-list-item-static">
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
                    <span style={{ width: 100, textTransform: "capitalize" }}>{s.stage}</span>
                    <div style={{ flex: 1, background: "var(--bg-muted, #eee)", borderRadius: 4, height: 10 }}>
                      <div
                        style={{
                          width: `${Math.max(2, (s.count / maxStageCount) * 100)}%`,
                          background: "var(--accent, #4a7)",
                          height: "100%",
                          borderRadius: 4,
                        }}
                      />
                    </div>
                    <strong>{s.count}</strong>
                  </div>
                </li>
              ))}
            </ul>
            <ul>
              {dropoff.dropoffs.map((d) => (
                <li key={`${d.fromStage}-${d.toStage}`} className="muted">
                  {d.fromStage} → {d.toStage}: {d.dropoffPercent.toFixed(1)}% drop-off
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Experiment suggestions</h2>
        <ErrorBanner message={createExperimentError} />
        {suggestions === null ? (
          <p className="muted">Loading...</p>
        ) : suggestions.length === 0 ? (
          <EmptyState
            title="No suggestions right now"
            hint="Nothing notable was found in the latest landing page audit or funnel drop-off — run an audit, or check back once more funnel data accumulates."
          />
        ) : (
          <ul className="card-list card-list-static">
            {suggestions.map((s, i) => (
              <li key={i} className="card-list-item card-list-item-static" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <strong>{s.name}</strong>
                <p className="muted">{s.hypothesis}</p>
                <p>
                  <strong>A:</strong> {s.variantADescription}
                </p>
                <p>
                  <strong>B:</strong> {s.variantBDescription}
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={creatingFromSuggestion === i}
                    onClick={() => handleCreateFromSuggestion(i, s)}
                  >
                    {creatingFromSuggestion === i ? "Creating..." : "Create experiment"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Experiments</h2>
        <ErrorBanner message={transitionError} />
        <ErrorBanner message={recordError} />
        {experiments === null ? (
          <p className="muted">Loading...</p>
        ) : experiments.length === 0 ? (
          <EmptyState title="No experiments yet" hint="Create one from a suggestion above, or once this list has entries, track them here." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Results</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {experiments.map((exp) => {
                  const results = resultsByExperiment[exp.id];
                  return (
                    <tr key={exp.id}>
                      <td>
                        <strong>{exp.name}</strong>
                        <p className="muted">{exp.hypothesis}</p>
                      </td>
                      <td>
                        <Badge tone={statusToneFor(exp.status)}>{exp.status}</Badge>
                      </td>
                      <td>
                        {!results ? (
                          <span className="muted">—</span>
                        ) : results.note ? (
                          <span className="muted">{results.note}</span>
                        ) : (
                          <span>
                            A: {(results.variants.a.conversionRate * 100).toFixed(1)}% ({results.variants.a.conversions}/
                            {results.variants.a.visitors}) · B: {(results.variants.b.conversionRate * 100).toFixed(1)}% (
                            {results.variants.b.conversions}/{results.variants.b.visitors})
                            {results.winner ? <strong> · {results.winner.toUpperCase()} ahead</strong> : null}
                          </span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {exp.status === "suggested" ? (
                            <button
                              type="button"
                              className="btn btn-secondary btn-small"
                              disabled={transitioningId === exp.id}
                              onClick={() => handleTransition(exp.id, "running")}
                            >
                              Start
                            </button>
                          ) : null}
                          {exp.status === "running" ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-secondary btn-small"
                                disabled={transitioningId === exp.id}
                                onClick={() => handleTransition(exp.id, "completed")}
                              >
                                Complete
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary btn-small"
                                disabled={transitioningId === exp.id}
                                onClick={() => setRecordFormOpenId(recordFormOpenId === exp.id ? null : exp.id)}
                              >
                                Record result
                              </button>
                            </>
                          ) : null}
                          {exp.status === "suggested" || exp.status === "running" ? (
                            <button
                              type="button"
                              className="btn btn-secondary btn-small"
                              disabled={transitioningId === exp.id}
                              onClick={() => handleTransition(exp.id, "abandoned")}
                            >
                              Abandon
                            </button>
                          ) : null}
                        </div>
                        {recordFormOpenId === exp.id ? (
                          <form className="form" onSubmit={(e) => handleRecordResult(e, exp.id)}>
                            <label className="field">
                              <span>Variant</span>
                              <select value={recordVariant} onChange={(e) => setRecordVariant(e.target.value as "a" | "b")}>
                                <option value="a">A</option>
                                <option value="b">B</option>
                              </select>
                            </label>
                            <label className="field">
                              <span>Visitors</span>
                              <input
                                required
                                type="number"
                                min={0}
                                value={recordVisitors}
                                onChange={(e) => setRecordVisitors(e.target.value)}
                              />
                            </label>
                            <label className="field">
                              <span>Conversions</span>
                              <input
                                required
                                type="number"
                                min={0}
                                value={recordConversions}
                                onChange={(e) => setRecordConversions(e.target.value)}
                              />
                            </label>
                            <div className="form-actions">
                              <button type="submit" className="btn btn-primary btn-small" disabled={recordingResult}>
                                {recordingResult ? "Saving..." : "Save result"}
                              </button>
                            </div>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Layout>
  );
}
