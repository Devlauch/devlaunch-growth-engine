import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconCompass, IconTarget, IconUsers, IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type {
  DiscoverySource,
  Project,
  ProspectingCampaign,
  ProspectingCampaignResultsSummary,
  ProspectingCampaignSource,
} from "../api/types";

// Milestone 3 Phase 2: prospecting campaigns are the real "batch of
// discovery work with a goal" entity discovery_sources never had on its
// own (packages/db/migrations/323_create_prospecting_campaigns.sql).
// Every number shown here (resultsSummary) is a direct read from
// GET .../prospecting-campaigns/:id — a live COUNT over real
// discovered_organizations/discovered_contacts/leads rows, never
// estimated or cached. Starting a run calls the real multi-provider
// discovery waterfall (apps/api/src/lib/discoveryRun.ts).
export function ProspectingCampaignsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [campaigns, setCampaigns] = useState<ProspectingCampaign[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    sources: ProspectingCampaignSource[];
    resultsSummary: ProspectingCampaignResultsSummary;
  } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [discoverySources, setDiscoverySources] = useState<DiscoverySource[] | null>(null);

  const [newName, setNewName] = useState("");
  const [newGoal, setNewGoal] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [attachSourceId, setAttachSourceId] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, campaignsRes, sourcesRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ prospectingCampaigns: ProspectingCampaign[] }>(
          `/tenants/${tenantId}/projects/${projectId}/prospecting-campaigns`,
        ),
        api.get<{ discoverySources: DiscoverySource[] }>(
          `/tenants/${tenantId}/projects/${projectId}/discovery-sources`,
        ),
      ]);
      setProject(projectRes.project);
      setCampaigns(campaignsRes.prospectingCampaigns);
      setDiscoverySources(sourcesRes.discoverySources);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load prospecting campaigns for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadDetail = useCallback(
    async (campaignId: string) => {
      if (!tenantId || !projectId) return;
      setDetailError(null);
      try {
        const res = await api.get<{
          sources: ProspectingCampaignSource[];
          resultsSummary: ProspectingCampaignResultsSummary;
        }>(`/tenants/${tenantId}/projects/${projectId}/prospecting-campaigns/${campaignId}`);
        setDetail({ sources: res.sources, resultsSummary: res.resultsSummary });
      } catch (err) {
        setDetailError(err instanceof ApiError ? err.message : "Could not load this campaign's detail.");
      }
    },
    [tenantId, projectId],
  );

  const select = useCallback(
    (campaignId: string) => {
      setSelectedId(campaignId);
      setDetail(null);
      setRunError(null);
      loadDetail(campaignId);
    },
    [loadDetail],
  );

  const createCampaign = useCallback(async () => {
    if (!tenantId || !projectId || !newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/prospecting-campaigns`, {
        name: newName.trim(),
        goal: newGoal.trim() || undefined,
      });
      setNewName("");
      setNewGoal("");
      load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this campaign.");
    } finally {
      setCreating(false);
    }
  }, [tenantId, projectId, newName, newGoal, load]);

  const attachSource = useCallback(async () => {
    if (!tenantId || !projectId || !selectedId || !attachSourceId) return;
    setAttaching(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/prospecting-campaigns/${selectedId}/sources`, {
        discoverySourceId: attachSourceId,
      });
      setAttachSourceId("");
      loadDetail(selectedId);
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : "Could not attach this source.");
    } finally {
      setAttaching(false);
    }
  }, [tenantId, projectId, selectedId, attachSourceId, loadDetail]);

  const startRun = useCallback(async () => {
    if (!tenantId || !projectId || !selectedId) return;
    setRunning(true);
    setRunError(null);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/prospecting-campaigns/${selectedId}/start-run`, {});
      await Promise.all([load(), loadDetail(selectedId)]);
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not start this campaign's run.");
    } finally {
      setRunning(false);
    }
  }, [tenantId, projectId, selectedId, load, loadDetail]);

  const selectedCampaign = campaigns?.find((c) => c.id === selectedId) ?? null;
  const attachableSources = (discoverySources ?? []).filter(
    (s) => !detail?.sources.some((attached) => attached.discovery_source_id === s.id),
  );

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Prospecting Campaigns" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Prospecting Campaigns</h1>
        <p className="muted">
          A named batch of discovery work with a real goal, target ICP, and a results summary computed live from
          actual discovered organizations/contacts/leads — never a fabricated count.
        </p>
        <div className="form-row">
          <input
            type="text"
            placeholder="Campaign name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            type="text"
            placeholder="Goal (optional)"
            value={newGoal}
            onChange={(e) => setNewGoal(e.target.value)}
          />
          <button type="button" onClick={createCampaign} disabled={creating || !newName.trim()}>
            {creating ? "Creating..." : "Create campaign"}
          </button>
        </div>
        <ErrorBanner message={createError} />
      </section>

      {campaigns === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : campaigns.length === 0 ? (
        <section className="panel">
          <EmptyState title="No prospecting campaigns yet" hint="Create one above to start organizing discovery work." />
        </section>
      ) : (
        <>
          <section className="panel">
            <h2>All campaigns</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Goal</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.status}</td>
                    <td>{c.goal ?? "—"}</td>
                    <td>
                      <button type="button" onClick={() => select(c.id)}>
                        {selectedId === c.id ? "Selected" : "View"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {selectedCampaign ? (
            <section className="panel">
              <h2>{selectedCampaign.name}</h2>
              <ErrorBanner message={detailError} />

              {detail ? (
                <StatGrid>
                  <StatCard icon={<IconCompass />} label="Organizations found" value={detail.resultsSummary.organizationsFound} />
                  <StatCard icon={<IconUsers />} label="Contacts found" value={detail.resultsSummary.contactsFound} />
                  <StatCard icon={<IconTarget />} label="Leads created" value={detail.resultsSummary.leadsCreated} />
                  <StatCard icon={<IconZap />} label="Leads qualified" value={detail.resultsSummary.leadsQualified} />
                </StatGrid>
              ) : (
                <p className="muted">Loading detail...</p>
              )}

              <h3>Configured sources (waterfall order)</h3>
              {detail && detail.sources.length === 0 ? (
                <EmptyState title="No sources attached" hint="Attach a discovery source below before starting a run." />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Priority</th>
                      <th>Name</th>
                      <th>Connector</th>
                      <th>Enabled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail?.sources.map((s) => (
                      <tr key={s.id}>
                        <td>{s.priority}</td>
                        <td>{s.name}</td>
                        <td>{s.connector_type}</td>
                        <td>{s.enabled ? "Yes" : "No"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="form-row">
                <select value={attachSourceId} onChange={(e) => setAttachSourceId(e.target.value)}>
                  <option value="">Select a discovery source to attach...</option>
                  {attachableSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.connector_type})
                    </option>
                  ))}
                </select>
                <button type="button" onClick={attachSource} disabled={attaching || !attachSourceId}>
                  {attaching ? "Attaching..." : "Attach source"}
                </button>
              </div>

              <div className="form-row">
                <button type="button" onClick={startRun} disabled={running || selectedCampaign.status === "running"}>
                  {running ? "Running..." : "Start run"}
                </button>
              </div>
              <ErrorBanner message={runError} />
            </section>
          ) : null}
        </>
      )}
    </Layout>
  );
}
