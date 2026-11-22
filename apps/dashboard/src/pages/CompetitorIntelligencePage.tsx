import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local types for Phase 2 item 1 ("Competitor Intelligence Agent"). Kept
// here rather than in api/types.ts to avoid colliding with other pages/
// agents editing that shared file in parallel this round — shapes mirror
// apps/api/src/routes/competitors.ts and packages/db migrations
// 066-069 exactly, nothing fabricated.

interface Competitor {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  domain: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface SnapshotPage {
  url: string;
  pageType: string;
  title?: string;
  extractedText: string;
  contentHash: string;
}

interface ExtractedKeyword {
  keyword: string;
  frequency: number;
}

interface CompetitorSnapshot {
  id: string;
  competitor_id: string;
  crawled_at: string;
  pages: SnapshotPage[];
  extracted_keywords: ExtractedKeyword[];
  raw_metadata: Record<string, unknown>;
  created_at: string;
}

type CompetitorChangeType = "new_page" | "content_changed" | "page_removed";

interface CompetitorChange {
  id: string;
  competitor_id: string;
  change_type: CompetitorChangeType;
  page_url: string;
  diff_summary: string;
  detected_at: string;
}

interface CompetitorCrawlResult {
  snapshot: CompetitorSnapshot;
  changesDetected: CompetitorChange[];
}

interface CompetitorReport {
  competitor: Competitor;
  latestSnapshot: CompetitorSnapshot | null;
  recentChanges: CompetitorChange[];
  topKeywords: ExtractedKeyword[];
  positioningSummary: string;
}

function changeTypeTone(changeType: CompetitorChangeType): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (changeType) {
    case "new_page":
      return "success";
    case "content_changed":
      return "info";
    case "page_removed":
      return "warn";
    default:
      return "neutral";
  }
}

export function CompetitorIntelligencePage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [competitors, setCompetitors] = useState<Competitor[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [notes, setNotes] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [crawlingId, setCrawlingId] = useState<string | null>(null);
  const [crawlError, setCrawlError] = useState<string | null>(null);
  const [lastCrawlResult, setLastCrawlResult] = useState<CompetitorCrawlResult | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [changes, setChanges] = useState<CompetitorChange[] | null>(null);
  const [report, setReport] = useState<CompetitorReport | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, competitorsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ competitors: Competitor[] }>(`/tenants/${tenantId}/projects/${projectId}/competitors`),
      ]);
      setProject(projectRes.project);
      setCompetitors(competitorsRes.competitors);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load competitors for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadDetail = useCallback(
    async (competitorId: string) => {
      if (!tenantId || !projectId) return;
      setDetailError(null);
      setDetailLoading(true);
      try {
        const [changesRes, reportRes] = await Promise.all([
          api.get<{ changes: CompetitorChange[] }>(
            `/tenants/${tenantId}/projects/${projectId}/competitors/${competitorId}/changes`,
          ),
          api.get<CompetitorReport>(`/tenants/${tenantId}/projects/${projectId}/competitors/${competitorId}/report`),
        ]);
        setChanges(changesRes.changes);
        setReport(reportRes);
      } catch (err) {
        setDetailError(err instanceof ApiError ? err.message : "Could not load this competitor's report.");
      } finally {
        setDetailLoading(false);
      }
    },
    [tenantId, projectId],
  );

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCreateError(null);
    setCreating(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/competitors`, {
        name,
        domain,
        notes: notes.trim() || undefined,
      });
      setName("");
      setDomain("");
      setNotes("");
      setFormOpen(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this competitor.");
    } finally {
      setCreating(false);
    }
  }

  async function handleCrawl(competitorId: string) {
    if (!tenantId || !projectId) return;
    setCrawlError(null);
    setLastCrawlResult(null);
    setCrawlingId(competitorId);
    try {
      const result = await api.post<CompetitorCrawlResult>(
        `/tenants/${tenantId}/projects/${projectId}/competitors/${competitorId}/crawl`,
      );
      setLastCrawlResult(result);
      if (selectedId === competitorId) {
        await loadDetail(competitorId);
      }
    } catch (err) {
      setCrawlError(err instanceof ApiError ? err.message : "This crawl failed.");
    } finally {
      setCrawlingId(null);
    }
  }

  function handleSelect(competitorId: string) {
    setSelectedId(competitorId);
    setChanges(null);
    setReport(null);
    loadDetail(competitorId);
  }

  const selectedCompetitor = competitors?.find((c) => c.id === selectedId) ?? null;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Competitor intelligence" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Competitor intelligence</h1>
        <p className="callout">
          Crawls each competitor's own public pages (home, about, pricing, blog) and extracts a basic term-frequency
          keyword list — not a paid SEO/SERP ranking tool, just real word counts from real pages. Running a crawl
          compares the new pages against the competitor's last crawl and records what changed.
        </p>

        {competitors === null ? (
          <p className="muted">Loading...</p>
        ) : competitors.length === 0 ? (
          <EmptyState title="No competitors yet" hint="Add one below to start monitoring its site." />
        ) : (
          <ul className="card-list card-list-static">
            {competitors.map((c) => (
              <li key={c.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{c.name}</strong>
                  <span className="muted"> · {c.domain}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Badge tone={c.is_active ? "success" : "neutral"}>{c.is_active ? "active" : "inactive"}</Badge>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={crawlingId === c.id}
                    onClick={() => handleCrawl(c.id)}
                  >
                    {crawlingId === c.id ? "Crawling..." : "Crawl now"}
                  </button>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => handleSelect(c.id)}>
                    {selectedId === c.id ? "Viewing" : "View report"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <ErrorBanner message={crawlError} />
        {lastCrawlResult ? (
          <p className="muted">
            Last crawl captured {lastCrawlResult.snapshot.pages.length} page(s) and detected{" "}
            {lastCrawlResult.changesDetected.length} change(s).
          </p>
        ) : null}

        {!formOpen ? (
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            New competitor
          </button>
        ) : (
          <form className="form" onSubmit={handleCreate}>
            <ErrorBanner message={createError} />
            <label className="field">
              <span>Name</span>
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Inc" />
            </label>
            <label className="field">
              <span>Domain</span>
              <input
                required
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="e.g. acme.com"
              />
            </label>
            <label className="field">
              <span>Notes (optional)</span>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why we're watching them" />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? "Creating..." : "Create competitor"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      {selectedCompetitor ? (
        <section className="panel">
          <h2>Report: {selectedCompetitor.name}</h2>
          <ErrorBanner message={detailError} />

          {detailLoading ? (
            <p className="muted">Loading...</p>
          ) : report === null ? (
            <EmptyState title="No crawls yet" hint="Crawl this competitor above to generate a report." />
          ) : (
            <>
              <p className="callout">{report.positioningSummary}</p>

              <h3>Top keywords</h3>
              {report.topKeywords.length === 0 ? (
                <EmptyState title="No keywords extracted yet" />
              ) : (
                <ul className="card-list card-list-static">
                  {report.topKeywords.slice(0, 15).map((k) => (
                    <li key={k.keyword} className="card-list-item card-list-item-static">
                      <span>{k.keyword}</span>
                      <Badge tone="neutral">{k.frequency}</Badge>
                    </li>
                  ))}
                </ul>
              )}

              <h3>Changes timeline</h3>
              {changes === null || changes.length === 0 ? (
                <EmptyState title="No changes detected yet" hint="Crawl again later to detect changes over time." />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Page</th>
                        <th>Summary</th>
                        <th>Detected</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((change) => (
                        <tr key={change.id}>
                          <td>
                            <Badge tone={changeTypeTone(change.change_type)}>{change.change_type}</Badge>
                          </td>
                          <td>
                            <a href={change.page_url} target="_blank" rel="noreferrer">
                              {change.page_url}
                            </a>
                          </td>
                          <td>{change.diff_summary}</td>
                          <td>{new Date(change.detected_at).toLocaleString()}</td>
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
