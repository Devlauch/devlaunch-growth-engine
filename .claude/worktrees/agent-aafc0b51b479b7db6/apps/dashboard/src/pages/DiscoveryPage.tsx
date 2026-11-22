import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge, discoveredOrgStatusTone } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { DiscoveredOrganization, DiscoveryRunResult, DiscoverySource, Project } from "../api/types";

// Mirrors INDUSTRY_TO_OSM_TAG in packages/agent-sdk/src/connectors/publicDirectoryConnector.ts
// (formerly apps/worker/src/connectors/publicDirectoryConnector.ts) exactly —
// this is the real, fixed set of categories the free OpenStreetMap/Overpass
// backend can honestly answer. A user is never offered an industry outside
// this list, so they can never hit a confusing "unsupported industry" error.
const SUPPORTED_INDUSTRIES = [
  "restaurant",
  "cafe",
  "school",
  "university",
  "hospital",
  "clinic",
  "dentist",
  "pharmacy",
  "bank",
  "hotel",
  "gym",
  "lawyer",
  "accountant",
  "library",
  "childcare",
] as const;

export function DiscoveryPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [sources, setSources] = useState<DiscoverySource[] | null>(null);
  const [organizations, setOrganizations] = useState<DiscoveredOrganization[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState<string>(SUPPORTED_INDUSTRIES[0]);
  const [geography, setGeography] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [runningSourceId, setRunningSourceId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRunResult, setLastRunResult] = useState<DiscoveryRunResult | null>(null);

  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, sourcesRes, orgsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ discoverySources: DiscoverySource[] }>(
          `/tenants/${tenantId}/projects/${projectId}/discovery-sources`,
        ),
        api.get<{ discoveredOrganizations: DiscoveredOrganization[] }>(
          `/tenants/${tenantId}/projects/${projectId}/discovered-organizations`,
        ),
      ]);
      setProject(projectRes.project);
      setSources(sourcesRes.discoverySources);
      setOrganizations(orgsRes.discoveredOrganizations);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load discovery for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCreateError(null);
    setCreating(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/discovery-sources`, {
        connectorType: "public_directory",
        name,
        config: { industry, geography: geography.trim() },
      });
      setName("");
      setGeography("");
      setIndustry(SUPPORTED_INDUSTRIES[0]);
      setFormOpen(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create discovery source.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRun(sourceId: string) {
    if (!tenantId || !projectId) return;
    setRunError(null);
    setLastRunResult(null);
    setRunningSourceId(sourceId);
    try {
      const result = await api.post<DiscoveryRunResult>(
        `/tenants/${tenantId}/projects/${projectId}/discovery-sources/${sourceId}/run`,
      );
      setLastRunResult(result);
      await load();
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "This discovery run failed.");
    } finally {
      setRunningSourceId(null);
    }
  }

  async function handlePromote(organizationId: string) {
    if (!tenantId || !projectId) return;
    setPromoteError(null);
    setPromotingId(organizationId);
    try {
      await api.post(
        `/tenants/${tenantId}/projects/${projectId}/discovered-organizations/${organizationId}/promote-to-lead`,
      );
      await load();
    } catch (err) {
      setPromoteError(err instanceof ApiError ? err.message : "Could not promote this organization to a lead.");
    } finally {
      setPromotingId(null);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Discovery" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Discovery</h1>
        <p className="callout">
          Finds real businesses/institutions via OpenStreetMap's free, no-API-key Overpass directory — no scraping, no
          Crawl4AI. Only the industries below are supported, because that's the full, honest mapping this source can
          answer; running a source queries Overpass live and saves what it actually finds.
        </p>

        {sources === null ? (
          <p className="muted">Loading...</p>
        ) : sources.length === 0 ? (
          <EmptyState title="No discovery sources yet" hint="Create one below to start finding organizations." />
        ) : (
          <ul className="card-list card-list-static">
            {sources.map((s) => (
              <li key={s.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{s.name}</strong>
                  <span className="muted">
                    {" "}
                    · {s.config.industry ?? "?"} in {s.config.geography ?? "?"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Badge tone={s.enabled ? "success" : "neutral"}>{s.enabled ? "enabled" : "disabled"}</Badge>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={!s.enabled || runningSourceId === s.id}
                    onClick={() => handleRun(s.id)}
                  >
                    {runningSourceId === s.id ? "Running..." : "Run"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <ErrorBanner message={runError} />
        {lastRunResult ? (
          <p className="muted">
            Last run found {lastRunResult.organizationsFound} organization(s): {lastRunResult.organizationsCreated}{" "}
            new, {lastRunResult.organizationsDuplicate} already known.
          </p>
        ) : null}

        {!formOpen ? (
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            New discovery source
          </button>
        ) : (
          <form className="form" onSubmit={handleCreate}>
            <ErrorBanner message={createError} />
            <label className="field">
              <span>Name</span>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Austin restaurants"
              />
            </label>
            <label className="field">
              <span>Industry</span>
              <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
                {SUPPORTED_INDUSTRIES.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Geography</span>
              <input
                required
                value={geography}
                onChange={(e) => setGeography(e.target.value)}
                placeholder="e.g. Austin (an OpenStreetMap place name)"
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? "Creating..." : "Create source"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Discovered organizations</h2>
        <ErrorBanner message={promoteError} />

        {organizations === null ? (
          <p className="muted">Loading...</p>
        ) : organizations.length === 0 ? (
          <EmptyState title="No organizations discovered yet" hint="Run a discovery source above to populate this list." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>Contacts</th>
                  <th>Discovered</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {organizations.map((org) => (
                  <tr key={org.id}>
                    <td>
                      <a href={org.source_url} target="_blank" rel="noreferrer">
                        {org.name}
                      </a>
                    </td>
                    <td>{org.domain ?? "—"}</td>
                    <td>
                      <Badge tone={discoveredOrgStatusTone(org.status)}>{org.status}</Badge>
                    </td>
                    <td>
                      {org.contacts.length === 0
                        ? "—"
                        : org.contacts.map((c) => c.email ?? c.name ?? c.phone ?? "contact").join(", ")}
                    </td>
                    <td>{new Date(org.discovered_at).toLocaleDateString()}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={org.status !== "new" || promotingId === org.id}
                        onClick={() => handlePromote(org.id)}
                        title={org.status !== "new" ? "Already promoted or not eligible" : undefined}
                      >
                        {promotingId === org.id ? "Promoting..." : "Promote to lead"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Layout>
  );
}
