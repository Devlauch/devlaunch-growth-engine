import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";

/**
 * Feature 2, "AI Landing Page & Lead Magnet Builder" dashboard page.
 * Follows ConversionOptimizationPage.tsx's conventions: Layout/Badge/
 * EmptyState/ErrorBanner, local TS interfaces, real empty/zero states
 * instead of placeholders — GET .../stats only ever reflects real tracked
 * landing_page_events rows (apps/api/src/routes/landingPages.ts), never an
 * estimated/fabricated number.
 */

interface Project {
  id: string;
  name: string;
}

type LandingPageStatus = "draft" | "published";

interface LandingPage {
  id: string;
  slug: string;
  title: string;
  audience_label: string | null;
  headline: string | null;
  subheadline: string | null;
  cta_text: string | null;
  status: LandingPageStatus;
  custom_domain: string | null;
  published_at: string | null;
  created_at: string;
}

interface LeadMagnet {
  id: string;
  title: string;
  description: string | null;
  file_url: string;
  created_at: string;
}

interface StatsResponse {
  views: number;
  submits: number;
  downloads: number;
  conversionRate: number;
  byVariant: Record<string, { views: number; submits: number; downloads: number }>;
}

function statusTone(status: LandingPageStatus): "neutral" | "info" | "success" | "warn" | "danger" {
  return status === "published" ? "success" : "neutral";
}

export function LandingPageBuilderPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [pages, setPages] = useState<LandingPage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [audienceLabel, setAudienceLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statsByPage, setStatsByPage] = useState<Record<string, StatsResponse>>({});
  const [magnetsByPage, setMagnetsByPage] = useState<Record<string, LeadMagnet[]>>({});

  const [magnetTitle, setMagnetTitle] = useState("");
  const [magnetFileUrl, setMagnetFileUrl] = useState("");
  const [magnetError, setMagnetError] = useState<string | null>(null);
  const [addingMagnet, setAddingMagnet] = useState(false);

  const base = `/tenants/${tenantId}/projects/${projectId}/landing-pages`;

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, pagesRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ landingPages: LandingPage[] }>(base),
      ]);
      setProject(projectRes.project);
      setPages(pagesRes.landingPages);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load landing pages for this project.");
    }
  }, [tenantId, projectId, base]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, projectId]);

  async function loadDetailsFor(pageId: string) {
    try {
      const [statsRes, magnetsRes] = await Promise.all([
        api.get<StatsResponse>(`${base}/${pageId}/stats`),
        api.get<{ leadMagnets: LeadMagnet[] }>(`${base}/${pageId}/lead-magnets`),
      ]);
      setStatsByPage((prev) => ({ ...prev, [pageId]: statsRes }));
      setMagnetsByPage((prev) => ({ ...prev, [pageId]: magnetsRes.leadMagnets }));
    } catch {
      // Non-fatal: the page still renders without live stats/magnets.
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCreateError(null);
    setCreating(true);
    try {
      await api.post(base, { slug, title, audienceLabel: audienceLabel || undefined });
      setSlug("");
      setTitle("");
      setAudienceLabel("");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this landing page.");
    } finally {
      setCreating(false);
    }
  }

  async function handleTogglePublish(page: LandingPage) {
    setTransitionError(null);
    setTransitioningId(page.id);
    try {
      await api.post(`${base}/${page.id}/${page.status === "published" ? "unpublish" : "publish"}`);
      await load();
    } catch (err) {
      setTransitionError(err instanceof ApiError ? err.message : "Could not update this landing page's status.");
    } finally {
      setTransitioningId(null);
    }
  }

  function toggleExpand(pageId: string) {
    if (expandedId === pageId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(pageId);
    void loadDetailsFor(pageId);
  }

  async function handleAddMagnet(e: FormEvent, pageId: string) {
    e.preventDefault();
    setMagnetError(null);
    setAddingMagnet(true);
    try {
      await api.post(`${base}/${pageId}/lead-magnets`, { title: magnetTitle, fileUrl: magnetFileUrl });
      setMagnetTitle("");
      setMagnetFileUrl("");
      await loadDetailsFor(pageId);
    } catch (err) {
      setMagnetError(err instanceof ApiError ? err.message : "Could not add this lead magnet.");
    } finally {
      setAddingMagnet(false);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Landing Pages" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Landing pages</h1>
        <p className="callout">
          Each page's sections (hero, benefits, social proof, form, CTA) are assembled from a fixed set of real
          templates filled with this project's own profile/ICP data and the copy you enter below — not generated by
          an LLM (this environment has no LLM API key wired up). Custom domains are stored only; no DNS/CDN
          provisioning happens here.
        </p>

        <form className="form" onSubmit={handleCreate}>
          <ErrorBanner message={createError} />
          <label className="field">
            <span>Slug</span>
            <input
              required
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="cloud-consulting"
            />
          </label>
          <label className="field">
            <span>Title</span>
            <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Cloud Consulting" />
          </label>
          <label className="field">
            <span>Audience / segment label</span>
            <input
              value={audienceLabel}
              onChange={(e) => setAudienceLabel(e.target.value)}
              placeholder="cloud consulting"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? "Creating..." : "Create landing page"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Pages</h2>
        <ErrorBanner message={transitionError} />
        {pages === null ? (
          <p className="muted">Loading...</p>
        ) : pages.length === 0 ? (
          <EmptyState title="No landing pages yet" hint="Create one above to get a shareable, trackable page." />
        ) : (
          <ul className="card-list card-list-static">
            {pages.map((page) => {
              const stats = statsByPage[page.id];
              const magnets = magnetsByPage[page.id];
              const expanded = expandedId === page.id;
              return (
                <li
                  key={page.id}
                  className="card-list-item card-list-item-static"
                  style={{ flexDirection: "column", alignItems: "stretch" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <strong>{page.title}</strong>
                      <span className="muted"> · /{page.slug}</span>
                      {page.audience_label ? <span className="muted"> · {page.audience_label}</span> : null}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <Badge tone={statusTone(page.status)}>{page.status}</Badge>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={transitioningId === page.id}
                        onClick={() => handleTogglePublish(page)}
                      >
                        {page.status === "published" ? "Unpublish" : "Publish"}
                      </button>
                      <button type="button" className="btn btn-secondary btn-small" onClick={() => toggleExpand(page.id)}>
                        {expanded ? "Hide details" : "Details"}
                      </button>
                    </div>
                  </div>

                  {expanded ? (
                    <div style={{ marginTop: 12 }}>
                      <h3>Conversion stats</h3>
                      {!stats ? (
                        <p className="muted">Loading...</p>
                      ) : stats.views === 0 ? (
                        <EmptyState
                          title="No tracked views yet"
                          hint="Stats only reflect real page_view/form_submit/download events once visitors reach this page."
                        />
                      ) : (
                        <p>
                          {stats.views} view(s) · {stats.submits} submission(s) · {stats.downloads} download(s) ·{" "}
                          {(stats.conversionRate * 100).toFixed(1)}% conversion rate
                        </p>
                      )}

                      <h3>Lead magnets</h3>
                      {!magnets ? (
                        <p className="muted">Loading...</p>
                      ) : magnets.length === 0 ? (
                        <EmptyState
                          title="No lead magnets attached"
                          hint="Add one below — the download unlocks only after the enquiry form is submitted."
                        />
                      ) : (
                        <ul>
                          {magnets.map((m) => (
                            <li key={m.id}>
                              <strong>{m.title}</strong> — <span className="muted">{m.file_url}</span>
                            </li>
                          ))}
                        </ul>
                      )}

                      <form className="form" onSubmit={(e) => handleAddMagnet(e, page.id)}>
                        <ErrorBanner message={magnetError} />
                        <label className="field">
                          <span>Lead magnet title</span>
                          <input
                            required
                            value={magnetTitle}
                            onChange={(e) => setMagnetTitle(e.target.value)}
                            placeholder="Free Migration Checklist"
                          />
                        </label>
                        <label className="field">
                          <span>File URL (client-hosted — no upload here)</span>
                          <input
                            required
                            type="url"
                            value={magnetFileUrl}
                            onChange={(e) => setMagnetFileUrl(e.target.value)}
                            placeholder="https://cdn.example.com/guide.pdf"
                          />
                        </label>
                        <div className="form-actions">
                          <button type="submit" className="btn btn-secondary btn-small" disabled={addingMagnet}>
                            {addingMagnet ? "Adding..." : "Add lead magnet"}
                          </button>
                        </div>
                      </form>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Layout>
  );
}
