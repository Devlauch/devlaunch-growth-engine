import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge, discoveredOrgStatusTone, sourceConfidenceTone } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type {
  DiscoveredOrganization,
  DiscoveredOrganizationStatus,
  DiscoveryRunResult,
  DiscoverySource,
  Project,
  SourceConfidence,
} from "../api/types";

// Quality-filter query params for GET .../discovered-organizations — see
// apps/api/src/routes/discovery.ts's listDiscoveredOrganizationsQuerySchema.
// Kept local to this page (rather than as a shared api/types.ts shape) the
// same way PriorityQueuePage.tsx keeps its own filter types local, to avoid
// colliding with other pages/agents editing that shared file in parallel.
const ORGANIZATION_STATUSES: DiscoveredOrganizationStatus[] = ["new", "researched", "duplicate", "archived"];
const SOURCE_CONFIDENCES: SourceConfidence[] = ["verified", "inferred", "unconfirmed"];

interface BulkPromoteItemResult {
  organizationId: string;
  success: boolean;
  leadId?: string;
  error?: string;
}

interface BulkPromoteResponse {
  results: BulkPromoteItemResult[];
  succeeded: number;
  failed: number;
}

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

  // Prospect quality filters.
  const [statusFilter, setStatusFilter] = useState<DiscoveredOrganizationStatus | "">("");
  const [sourceConfidenceFilter, setSourceConfidenceFilter] = useState<SourceConfidence | "">("");
  const [providerFilter, setProviderFilter] = useState("");
  const [minLeadScoreFilter, setMinLeadScoreFilter] = useState("");

  // Bulk prospect review -> CRM import: multi-select organizations still in
  // status "new", then promote every selected one in one request.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPromoting, setBulkPromoting] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkPromoteResponse | null>(null);

  const loadOrganizations = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (sourceConfidenceFilter) params.set("sourceConfidence", sourceConfidenceFilter);
      if (providerFilter) params.set("provider", providerFilter);
      if (minLeadScoreFilter.trim()) params.set("minLeadScore", minLeadScoreFilter.trim());
      const qs = params.toString();

      const orgsRes = await api.get<{ discoveredOrganizations: DiscoveredOrganization[] }>(
        `/tenants/${tenantId}/projects/${projectId}/discovered-organizations${qs ? `?${qs}` : ""}`,
      );
      setOrganizations(orgsRes.discoveredOrganizations);
      // Drop any selection that's no longer in the (possibly re-filtered) list.
      setSelectedIds((prev) => {
        const stillPresent = new Set(orgsRes.discoveredOrganizations.map((o) => o.id));
        const next = new Set<string>();
        for (const id of prev) if (stillPresent.has(id)) next.add(id);
        return next;
      });
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load discovered organizations.");
    }
  }, [tenantId, projectId, statusFilter, sourceConfidenceFilter, providerFilter, minLeadScoreFilter]);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, sourcesRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ discoverySources: DiscoverySource[] }>(
          `/tenants/${tenantId}/projects/${projectId}/discovery-sources`,
        ),
      ]);
      setProject(projectRes.project);
      setSources(sourcesRes.discoverySources);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load discovery for this project.");
    }
    await loadOrganizations();
  }, [tenantId, projectId, loadOrganizations]);

  useEffect(() => {
    load();
    // Only on mount / tenant-project change — loadOrganizations below
    // handles filter changes on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, projectId]);

  useEffect(() => {
    loadOrganizations();
  }, [loadOrganizations]);

  // The real, distinct set of connector_type values actually configured for
  // this project — never an invented/fixed provider list, so the filter can
  // never offer a provider that couldn't possibly match anything.
  const availableProviders = useMemo(
    () => Array.from(new Set((sources ?? []).map((s) => s.connector_type))),
    [sources],
  );

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
      await loadOrganizations();
    } catch (err) {
      setPromoteError(err instanceof ApiError ? err.message : "Could not promote this organization to a lead.");
    } finally {
      setPromotingId(null);
    }
  }

  function toggleSelected(organizationId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(organizationId)) next.delete(organizationId);
      else next.add(organizationId);
      return next;
    });
  }

  const selectableOrgIds = (organizations ?? []).filter((o) => o.status === "new").map((o) => o.id);
  const allSelectableSelected = selectableOrgIds.length > 0 && selectableOrgIds.every((id) => selectedIds.has(id));

  function toggleSelectAll() {
    setSelectedIds((prev) =>
      allSelectableSelected || prev.size === 0 ? new Set(allSelectableSelected ? [] : selectableOrgIds) : new Set(selectableOrgIds),
    );
  }

  /**
   * Bulk prospect review -> CRM import: promotes every selected organization
   * in one request (POST .../discovered-organizations/bulk-promote). Shows
   * the real per-item result — "N promoted, M failed" — never a fabricated
   * all-success, since an individual item can legitimately fail (already
   * promoted by someone else, wrong project) without the rest of the batch
   * failing.
   */
  async function handleBulkPromote() {
    if (!tenantId || !projectId || selectedIds.size === 0) return;
    setPromoteError(null);
    setBulkResult(null);
    setBulkPromoting(true);
    try {
      const result = await api.post<BulkPromoteResponse>(
        `/tenants/${tenantId}/projects/${projectId}/discovered-organizations/bulk-promote`,
        { items: Array.from(selectedIds).map((organizationId) => ({ organizationId })) },
      );
      setBulkResult(result);
      setSelectedIds(new Set());
      await loadOrganizations();
    } catch (err) {
      setPromoteError(err instanceof ApiError ? err.message : "Could not promote the selected organizations.");
    } finally {
      setBulkPromoting(false);
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
        <p className="muted">
          Prospect quality filters — every filter below maps straight to a real column
          (<code>status</code>, <code>source_confidence</code>, the discovery source's <code>connector_type</code>, or
          a promoted lead's <code>lead_scores.total_score</code>); there is no employee-count filter because no
          connector in this codebase actually populates one, and faking it would silently return zero results forever.
        </p>
        <div className="form-inline">
          <label className="field">
            <span>Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as DiscoveredOrganizationStatus | "")}>
              <option value="">Any</option>
              {ORGANIZATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Source confidence</span>
            <select
              value={sourceConfidenceFilter}
              onChange={(e) => setSourceConfidenceFilter(e.target.value as SourceConfidence | "")}
            >
              <option value="">Any</option>
              {SOURCE_CONFIDENCES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Provider</span>
            <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}>
              <option value="">Any</option>
              {availableProviders.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Min lead score</span>
            <input
              type="number"
              min={0}
              max={100}
              value={minLeadScoreFilter}
              onChange={(e) => setMinLeadScoreFilter(e.target.value)}
              placeholder="0-100"
              style={{ width: 90 }}
            />
          </label>
        </div>

        <ErrorBanner message={promoteError} />
        {bulkResult ? (
          <p className="muted">
            Bulk promote: {bulkResult.succeeded} promoted, {bulkResult.failed} failed
            {bulkResult.failed > 0
              ? ` (${bulkResult.results
                  .filter((r) => !r.success)
                  .map((r) => r.error)
                  .join("; ")})`
              : ""}
            .
          </p>
        ) : null}

        {organizations === null ? (
          <p className="muted">Loading...</p>
        ) : organizations.length === 0 ? (
          <EmptyState
            title="No organizations match these filters"
            hint="Try clearing the filters above, or run a discovery source to populate this list."
          />
        ) : (
          <>
            <div className="form-row" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={selectedIds.size === 0 || bulkPromoting}
                onClick={handleBulkPromote}
              >
                {bulkPromoting ? "Promoting..." : `Promote selected to lead (${selectedIds.size})`}
              </button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={allSelectableSelected}
                        disabled={selectableOrgIds.length === 0}
                        onChange={toggleSelectAll}
                        title="Select all eligible (status new) organizations"
                      />
                    </th>
                    <th>Organization</th>
                    <th>Domain</th>
                    <th>Status</th>
                    <th>Source confidence</th>
                    <th>Contacts</th>
                    <th>Discovered</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {organizations.map((org) => (
                    <tr key={org.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(org.id)}
                          disabled={org.status !== "new"}
                          onChange={() => toggleSelected(org.id)}
                        />
                      </td>
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
                        <Badge tone={sourceConfidenceTone(org.source_confidence)}>{org.source_confidence}</Badge>
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
          </>
        )}
      </section>
    </Layout>
  );
}
