import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Workstream E: deep website & competitor intelligence. This is a DISTINCT
// page from CompetitorIntelligencePage.tsx (that one is the Phase 2
// crawl/keyword/change-page agent against apps/api/src/routes/competitors.ts
// — unmodified here). This page drives the NEW
// apps/api/src/routes/websiteIntelligence.ts endpoints: structured
// pricing/product-catalog/case-study snapshots with real evidence, content
// hash-based change detection, and content-gap analysis against a
// competitor's own latest snapshot. Local types mirror that route file and
// apps/api/src/lib/{structuredExtraction,websiteChangeDetection,contentGapAnalysis}.ts
// exactly, kept local rather than in the shared api/types.ts to avoid
// colliding with other pages editing that file in parallel this round.

type SnapshotType = "pricing" | "product_catalog" | "case_studies" | "positioning";

const SNAPSHOT_TYPES: SnapshotType[] = ["pricing", "product_catalog", "case_studies", "positioning"];

interface SourceEvidence {
  selectorOrText: string;
  sourceUrl: string;
  fetchedAt: string;
}

interface WebsiteIntelligenceSnapshot {
  id: string;
  target_url: string;
  snapshot_type: SnapshotType;
  extracted_data: Record<string, unknown>;
  source_evidence: SourceEvidence[];
  content_hash: string;
  created_at: string;
}

interface FieldChange {
  kind: "added" | "removed" | "changed";
  path: string;
  before?: unknown;
  after?: unknown;
}

interface ChangeResult {
  hasPreviousSnapshot: boolean;
  hasChanged: boolean;
  previousSnapshotId: string | null;
  latestSnapshotId: string | null;
  previousHash: string | null;
  latestHash: string | null;
  fieldChanges: FieldChange[];
}

interface GapItem {
  phrase: string;
  sourcePath: string;
}

interface GapResult {
  comparable: boolean;
  missingPlanFeatures: GapItem[];
  missingProducts: GapItem[];
  missingCaseStudyTopics: GapItem[];
  missingKeywords: string[];
}

function snapshotTypeLabel(t: SnapshotType): string {
  switch (t) {
    case "pricing":
      return "Pricing";
    case "product_catalog":
      return "Product catalog";
    case "case_studies":
      return "Case studies";
    case "positioning":
      return "Positioning";
  }
}

export function CompetitorMonitoringPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [targetUrl, setTargetUrl] = useState("");
  const [snapshotType, setSnapshotType] = useState<SnapshotType>("pricing");
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggerMessage, setTriggerMessage] = useState<string | null>(null);

  const [snapshots, setSnapshots] = useState<WebsiteIntelligenceSnapshot[] | null>(null);

  const [changesUrl, setChangesUrl] = useState("");
  const [changesType, setChangesType] = useState<SnapshotType>("pricing");
  const [changeResult, setChangeResult] = useState<ChangeResult | null>(null);
  const [changeLoading, setChangeLoading] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);

  const [ourUrl, setOurUrl] = useState("");
  const [competitorUrl, setCompetitorUrl] = useState("");
  const [gapType, setGapType] = useState<SnapshotType>("pricing");
  const [gapResult, setGapResult] = useState<GapResult | null>(null);
  const [gapLoading, setGapLoading] = useState(false);
  const [gapError, setGapError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, snapshotsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ snapshots: WebsiteIntelligenceSnapshot[] }>(
          `/tenants/${tenantId}/projects/${projectId}/website-intelligence/snapshots`,
        ),
      ]);
      setProject(projectRes.project);
      setSnapshots(snapshotsRes.snapshots);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load website-intelligence snapshots.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleTrigger(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setTriggerError(null);
    setTriggerMessage(null);
    setTriggering(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/website-intelligence/snapshots`, {
        targetUrl,
        snapshotType,
      });
      setTriggerMessage(
        `Snapshot queued for ${targetUrl} (${snapshotTypeLabel(snapshotType)}). Extraction runs asynchronously — refresh the list shortly.`,
      );
      setTargetUrl("");
    } catch (err) {
      setTriggerError(err instanceof ApiError ? err.message : "Could not queue this snapshot.");
    } finally {
      setTriggering(false);
    }
  }

  async function handleCheckChanges(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setChangeError(null);
    setChangeResult(null);
    setChangeLoading(true);
    try {
      const params = new URLSearchParams({ targetUrl: changesUrl, snapshotType: changesType });
      const result = await api.get<ChangeResult>(
        `/tenants/${tenantId}/projects/${projectId}/website-intelligence/changes?${params.toString()}`,
      );
      setChangeResult(result);
    } catch (err) {
      setChangeError(err instanceof ApiError ? err.message : "Could not load change-detection result.");
    } finally {
      setChangeLoading(false);
    }
  }

  async function handleCheckGap(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setGapError(null);
    setGapResult(null);
    setGapLoading(true);
    try {
      const params = new URLSearchParams({
        ourTargetUrl: ourUrl,
        competitorTargetUrl: competitorUrl,
        snapshotType: gapType,
      });
      const result = await api.get<GapResult>(
        `/tenants/${tenantId}/projects/${projectId}/website-intelligence/content-gap?${params.toString()}`,
      );
      setGapResult(result);
    } catch (err) {
      setGapError(err instanceof ApiError ? err.message : "Could not load content-gap analysis.");
    } finally {
      setGapLoading(false);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Competitor monitoring" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Competitor monitoring</h1>
        <p className="callout">
          Deep, structured extraction (pricing plans, product catalog, case studies/testimonials) from any URL —
          our own site's or a tracked competitor's — with real per-field evidence (the exact source text, page URL,
          and fetch time). Extraction runs asynchronously as a background job; nothing here is ever fabricated —
          a page that fails to load or has no matching content is reported honestly, never guessed at.
        </p>

        <form className="form" onSubmit={handleTrigger}>
          <ErrorBanner message={triggerError} />
          {triggerMessage ? <p className="muted">{triggerMessage}</p> : null}
          <label className="field">
            <span>Target URL</span>
            <input
              required
              type="url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://competitor.example.com/pricing"
            />
          </label>
          <label className="field">
            <span>Snapshot type</span>
            <select value={snapshotType} onChange={(e) => setSnapshotType(e.target.value as SnapshotType)}>
              {SNAPSHOT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {snapshotTypeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={triggering}>
              {triggering ? "Queuing..." : "Queue snapshot"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => load()}>
              Refresh list
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Snapshots</h2>
        {snapshots === null ? (
          <p className="muted">Loading...</p>
        ) : snapshots.length === 0 ? (
          <EmptyState title="No snapshots yet" hint="Queue one above to start monitoring a URL." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>URL</th>
                  <th>Evidence</th>
                  <th>Captured</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Badge tone="neutral">{snapshotTypeLabel(s.snapshot_type)}</Badge>
                    </td>
                    <td>
                      <a href={s.target_url} target="_blank" rel="noreferrer">
                        {s.target_url}
                      </a>
                    </td>
                    <td>{s.source_evidence?.length ?? 0} field(s)</td>
                    <td>{new Date(s.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Change detection</h2>
        <p className="callout">
          Compares the two most recent snapshots of the same URL/type by a content hash of their extracted
          structured fields (never raw HTML) and lists exactly which fields were added, removed, or changed.
        </p>
        <form className="form" onSubmit={handleCheckChanges}>
          <ErrorBanner message={changeError} />
          <label className="field">
            <span>Target URL</span>
            <input
              required
              type="url"
              value={changesUrl}
              onChange={(e) => setChangesUrl(e.target.value)}
              placeholder="https://competitor.example.com/pricing"
            />
          </label>
          <label className="field">
            <span>Snapshot type</span>
            <select value={changesType} onChange={(e) => setChangesType(e.target.value as SnapshotType)}>
              {SNAPSHOT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {snapshotTypeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={changeLoading}>
              {changeLoading ? "Checking..." : "Check for changes"}
            </button>
          </div>
        </form>

        {changeResult === null ? null : !changeResult.hasPreviousSnapshot ? (
          <EmptyState title="Not enough snapshots yet" hint="Need at least two snapshots of this URL/type to detect changes." />
        ) : !changeResult.hasChanged ? (
          <p className="muted">No structural changes detected since the prior snapshot.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Field path</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {changeResult.fieldChanges.map((c, i) => (
                  <tr key={i}>
                    <td>
                      <Badge tone={c.kind === "added" ? "success" : c.kind === "removed" ? "warn" : "info"}>
                        {c.kind}
                      </Badge>
                    </td>
                    <td>
                      <code>{c.path}</code>
                    </td>
                    <td>{c.before === undefined ? "—" : JSON.stringify(c.before)}</td>
                    <td>{c.after === undefined ? "—" : JSON.stringify(c.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Content-gap analysis</h2>
        <p className="callout">
          Compares our own latest snapshot against a competitor's latest snapshot (same type) and lists real
          features/products/topics present in theirs but absent from ours — a deterministic phrase-set
          difference, never an invented gap.
        </p>
        <form className="form" onSubmit={handleCheckGap}>
          <ErrorBanner message={gapError} />
          <label className="field">
            <span>Our target URL</span>
            <input
              required
              type="url"
              value={ourUrl}
              onChange={(e) => setOurUrl(e.target.value)}
              placeholder="https://our-site.example.com/pricing"
            />
          </label>
          <label className="field">
            <span>Competitor target URL</span>
            <input
              required
              type="url"
              value={competitorUrl}
              onChange={(e) => setCompetitorUrl(e.target.value)}
              placeholder="https://competitor.example.com/pricing"
            />
          </label>
          <label className="field">
            <span>Snapshot type</span>
            <select value={gapType} onChange={(e) => setGapType(e.target.value as SnapshotType)}>
              {SNAPSHOT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {snapshotTypeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={gapLoading}>
              {gapLoading ? "Analyzing..." : "Analyze content gap"}
            </button>
          </div>
        </form>

        {gapResult === null ? null : !gapResult.comparable ? (
          <EmptyState
            title="Not comparable yet"
            hint="Both URLs need at least one snapshot of the same type before a gap can be computed."
          />
        ) : (
          <>
            <h3>Missing plan features</h3>
            {gapResult.missingPlanFeatures.length === 0 ? (
              <p className="muted">None found.</p>
            ) : (
              <ul className="card-list card-list-static">
                {gapResult.missingPlanFeatures.map((g, i) => (
                  <li key={i} className="card-list-item card-list-item-static">
                    <span>{g.phrase}</span>
                    <span className="muted">{g.sourcePath}</span>
                  </li>
                ))}
              </ul>
            )}

            <h3>Missing products</h3>
            {gapResult.missingProducts.length === 0 ? (
              <p className="muted">None found.</p>
            ) : (
              <ul className="card-list card-list-static">
                {gapResult.missingProducts.map((g, i) => (
                  <li key={i} className="card-list-item card-list-item-static">
                    <span>{g.phrase}</span>
                    <span className="muted">{g.sourcePath}</span>
                  </li>
                ))}
              </ul>
            )}

            <h3>Missing case-study topics</h3>
            {gapResult.missingCaseStudyTopics.length === 0 ? (
              <p className="muted">None found.</p>
            ) : (
              <ul className="card-list card-list-static">
                {gapResult.missingCaseStudyTopics.map((g, i) => (
                  <li key={i} className="card-list-item card-list-item-static">
                    <span>{g.phrase}</span>
                    <span className="muted">{g.sourcePath}</span>
                  </li>
                ))}
              </ul>
            )}

            <h3>Missing keywords (overall)</h3>
            {gapResult.missingKeywords.length === 0 ? (
              <p className="muted">None found.</p>
            ) : (
              <ul className="card-list card-list-static">
                {gapResult.missingKeywords.map((k) => (
                  <li key={k} className="card-list-item card-list-item-static">
                    <span>{k}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </Layout>
  );
}
