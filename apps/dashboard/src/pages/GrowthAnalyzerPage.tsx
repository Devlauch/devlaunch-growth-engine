import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local types for the AI Website Growth Analyzer (DevLaunch Growth Engine,
// feature 1). Kept here rather than in api/types.ts to avoid colliding with
// other pages/agents editing that shared file in parallel this round —
// shapes mirror apps/api/src/routes/growthAnalyzer.ts and packages/db
// migrations 260/261 exactly, nothing fabricated.

interface ExtractedKeyword {
  keyword: string;
  frequency: number;
}

interface SiteAuditIssue {
  issueType: string;
  url: string;
  detail: string;
  severity: "low" | "medium" | "high";
}

interface RecommendedIcp {
  industries: string[];
  geographies: string[];
  segments: string[];
  rationale: string;
}

interface ContentGap {
  competitorName: string;
  gapKeywords: string[];
}

type GrowthAnalysisStatus = "completed" | "partial" | "failed";

interface GrowthAnalysis {
  id: string;
  tenant_id: string;
  project_id: string;
  domain: string;
  status: GrowthAnalysisStatus;
  pages_discovered: number;
  pages_crawled: number;
  crawl_error: string | null;
  sitemap_found: boolean;
  robots_found: boolean;
  extracted_keywords: ExtractedKeyword[];
  products_services: string[];
  value_propositions: string[];
  target_audience_signals: string[];
  recommended_icp: RecommendedIcp;
  content_gaps: ContentGap[];
  conversion_opportunities: SiteAuditIssue[];
  growth_plan_summary: string;
  created_at: string;
}

type GrowthRecommendationType = "icp" | "content_gap" | "conversion_opportunity" | "competitor_opportunity";

interface GrowthRecommendation {
  id: string;
  growth_analysis_id: string;
  recommendation_type: GrowthRecommendationType;
  title: string;
  detail: Record<string, unknown>;
  accepted: boolean;
  accepted_at: string | null;
  accepted_icp_profile_id: string | null;
  created_at: string;
}

interface AnalyzeResult {
  analysis: GrowthAnalysis;
  recommendations: GrowthRecommendation[];
}

function statusTone(status: GrowthAnalysisStatus): "neutral" | "success" | "warn" | "danger" {
  switch (status) {
    case "completed":
      return "success";
    case "partial":
      return "warn";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function GrowthAnalyzerPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [analyses, setAnalyses] = useState<GrowthAnalysis[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [domain, setDomain] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<GrowthRecommendation[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, analysesRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ analyses: GrowthAnalysis[] }>(`/tenants/${tenantId}/projects/${projectId}/growth-analyses`),
      ]);
      setProject(projectRes.project);
      setAnalyses(analysesRes.analyses);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load growth analyses for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadDetail = useCallback(
    async (analysisId: string) => {
      if (!tenantId || !projectId) return;
      setDetailError(null);
      setDetailLoading(true);
      try {
        const detail = await api.get<{ analysis: GrowthAnalysis; recommendations: GrowthRecommendation[] }>(
          `/tenants/${tenantId}/projects/${projectId}/growth-analyses/${analysisId}`,
        );
        setRecommendations(detail.recommendations);
        setAnalyses((prev) => (prev ? prev.map((a) => (a.id === analysisId ? detail.analysis : a)) : prev));
      } catch (err) {
        setDetailError(err instanceof ApiError ? err.message : "Could not load this analysis's detail.");
      } finally {
        setDetailLoading(false);
      }
    },
    [tenantId, projectId],
  );

  async function handleAnalyze(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setAnalyzeError(null);
    setAnalyzing(true);
    try {
      const result = await api.post<AnalyzeResult>(`/tenants/${tenantId}/projects/${projectId}/growth-analyses/analyze`, {
        domain,
      });
      setDomain("");
      await load();
      setSelectedId(result.analysis.id);
      setRecommendations(result.recommendations);
    } catch (err) {
      setAnalyzeError(err instanceof ApiError ? err.message : "This analysis failed to run.");
    } finally {
      setAnalyzing(false);
    }
  }

  function handleSelect(analysisId: string) {
    setSelectedId(analysisId);
    setRecommendations(null);
    setAcceptError(null);
    loadDetail(analysisId);
  }

  async function handleAcceptIcp(analysisId: string, recommendationId: string) {
    if (!tenantId || !projectId) return;
    setAcceptError(null);
    setAcceptingId(recommendationId);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/growth-analyses/${analysisId}/accept-icp`, {
        recommendationId,
      });
      await loadDetail(analysisId);
    } catch (err) {
      setAcceptError(err instanceof ApiError ? err.message : "Could not accept this ICP suggestion.");
    } finally {
      setAcceptingId(null);
    }
  }

  const selectedAnalysis = analyses?.find((a) => a.id === selectedId) ?? null;
  const icpRecommendation = recommendations?.find((r) => r.recommendation_type === "icp") ?? null;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Growth analyzer" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>AI website growth analyzer</h1>
        <p className="callout">
          Crawls the client's whole website (sitemap-driven, via the same Crawl4AI service used elsewhere), then runs
          deterministic, non-LLM text-analysis heuristics to extract products/services, value propositions, and
          target-audience signals, and suggests a recommended ICP (industries/geographies/segments) you can accept
          into this project's ICP profiles. Content gaps are computed against this project's tracked competitors'
          real crawled keywords. If a site can't be reached, the result says so honestly — nothing is fabricated.
        </p>

        <form className="form" onSubmit={handleAnalyze}>
          <ErrorBanner message={analyzeError} />
          <label className="field">
            <span>Domain to analyze</span>
            <input
              required
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="e.g. client-site.com"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={analyzing}>
              {analyzing ? "Analyzing..." : "Run growth analysis"}
            </button>
          </div>
        </form>

        {analyses === null ? (
          <p className="muted">Loading...</p>
        ) : analyses.length === 0 ? (
          <EmptyState title="No analyses yet" hint="Run one above to get a growth plan for this project's site." />
        ) : (
          <ul className="card-list card-list-static">
            {analyses.map((a) => (
              <li key={a.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{a.domain}</strong>
                  <span className="muted"> · {new Date(a.created_at).toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => handleSelect(a.id)}>
                    {selectedId === a.id ? "Viewing" : "View growth plan"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedAnalysis ? (
        <section className="panel">
          <h2>Growth plan: {selectedAnalysis.domain}</h2>
          <ErrorBanner message={detailError} />

          {detailLoading ? (
            <p className="muted">Loading...</p>
          ) : (
            <>
              <p className="callout">{selectedAnalysis.growth_plan_summary}</p>
              {selectedAnalysis.crawl_error ? <ErrorBanner message={selectedAnalysis.crawl_error} /> : null}

              <h3>Recommended ICP</h3>
              <p>
                <strong>Industries:</strong>{" "}
                {selectedAnalysis.recommended_icp.industries.join(", ") || "none detected"}
                <br />
                <strong>Geographies:</strong> {selectedAnalysis.recommended_icp.geographies.join(", ")}
                <br />
                <strong>Segments:</strong> {selectedAnalysis.recommended_icp.segments.join(", ") || "none detected"}
              </p>
              <p className="muted">{selectedAnalysis.recommended_icp.rationale}</p>
              <ErrorBanner message={acceptError} />
              {icpRecommendation ? (
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={icpRecommendation.accepted || acceptingId === icpRecommendation.id}
                  onClick={() => handleAcceptIcp(selectedAnalysis.id, icpRecommendation.id)}
                >
                  {icpRecommendation.accepted
                    ? "Accepted into ICP profiles"
                    : acceptingId === icpRecommendation.id
                      ? "Accepting..."
                      : "Accept into ICP profiles"}
                </button>
              ) : null}

              <h3>Products / services signal</h3>
              {selectedAnalysis.products_services.length === 0 ? (
                <EmptyState title="No recurring product/service terms extracted" />
              ) : (
                <ul className="card-list card-list-static">
                  {selectedAnalysis.products_services.map((term) => (
                    <li key={term} className="card-list-item card-list-item-static">
                      <span>{term}</span>
                    </li>
                  ))}
                </ul>
              )}

              <h3>Value propositions found on the site</h3>
              {selectedAnalysis.value_propositions.length === 0 ? (
                <EmptyState title="No explicit value-proposition language detected" />
              ) : (
                <ul>
                  {selectedAnalysis.value_propositions.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              )}

              <h3>Content gaps vs. tracked competitors</h3>
              {selectedAnalysis.content_gaps.length === 0 ? (
                <EmptyState title="No content gaps found" hint="Track and crawl competitors to compare recurring terms." />
              ) : (
                <ul className="card-list card-list-static">
                  {selectedAnalysis.content_gaps.map((gap) => (
                    <li key={gap.competitorName} className="card-list-item card-list-item-static">
                      <div>
                        <strong>{gap.competitorName}</strong>
                      </div>
                      <div className="muted">{gap.gapKeywords.join(", ")}</div>
                    </li>
                  ))}
                </ul>
              )}

              <h3>Conversion-opportunity notes</h3>
              {selectedAnalysis.conversion_opportunities.length === 0 ? (
                <EmptyState title="No technical conversion issues found" />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Severity</th>
                        <th>Issue</th>
                        <th>Page</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedAnalysis.conversion_opportunities.map((issue, i) => (
                        <tr key={i}>
                          <td>
                            <Badge tone={issue.severity === "high" ? "danger" : issue.severity === "medium" ? "warn" : "neutral"}>
                              {issue.severity}
                            </Badge>
                          </td>
                          <td>{issue.issueType}</td>
                          <td>
                            <a href={issue.url} target="_blank" rel="noreferrer">
                              {issue.url}
                            </a>
                          </td>
                          <td>{issue.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      ) : null}
    </Layout>
  );
}
