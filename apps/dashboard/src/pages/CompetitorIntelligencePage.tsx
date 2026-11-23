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

interface PricingSignal {
  sentence: string;
  pageUrl: string;
}

interface CompetitorReport {
  competitor: Competitor;
  latestSnapshot: CompetitorSnapshot | null;
  recentChanges: CompetitorChange[];
  topKeywords: ExtractedKeyword[];
  positioningSummary: string;
  pricingSignals: PricingSignal[];
}

// Phase 4b: competitor discovery + keyword opportunities. Shapes mirror
// apps/api/src/lib/competitorDiscoveryProvider.ts and
// apps/api/src/lib/keywordOpportunities.ts exactly.

interface CompetitorCandidate {
  domain: string;
  title: string | null;
  snippet: string | null;
  matchedQuery: string;
  sourceUrl: string | null;
}

interface DiscoveryResult {
  configured: boolean;
  message: string;
  queriesRun: string[];
  candidates: CompetitorCandidate[];
}

interface KeywordOpportunity {
  keyword: string;
  competitorCount: number;
  combinedFrequency: number;
  competitors: Array<{ competitorName: string; frequency: number }>;
}

interface KeywordOpportunitiesResult {
  hasOwnSiteData: boolean;
  hasCompetitorData: boolean;
  opportunities: KeywordOpportunity[];
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

  // Phase 4b: competitor auto-discovery
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveryResult | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Phase 4b: keyword opportunities
  const [opportunities, setOpportunities] = useState<KeywordOpportunitiesResult | null>(null);
  const [opportunitiesError, setOpportunitiesError] = useState<string | null>(null);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(false);

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

  async function handleDiscover() {
    if (!tenantId || !projectId) return;
    setDiscoveryError(null);
    setDiscovering(true);
    try {
      const result = await api.post<DiscoveryResult>(
        `/tenants/${tenantId}/projects/${projectId}/competitors/discover`,
      );
      setDiscoveryResult(result);
    } catch (err) {
      setDiscoveryError(err instanceof ApiError ? err.message : "Competitor discovery failed.");
    } finally {
      setDiscovering(false);
    }
  }

  const loadOpportunities = useCallback(async () => {
    if (!tenantId || !projectId) return;
    setOpportunitiesError(null);
    setOpportunitiesLoading(true);
    try {
      const result = await api.get<KeywordOpportunitiesResult>(
        `/tenants/${tenantId}/projects/${projectId}/competitors/keyword-opportunities`,
      );
      setOpportunities(result);
    } catch (err) {
      setOpportunitiesError(err instanceof ApiError ? err.message : "Could not load keyword opportunities.");
    } finally {
      setOpportunitiesLoading(false);
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    loadOpportunities();
  }, [loadOpportunities]);

  function handleAddCandidate(candidate: CompetitorCandidate) {
    setName(candidate.title ?? candidate.domain);
    setDomain(candidate.domain);
    setNotes(`Found via competitor auto-discovery (query: ${candidate.matchedQuery}).`);
    setFormOpen(true);
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

      <section className="panel">
        <h2>Competitor auto-discovery</h2>
        <p className="callout">
          Searches real Google results (via a configured search provider) for this project's own top extracted
          keywords/products to surface candidate competitors — nothing here is guessed or invented, and no
          candidate is ever added automatically. Run a growth analysis for this project first so there's real data
          to search from.
        </p>
        <button type="button" className="btn btn-secondary" disabled={discovering} onClick={handleDiscover}>
          {discovering ? "Searching..." : "Discover competitors"}
        </button>
        <ErrorBanner message={discoveryError} />
        {discoveryResult ? (
          <>
            <p className="muted">{discoveryResult.message}</p>
            {discoveryResult.candidates.length > 0 ? (
              <ul className="card-list card-list-static">
                {discoveryResult.candidates.map((c) => (
                  <li key={c.domain} className="card-list-item card-list-item-static">
                    <div>
                      <strong>{c.title ?? c.domain}</strong>
                      <span className="muted"> · {c.domain}</span>
                      {c.snippet ? <div className="muted">{c.snippet}</div> : null}
                    </div>
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => handleAddCandidate(c)}>
                      Add as competitor
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="panel">
        <h2>Keyword opportunities</h2>
        <p className="callout">
          Real keywords found in tracked competitors' crawled content that don't appear in this project's own
          crawled content — ranked by how many competitors use the term and their combined real term-frequency
          count. There is no search-volume API integrated here, so this is never presented as search volume.
        </p>
        <ErrorBanner message={opportunitiesError} />
        {opportunitiesLoading ? (
          <p className="muted">Loading...</p>
        ) : opportunities === null ? null : !opportunities.hasOwnSiteData ? (
          <EmptyState
            title="No own-site keyword data yet"
            hint="Run a growth analysis for this project to extract this site's own keywords."
          />
        ) : !opportunities.hasCompetitorData ? (
          <EmptyState title="No tracked competitors with crawled content yet" hint="Add and crawl a competitor above." />
        ) : opportunities.opportunities.length === 0 ? (
          <EmptyState title="No keyword gaps found" hint="Tracked competitors don't use any terms this site doesn't already use." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Keyword</th>
                  <th>Competitors using it</th>
                  <th>Combined frequency</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.opportunities.map((o) => (
                  <tr key={o.keyword}>
                    <td>{o.keyword}</td>
                    <td>{o.competitors.map((c) => c.competitorName).join(", ")}</td>
                    <td>
                      <Badge tone="neutral">{o.combinedFrequency}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

              <h3>Pricing &amp; positioning signals</h3>
              {report.pricingSignals.length === 0 ? (
                <EmptyState
                  title="No pricing/plan language found"
                  hint="This competitor's crawled pages don't mention pricing/plans/tiers, or it hasn't been crawled yet."
                />
              ) : (
                <ul className="card-list card-list-static">
                  {report.pricingSignals.map((signal, i) => (
                    <li key={i} className="card-list-item card-list-item-static">
                      <div>
                        <span>&ldquo;{signal.sentence}&rdquo;</span>
                        <div className="muted">
                          <a href={signal.pageUrl} target="_blank" rel="noreferrer">
                            {signal.pageUrl}
                          </a>
                        </div>
                      </div>
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
