import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge, campaignStatusTone } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Campaign, CampaignChannel, Project } from "../api/types";

const CHANNELS: CampaignChannel[] = ["email", "social", "content", "event", "other"];

export function CampaignsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<CampaignChannel>("email");
  const [objective, setObjective] = useState("");
  const [audienceDescription, setAudienceDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, campaignsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ campaigns: Campaign[] }>(`/tenants/${tenantId}/projects/${projectId}/campaigns`),
      ]);
      setProject(projectRes.project);
      setCampaigns(campaignsRes.campaigns);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load campaigns for this project.");
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
      const res = await api.post<{ campaign: Campaign }>(`/tenants/${tenantId}/projects/${projectId}/campaigns`, {
        name,
        channel,
        objective: objective.trim() || undefined,
        audienceDescription: audienceDescription.trim() || undefined,
      });
      setName("");
      setChannel("email");
      setObjective("");
      setAudienceDescription("");
      setFormOpen(false);
      await load();
      navigate(`/tenants/${tenantId}/projects/${projectId}/campaigns/${res.campaign.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create campaign.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Campaigns" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Campaigns</h1>
        <p className="muted">
          Draft an outreach plan, attach the leads it targets, then submit it for a teammate's approval. Approving a
          campaign does not send or publish anything yet — there is no email/social sending integration connected in
          this phase.
        </p>

        {campaigns === null ? (
          <p className="muted">Loading...</p>
        ) : campaigns.length === 0 ? (
          <EmptyState title="No campaigns yet" hint="Create your first campaign below." />
        ) : (
          <ul className="card-list">
            {campaigns.map((c) => (
              <li
                key={c.id}
                className="card-list-item"
                onClick={() => navigate(`/tenants/${tenantId}/projects/${projectId}/campaigns/${c.id}`)}
              >
                <div>
                  <strong>{c.name}</strong>
                  <span className="muted"> · {c.channel}</span>
                </div>
                <Badge tone={campaignStatusTone(c.status)}>{c.status.replace("_", " ")}</Badge>
              </li>
            ))}
          </ul>
        )}

        {!formOpen ? (
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            New campaign
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
                placeholder="e.g. Q1 email nurture"
              />
            </label>
            <label className="field">
              <span>Channel</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value as CampaignChannel)}>
                {CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {ch}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Objective</span>
              <input
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="What is this campaign trying to achieve?"
              />
            </label>
            <label className="field">
              <span>Audience description</span>
              <textarea
                value={audienceDescription}
                onChange={(e) => setAudienceDescription(e.target.value)}
                placeholder="Who is this campaign for?"
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? "Creating..." : "Create campaign"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>
    </Layout>
  );
}
