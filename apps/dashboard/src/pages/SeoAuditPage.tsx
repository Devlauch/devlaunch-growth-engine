import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local interfaces (deliberately not added to ../api/types.ts): shapes
// returned by apps/api/src/routes/seo.ts, mirroring the seo_audits /
// seo_audit_issues / keyword_rankings tables exactly.

interface CoreWebVitalsData {
  lcp?: string;
  cls?: string;
  inp?: string;
  performanceScore?: number;
  checkedAt?: string;
  error?: string;
}

interface SeoAudit {
  id: string;
  tenant_id: string;
  project_id: string;
  domain: string;
  audited_at: string;
  sitemap_found: boolean;
  robots_found: boolean;
  pages_checked: number;
  broken_links_count: number;
  missing_meta_count: number;
  core_web_vitals: CoreWebVitalsData | null;
  core_web_vitals_status: "ok" | "not_configured" | "error";
  created_at: string;
}

interface SeoAuditIssue {
  id: string;
  audit_id: string;
  issue_type:
    | "broken_link"
    | "missing_title"
    | "missing_meta_description"
    | "title_too_long"
    | "meta_description_too_long"
    | "missing_sitemap"
    | "missing_robots";
  url: string;
  detail: string;
  severity: "low" | "medium" | "high";
  created_at: string;
}

interface KeywordRanking {
  id: string;
  project_id: string;
  keyword: string;
  position: number | null;
  source: string;
  checked_at: string;
}

// Local shapes for apps/api/src/routes/seoCampaigns.ts and
// ../lib/keywordClustering.ts/internalLinking.ts — deliberately not added
// to ../api/types.ts, same file-boundary convention as the interfaces
// above.
interface KeywordClusterItem {
  keyword: string;
  frequency: number;
}

interface KeywordCluster {
  clusterKey: string;
  label: string;
  keywords: KeywordClusterItem[];
  totalFrequency: number;
}

interface SeoCampaign {
  id: string;
  name: string;
  domain: string | null;
  target_keywords: string[];
  status: "active" | "paused" | "completed";
  created_at: string;
}

interface InternalLinkSuggestion {
  fromUrl: string;
  toUrl: string;
  clusterLabel: string;
  sharedKeywords: string[];
  reason: string;
  matchesCampaign: boolean;
}

function severityTone(severity: SeoAuditIssue["severity"]): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (severity) {
    case "high":
      return "danger";
    case "medium":
      return "warn";
    default:
      return "neutral";
  }
}

export function SeoAuditPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [audits, setAudits] = useState<SeoAudit[] | null>(null);
  const [rankings, setRankings] = useState<KeywordRanking[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);
  const [selectedIssues, setSelectedIssues] = useState<SeoAuditIssue[] | null>(null);
  const [selectedRecommendations, setSelectedRecommendations] = useState<string[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [domain, setDomain] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [keyword, setKeyword] = useState("");
  const [trackingKeyword, setTrackingKeyword] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);

  // SEO campaigns + keyword clustering
  const [clusters, setClusters] = useState<KeywordCluster[] | null>(null);
  const [clustersNote, setClustersNote] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<SeoCampaign[] | null>(null);
  const [campaignName, setCampaignName] = useState("");
  const [selectedClusterKey, setSelectedClusterKey] = useState<string>("");
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [campaignError, setCampaignError] = useState<string | null>(null);

  // Internal link suggestions
  const [linkSuggestions, setLinkSuggestions] = useState<InternalLinkSuggestion[] | null>(null);
  const [linkSuggestDomain, setLinkSuggestDomain] = useState("");
  const [loadingLinkSuggestions, setLoadingLinkSuggestions] = useState(false);
  const [linkSuggestError, setLinkSuggestError] = useState<string | null>(null);
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, auditsRes, rankingsRes, clustersRes, campaignsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ audits: SeoAudit[] }>(`/tenants/${tenantId}/projects/${projectId}/seo/audits`),
        api.get<{ keywordRankings: KeywordRanking[] }>(
          `/tenants/${tenantId}/projects/${projectId}/seo/keyword-rankings`,
        ),
        api.get<{ clusters: KeywordCluster[]; note: string }>(
          `/tenants/${tenantId}/projects/${projectId}/seo-campaigns/keyword-clusters`,
        ),
        api.get<{ campaigns: SeoCampaign[] }>(`/tenants/${tenantId}/projects/${projectId}/seo-campaigns`),
      ]);
      setProject(projectRes.project);
      setAudits(auditsRes.audits);
      setRankings(rankingsRes.keywordRankings);
      setClusters(clustersRes.clusters);
      setClustersNote(clustersRes.note);
      setCampaigns(campaignsRes.campaigns);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load SEO data for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreateCampaign(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCampaignError(null);
    setCreatingCampaign(true);
    try {
      const res = await api.post<{ campaign: SeoCampaign }>(
        `/tenants/${tenantId}/projects/${projectId}/seo-campaigns`,
        { name: campaignName.trim(), clusterKey: selectedClusterKey },
      );
      setCampaigns((prev) => [res.campaign, ...(prev ?? [])]);
      setCampaignName("");
      setSelectedClusterKey("");
    } catch (err) {
      setCampaignError(err instanceof ApiError ? err.message : "Could not create this SEO campaign.");
    } finally {
      setCreatingCampaign(false);
    }
  }

  async function handleGetLinkSuggestions(campaignId: string, e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setLinkSuggestError(null);
    setLinkSuggestions(null);
    setActiveCampaignId(campaignId);
    setLoadingLinkSuggestions(true);
    try {
      const res = await api.post<{ suggestions: InternalLinkSuggestion[]; pagesCrawled: number }>(
        `/tenants/${tenantId}/projects/${projectId}/seo-campaigns/${campaignId}/internal-link-suggestions`,
        linkSuggestDomain.trim() ? { domain: linkSuggestDomain.trim() } : {},
      );
      setLinkSuggestions(res.suggestions);
    } catch (err) {
      setLinkSuggestError(
        err instanceof ApiError ? err.message : "Could not compute internal-linking suggestions.",
      );
    } finally {
      setLoadingLinkSuggestions(false);
    }
  }

  const loadAuditDetail = useCallback(
    async (auditId: string) => {
      if (!tenantId || !projectId) return;
      setDetailError(null);
      try {
        const res = await api.get<{ audit: SeoAudit; issues: SeoAuditIssue[]; recommendations: string[] }>(
          `/tenants/${tenantId}/projects/${projectId}/seo/audits/${auditId}`,
        );
        setSelectedAuditId(auditId);
        setSelectedIssues(res.issues);
        setSelectedRecommendations(res.recommendations);
      } catch (err) {
        setDetailError(err instanceof ApiError ? err.message : "Could not load this audit's details.");
      }
    },
    [tenantId, projectId],
  );

  async function handleRunAudit(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setRunError(null);
    setRunning(true);
    try {
      const res = await api.post<{ audit: SeoAudit; issues: SeoAuditIssue[]; recommendations: string[] }>(
        `/tenants/${tenantId}/projects/${projectId}/seo/audits`,
        { domain: domain.trim() },
      );
      setDomain("");
      await load();
      setSelectedAuditId(res.audit.id);
      setSelectedIssues(res.issues);
      setSelectedRecommendations(res.recommendations);
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not run this SEO audit.");
    } finally {
      setRunning(false);
    }
  }

  async function handleTrackKeyword(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setTrackError(null);
    setTrackingKeyword(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/seo/keyword-rankings`, { keyword: keyword.trim() });
      setKeyword("");
      await load();
    } catch (err) {
      setTrackError(err instanceof ApiError ? err.message : "Could not record this keyword.");
    } finally {
      setTrackingKeyword(false);
    }
  }

  const selectedAudit = audits?.find((a) => a.id === selectedAuditId) ?? null;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Technical SEO" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Technical SEO audits</h1>
        <p className="callout">
          Runs a real, zero-external-account audit: fetches sitemap.xml and robots.txt, HEAD-checks every sitemap URL
          (or the homepage if no sitemap is found) for broken links, and checks each page's title/meta description for
          missing or over-length values. Core Web Vitals come from Google PageSpeed Insights when configured — never
          fabricated.
        </p>

        <form className="form" onSubmit={handleRunAudit}>
          <ErrorBanner message={runError} />
          <label className="field">
            <span>Domain</span>
            <input
              required
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="e.g. example.com"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={running}>
              {running ? "Running audit..." : "Run audit"}
            </button>
          </div>
        </form>

        <h2>Audit history</h2>
        {audits === null ? (
          <p className="muted">Loading...</p>
        ) : audits.length === 0 ? (
          <EmptyState title="No audits yet" hint="Run an audit above to check a domain's technical SEO." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Audited</th>
                  <th>Sitemap</th>
                  <th>Robots.txt</th>
                  <th>Pages checked</th>
                  <th>Broken links</th>
                  <th>Missing meta</th>
                  <th>Core Web Vitals</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a) => (
                  <tr key={a.id}>
                    <td>{a.domain}</td>
                    <td>{new Date(a.audited_at).toLocaleString()}</td>
                    <td>
                      <Badge tone={a.sitemap_found ? "success" : "warn"}>{a.sitemap_found ? "found" : "missing"}</Badge>
                    </td>
                    <td>
                      <Badge tone={a.robots_found ? "success" : "warn"}>{a.robots_found ? "found" : "missing"}</Badge>
                    </td>
                    <td>{a.pages_checked}</td>
                    <td>{a.broken_links_count}</td>
                    <td>{a.missing_meta_count}</td>
                    <td>
                      <Badge
                        tone={
                          a.core_web_vitals_status === "ok"
                            ? "success"
                            : a.core_web_vitals_status === "error"
                              ? "danger"
                              : "neutral"
                        }
                      >
                        {a.core_web_vitals_status === "ok"
                          ? "checked"
                          : a.core_web_vitals_status === "error"
                            ? "error"
                            : "not configured"}
                      </Badge>
                    </td>
                    <td>
                      <button type="button" className="btn btn-secondary btn-small" onClick={() => loadAuditDetail(a.id)}>
                        View details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedAudit ? (
        <section className="panel">
          <h2>Audit details: {selectedAudit.domain}</h2>
          <ErrorBanner message={detailError} />

          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>Core Web Vitals</h3>
            {selectedAudit.core_web_vitals_status === "not_configured" ? (
              <p className="muted">
                Not configured — add <code>GOOGLE_PAGESPEED_API_KEY</code> to the API environment to enable real
                Core Web Vitals checks via Google PageSpeed Insights.
              </p>
            ) : selectedAudit.core_web_vitals_status === "error" ? (
              <p className="muted">Last check failed: {selectedAudit.core_web_vitals?.error ?? "unknown error"}</p>
            ) : (
              <ul>
                <li>LCP (Largest Contentful Paint): {selectedAudit.core_web_vitals?.lcp ?? "—"}</li>
                <li>CLS (Cumulative Layout Shift): {selectedAudit.core_web_vitals?.cls ?? "—"}</li>
                <li>INP (Interaction to Next Paint): {selectedAudit.core_web_vitals?.inp ?? "—"}</li>
                <li>
                  Performance score:{" "}
                  {typeof selectedAudit.core_web_vitals?.performanceScore === "number"
                    ? `${Math.round(selectedAudit.core_web_vitals.performanceScore * 100)}/100`
                    : "—"}
                </li>
              </ul>
            )}
          </div>

          <h3>Recommendations</h3>
          {selectedRecommendations && selectedRecommendations.length > 0 ? (
            <ul>
              {selectedRecommendations.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No recommendations.</p>
          )}

          <h3>Issues</h3>
          {selectedIssues === null ? (
            <p className="muted">Loading...</p>
          ) : selectedIssues.length === 0 ? (
            <EmptyState title="No issues found" hint="This audit found a clean site — no broken links or metadata issues." />
          ) : (
            (["high", "medium", "low"] as const).map((severity) => {
              const group = selectedIssues.filter((i) => i.severity === severity);
              if (group.length === 0) return null;
              return (
                <div key={severity} className="table-wrap" style={{ marginBottom: 16 }}>
                  <h4>
                    <Badge tone={severityTone(severity)}>{severity}</Badge> severity ({group.length})
                  </h4>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>URL</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.map((issue) => (
                        <tr key={issue.id}>
                          <td>{issue.issue_type}</td>
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
              );
            })
          )}
        </section>
      ) : null}

      <section className="panel">
        <h2>Keyword rank tracking</h2>
        <p className="callout">
          Keyword SERP position tracking genuinely requires a paid provider (e.g. SEMrush, Ahrefs, DataForSEO) that
          isn't configured in this environment. Recording a keyword below saves the request honestly — it will never
          show a fabricated ranking position.
        </p>

        <form className="form" onSubmit={handleTrackKeyword}>
          <ErrorBanner message={trackError} />
          <label className="field">
            <span>Keyword</span>
            <input
              required
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="e.g. growth marketing agency"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={trackingKeyword}>
              {trackingKeyword ? "Recording..." : "Track keyword"}
            </button>
          </div>
        </form>

        {rankings === null ? (
          <p className="muted">Loading...</p>
        ) : rankings.length === 0 ? (
          <EmptyState title="No keywords tracked yet" hint="Track a keyword above to start a ranking history." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Keyword</th>
                  <th>Position</th>
                  <th>Source</th>
                  <th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {rankings.map((r) => (
                  <tr key={r.id}>
                    <td>{r.keyword}</td>
                    <td>
                      {r.position !== null ? (
                        r.position
                      ) : (
                        <Badge tone="neutral">not configured</Badge>
                      )}
                    </td>
                    <td>{r.source}</td>
                    <td>{new Date(r.checked_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Keyword clusters</h2>
        <p className="callout">
          Groups this project's own real, already-extracted keywords (from the Growth Analyzer's crawl) using a
          deterministic stem + shared-substring heuristic — never an embedding/ML model. {clustersNote ?? ""}
        </p>
        {clusters === null ? (
          <p className="muted">Loading...</p>
        ) : clusters.length === 0 ? (
          <EmptyState
            title="No keyword clusters yet"
            hint="Run a Growth Analyzer analysis for this project to extract real keywords to cluster."
          />
        ) : (
          <ul className="card-list card-list-static">
            {clusters.map((c) => (
              <li key={c.clusterKey} className="card-list-item-static">
                <strong>{c.label}</strong>
                <span className="muted"> · {c.keywords.length} keyword(s), total frequency {c.totalFrequency}</span>
                <div>{c.keywords.map((k) => k.keyword).join(", ")}</div>
              </li>
            ))}
          </ul>
        )}

        <h2>SEO campaigns</h2>
        <p className="callout">
          Pick a keyword cluster above to start tracking real content-publishing and technical-SEO progress against
          it over time.
        </p>
        <form className="form" onSubmit={handleCreateCampaign}>
          <ErrorBanner message={campaignError} />
          <label className="field">
            <span>Campaign name</span>
            <input required value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
          </label>
          <label className="field">
            <span>Target cluster</span>
            <select required value={selectedClusterKey} onChange={(e) => setSelectedClusterKey(e.target.value)}>
              <option value="">Choose a cluster...</option>
              {(clusters ?? []).map((c) => (
                <option key={c.clusterKey} value={c.clusterKey}>
                  {c.label} ({c.keywords.length} keywords)
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={creatingCampaign || !selectedClusterKey}>
              {creatingCampaign ? "Creating..." : "Create campaign"}
            </button>
          </div>
        </form>

        {campaigns === null ? (
          <p className="muted">Loading...</p>
        ) : campaigns.length === 0 ? (
          <EmptyState title="No SEO campaigns yet" hint="Create one above from a keyword cluster." />
        ) : (
          <ul className="card-list card-list-static">
            {campaigns.map((c) => (
              <li key={c.id} className="card-list-item-static" style={{ display: "block" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                  <strong>{c.name}</strong>
                  <Badge tone={c.status === "active" ? "success" : c.status === "paused" ? "warn" : "neutral"}>
                    {c.status}
                  </Badge>
                  <span className="muted">targets: {c.target_keywords.join(", ")}</span>
                </div>
                <form className="form" onSubmit={(e) => handleGetLinkSuggestions(c.id, e)}>
                  <label className="field">
                    <span>Domain (optional if the campaign already has one)</span>
                    <input
                      value={linkSuggestDomain}
                      onChange={(e) => setLinkSuggestDomain(e.target.value)}
                      placeholder={c.domain ?? "e.g. example.com"}
                    />
                  </label>
                  <div className="form-actions">
                    <button
                      type="submit"
                      className="btn btn-secondary btn-small"
                      disabled={loadingLinkSuggestions && activeCampaignId === c.id}
                    >
                      {loadingLinkSuggestions && activeCampaignId === c.id
                        ? "Analyzing..."
                        : "Get internal-link suggestions"}
                    </button>
                  </div>
                </form>

                {activeCampaignId === c.id && (
                  <>
                    <ErrorBanner message={linkSuggestError} />
                    {linkSuggestions === null ? null : linkSuggestions.length === 0 ? (
                      <EmptyState
                        title="No internal-link suggestions found"
                        hint="Either the crawled pages already link to each other, or no shared keyword clusters were found across pages."
                      />
                    ) : (
                      <div className="table-wrap">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>From</th>
                              <th>To</th>
                              <th>Shared cluster</th>
                              <th>Matches campaign</th>
                            </tr>
                          </thead>
                          <tbody>
                            {linkSuggestions.map((s, i) => (
                              <tr key={i}>
                                <td>{s.fromUrl}</td>
                                <td>{s.toUrl}</td>
                                <td>
                                  {s.clusterLabel} ({s.sharedKeywords.join(", ")})
                                </td>
                                <td>
                                  <Badge tone={s.matchesCampaign ? "success" : "neutral"}>
                                    {s.matchesCampaign ? "yes" : "no"}
                                  </Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Layout>
  );
}
