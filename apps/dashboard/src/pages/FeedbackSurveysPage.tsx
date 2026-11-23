import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local shapes for apps/api/src/routes/surveys.ts, mirroring the
// surveys / survey_responses tables + surveyEngine.ts's dashboard return
// shapes exactly — same file-boundary convention as SeoAuditPage.tsx's own
// local interfaces (deliberately not added to ../api/types.ts).

type SurveyType = "multi_step_form" | "nps" | "csat" | "post_demo_feedback" | "qualification";
type SurveyStatus = "draft" | "active" | "archived";

interface Survey {
  id: string;
  name: string;
  type: SurveyType;
  status: SurveyStatus;
  questions: unknown[];
  created_at: string;
}

interface NpsResult {
  score: number;
  promoters: number;
  passives: number;
  detractors: number;
}

interface CsatResult {
  average: number;
  distribution: Record<number, number>;
  topBoxPercent: number;
}

interface AbandonmentFunnelStep {
  stepsAnswered: number;
  respondentsReachingStep: number;
  reachRate: number;
  dropOffRate: number;
}

interface AbandonmentStats {
  totalQuestions: number;
  totalStarted: number;
  totalCompleted: number;
  completionRate: number;
  funnel: AbandonmentFunnelStep[];
}

function surveyStatusTone(status: SurveyStatus): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "active":
      return "success";
    case "archived":
      return "neutral";
    default:
      return "info";
  }
}

function surveyTypeLabel(type: SurveyType): string {
  switch (type) {
    case "multi_step_form":
      return "Multi-step form";
    case "nps":
      return "NPS";
    case "csat":
      return "CSAT";
    case "post_demo_feedback":
      return "Post-demo feedback";
    default:
      return "Qualification";
  }
}

export function FeedbackSurveysPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [surveys, setSurveys] = useState<Survey[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<SurveyType>("nps");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [selectedSurveyId, setSelectedSurveyId] = useState<string | null>(null);
  const [nps, setNps] = useState<NpsResult | null>(null);
  const [csat, setCsat] = useState<CsatResult | null>(null);
  const [abandonment, setAbandonment] = useState<AbandonmentStats | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, surveysRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ surveys: Survey[] }>(`/tenants/${tenantId}/projects/${projectId}/surveys`),
      ]);
      setProject(projectRes.project);
      setSurveys(surveysRes.surveys);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load surveys for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadSurveyDetail = useCallback(
    async (surveyId: string) => {
      if (!tenantId || !projectId) return;
      setDetailError(null);
      setNps(null);
      setCsat(null);
      setAbandonment(null);
      try {
        const survey = surveys?.find((s) => s.id === surveyId);
        const requests: Promise<void>[] = [
          api
            .get<{ abandonment: AbandonmentStats }>(
              `/tenants/${tenantId}/projects/${projectId}/surveys/${surveyId}/abandonment`,
            )
            .then((res) => setAbandonment(res.abandonment)),
        ];
        if (survey?.type === "nps") {
          requests.push(
            api
              .get<{ nps: NpsResult }>(`/tenants/${tenantId}/projects/${projectId}/surveys/${surveyId}/nps`)
              .then((res) => setNps(res.nps)),
          );
        }
        if (survey?.type === "csat") {
          requests.push(
            api
              .get<{ csat: CsatResult }>(`/tenants/${tenantId}/projects/${projectId}/surveys/${surveyId}/csat`)
              .then((res) => setCsat(res.csat)),
          );
        }
        await Promise.all(requests);
      } catch (err) {
        setDetailError(err instanceof ApiError ? err.message : "Could not load this survey's dashboard.");
      }
    },
    [tenantId, projectId, surveys],
  );

  function handleSelect(surveyId: string) {
    setSelectedSurveyId(surveyId);
    void loadSurveyDetail(surveyId);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCreateError(null);
    setCreating(true);
    try {
      const res = await api.post<{ survey: Survey }>(`/tenants/${tenantId}/projects/${projectId}/surveys`, {
        name: name.trim(),
        type,
        questions: [],
      });
      setSurveys((prev) => [res.survey, ...(prev ?? [])]);
      setName("");
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this survey.");
    } finally {
      setCreating(false);
    }
  }

  const selectedSurvey = surveys?.find((s) => s.id === selectedSurveyId) ?? null;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Feedback & Surveys" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Feedback & surveys</h1>
        <p className="callout">
          Dynamic multi-step forms, NPS/CSAT surveys, and post-demo feedback — each backed by a real question schema
          with conditional branching (apps/api/src/lib/surveyEngine.ts), real NPS/CSAT math, and a real
          started-vs-completed abandonment funnel per question step.
        </p>

        <form className="form" onSubmit={handleCreate}>
          <ErrorBanner message={createError} />
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </label>
          <label className="field">
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as SurveyType)}>
              <option value="nps">NPS</option>
              <option value="csat">CSAT</option>
              <option value="multi_step_form">Multi-step form</option>
              <option value="post_demo_feedback">Post-demo feedback</option>
              <option value="qualification">Qualification</option>
            </select>
          </label>
          <button type="submit" disabled={creating || !name.trim()}>
            {creating ? "Creating..." : "Create survey"}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Surveys</h2>
        {surveys === null ? (
          <p>Loading...</p>
        ) : surveys.length === 0 ? (
          <EmptyState title="No surveys yet" hint="Create one above to start collecting NPS, CSAT, or form responses." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {surveys.map((survey) => (
                <tr
                  key={survey.id}
                  onClick={() => handleSelect(survey.id)}
                  style={{ cursor: "pointer", fontWeight: survey.id === selectedSurveyId ? 700 : 400 }}
                >
                  <td>{survey.name}</td>
                  <td>{surveyTypeLabel(survey.type)}</td>
                  <td>
                    <Badge tone={surveyStatusTone(survey.status)}>{survey.status}</Badge>
                  </td>
                  <td>{new Date(survey.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedSurvey ? (
        <section className="panel">
          <h2>{selectedSurvey.name}</h2>
          <ErrorBanner message={detailError} />

          {nps ? (
            <div className="metric-row">
              <div className="metric-tile">
                <span className="metric-label">NPS score</span>
                <span className="metric-value">{nps.score}</span>
              </div>
              <div className="metric-tile">
                <span className="metric-label">Promoters</span>
                <span className="metric-value">{nps.promoters}</span>
              </div>
              <div className="metric-tile">
                <span className="metric-label">Passives</span>
                <span className="metric-value">{nps.passives}</span>
              </div>
              <div className="metric-tile">
                <span className="metric-label">Detractors</span>
                <span className="metric-value">{nps.detractors}</span>
              </div>
            </div>
          ) : null}

          {csat ? (
            <div className="metric-row">
              <div className="metric-tile">
                <span className="metric-label">Average score</span>
                <span className="metric-value">{csat.average.toFixed(2)}</span>
              </div>
              <div className="metric-tile">
                <span className="metric-label">Top-box %</span>
                <span className="metric-value">{csat.topBoxPercent.toFixed(1)}%</span>
              </div>
            </div>
          ) : null}

          {abandonment ? (
            <div>
              <h3>Abandonment funnel</h3>
              <p className="callout">
                {abandonment.totalStarted} started, {abandonment.totalCompleted} completed (
                {(abandonment.completionRate * 100).toFixed(1)}% completion rate).
              </p>
              <table className="table">
                <thead>
                  <tr>
                    <th>Questions answered</th>
                    <th>Respondents reaching step</th>
                    <th>Reach rate</th>
                    <th>Drop-off at this step</th>
                  </tr>
                </thead>
                <tbody>
                  {abandonment.funnel.map((step) => (
                    <tr key={step.stepsAnswered}>
                      <td>{step.stepsAnswered}</td>
                      <td>{step.respondentsReachingStep}</td>
                      <td>{(step.reachRate * 100).toFixed(1)}%</td>
                      <td>{(step.dropOffRate * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </Layout>
  );
}
