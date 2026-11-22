import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local types for this page only (api/types.ts is left untouched — see
// STRICT FILE BOUNDARIES). These mirror the real response shapes returned
// by apps/api/src/routes/marketingIntelligence.ts.

interface QaLogEntry {
  id: string;
  question: string;
  matched_intent: string | null;
  answer_summary: string;
  created_at: string;
}

interface MarketingReport {
  id: string;
  period_type: "weekly" | "monthly";
  period_start: string;
  period_end: string;
  summary_data: Record<string, unknown>;
  generated_at: string;
}

// Mirrors the exact fallback-question list built from marketingQa.ts's
// INTENTS array — shown so a user never hits a confusing "unsupported"
// dead end; this is the real, fixed set of question types this deterministic
// classifier (not an LLM) can honestly answer today.
const SUPPORTED_QUESTIONS = [
  "how many leads do we have",
  "why did leads drop",
  "what's our top lead source",
  "what's our conversion rate",
  "what should I do next",
];

export function MarketingIntelligencePage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- Ask a question ---
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [lastAnswer, setLastAnswer] = useState<{ matchedIntent: string | null; answer: string } | null>(null);
  const [qaLog, setQaLog] = useState<QaLogEntry[] | null>(null);

  // --- Reports ---
  const [reports, setReports] = useState<MarketingReport[] | null>(null);
  const [generating, setGenerating] = useState<"weekly" | "monthly" | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);

  // --- Next best actions ---
  const [actions, setActions] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, qaLogRes, reportsRes, actionsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ qaLog: QaLogEntry[] }>(`/tenants/${tenantId}/projects/${projectId}/marketing-intelligence/qa-log`),
        api.get<{ reports: MarketingReport[] }>(
          `/tenants/${tenantId}/projects/${projectId}/marketing-intelligence/reports`,
        ),
        api.get<{ actions: string[] }>(
          `/tenants/${tenantId}/projects/${projectId}/marketing-intelligence/next-best-actions`,
        ),
      ]);
      setProject(projectRes.project);
      setQaLog(qaLogRes.qaLog);
      setReports(reportsRes.reports);
      setActions(actionsRes.actions);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load marketing intelligence for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAsk(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId || !question.trim()) return;
    setAskError(null);
    setAsking(true);
    try {
      const result = await api.post<{ matchedIntent: string | null; answer: string }>(
        `/tenants/${tenantId}/projects/${projectId}/marketing-intelligence/ask`,
        { question: question.trim() },
      );
      setLastAnswer(result);
      setQuestion("");
      const qaLogRes = await api.get<{ qaLog: QaLogEntry[] }>(
        `/tenants/${tenantId}/projects/${projectId}/marketing-intelligence/qa-log`,
      );
      setQaLog(qaLogRes.qaLog);
    } catch (err) {
      setAskError(err instanceof ApiError ? err.message : "Could not ask that question.");
    } finally {
      setAsking(false);
    }
  }

  async function handleGenerateReport(periodType: "weekly" | "monthly") {
    if (!tenantId || !projectId) return;
    setReportError(null);
    setGenerating(periodType);
    try {
      const now = new Date();
      let periodStart: string;
      if (periodType === "weekly") {
        const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
        periodStart = start.toISOString().slice(0, 10);
      } else {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        periodStart = start.toISOString().slice(0, 10);
      }
      const result = await api.post<{ report: MarketingReport }>(
        `/tenants/${tenantId}/projects/${projectId}/marketing-intelligence/reports`,
        { periodType, periodStart },
      );
      setExpandedReportId(result.report.id);
      await load();
    } catch (err) {
      setReportError(err instanceof ApiError ? err.message : "Could not generate that report.");
    } finally {
      setGenerating(null);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Marketing Intelligence" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Marketing Intelligence</h1>
        <p className="callout">
          Ask a question below in plain English. This is a deterministic question matcher (a fixed set of supported
          patterns), not a real AI/LLM — it only answers the question types listed, each backed by a real query
          against your real data. Anything else gets an honest "can't answer that yet" instead of a made-up answer.
        </p>

        <form className="form" onSubmit={handleAsk}>
          <ErrorBanner message={askError} />
          <label className="field">
            <span>Ask a question</span>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. how many leads do we have?"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={asking || !question.trim()}>
              {asking ? "Asking..." : "Ask"}
            </button>
          </div>
        </form>

        {lastAnswer ? (
          <div className="callout" style={{ marginTop: 12 }}>
            <Badge tone={lastAnswer.matchedIntent ? "success" : "warn"}>
              {lastAnswer.matchedIntent ? lastAnswer.matchedIntent : "unmatched"}
            </Badge>
            <p style={{ marginTop: 8 }}>{lastAnswer.answer}</p>
          </div>
        ) : null}

        <p className="muted" style={{ marginTop: 12 }}>
          Supported question types: {SUPPORTED_QUESTIONS.join(", ")}.
        </p>

        <h2>Question log</h2>
        {qaLog === null ? (
          <p className="muted">Loading...</p>
        ) : qaLog.length === 0 ? (
          <EmptyState title="No questions asked yet" hint="Every question asked above is logged here, matched or not." />
        ) : (
          <ul className="card-list card-list-static">
            {qaLog.map((entry) => (
              <li key={entry.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{entry.question}</strong>
                  <div className="muted">{entry.answer_summary}</div>
                </div>
                <Badge tone={entry.matched_intent ? "success" : "warn"}>
                  {entry.matched_intent ?? "unmatched"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Reports</h2>
        <ErrorBanner message={reportError} />
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={generating !== null}
            onClick={() => handleGenerateReport("weekly")}
          >
            {generating === "weekly" ? "Generating..." : "Generate weekly report"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={generating !== null}
            onClick={() => handleGenerateReport("monthly")}
          >
            {generating === "monthly" ? "Generating..." : "Generate monthly report"}
          </button>
        </div>

        {reports === null ? (
          <p className="muted">Loading...</p>
        ) : reports.length === 0 ? (
          <EmptyState title="No reports generated yet" hint="Generate a weekly or monthly report above." />
        ) : (
          <ul className="card-list card-list-static">
            {reports.map((report) => (
              <li key={report.id} className="card-list-item card-list-item-static" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <strong>
                      {report.period_type} report: {report.period_start} - {report.period_end}
                    </strong>
                    <span className="muted"> · generated {new Date(report.generated_at).toLocaleString()}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => setExpandedReportId(expandedReportId === report.id ? null : report.id)}
                  >
                    {expandedReportId === report.id ? "Hide" : "View"}
                  </button>
                </div>
                {expandedReportId === report.id ? (
                  <pre className="code-block">{JSON.stringify(report.summary_data, null, 2)}</pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Next best actions</h2>
        {actions === null ? (
          <p className="muted">Loading...</p>
        ) : actions.length === 0 ? (
          <EmptyState title="Nothing flagged right now" hint="Recommendations appear here as soon as a real condition is actually true." />
        ) : (
          <ul className="card-list card-list-static">
            {actions.map((action, idx) => (
              <li key={idx} className="card-list-item card-list-item-static">
                {action}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Layout>
  );
}
