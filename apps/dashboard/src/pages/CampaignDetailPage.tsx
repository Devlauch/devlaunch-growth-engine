import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge, campaignStatusTone, sourceBadgeTone, sourceLabel } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Approval, Campaign, CampaignMember, Lead, Project } from "../api/types";

export function CampaignDetailPage() {
  const { tenantId, projectId, campaignId } = useParams<{
    tenantId: string;
    projectId: string;
    campaignId: string;
  }>();

  const [project, setProject] = useState<Project | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [members, setMembers] = useState<CampaignMember[] | null>(null);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedLeadId, setSelectedLeadId] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId || !campaignId) return;
    try {
      const [projectRes, detailRes, leadsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ campaign: Campaign; members: CampaignMember[]; approvals: Approval[] }>(
          `/tenants/${tenantId}/projects/${projectId}/campaigns/${campaignId}`,
        ),
        api.get<{ leads: Lead[] }>(`/tenants/${tenantId}/projects/${projectId}/leads`),
      ]);
      setProject(projectRes.project);
      setCampaign(detailRes.campaign);
      setMembers(detailRes.members);
      setApprovals(detailRes.approvals);
      setLeads(leadsRes.leads);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load this campaign.");
    }
  }, [tenantId, projectId, campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  const attachedLeadIds = new Set((members ?? []).map((m) => m.lead_id));
  const availableLeads = (leads ?? []).filter((l) => !attachedLeadIds.has(l.id));
  const pendingApproval = (approvals ?? []).find((a) => a.status === "pending") ?? null;

  async function handleAddMember(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId || !campaignId || !selectedLeadId) return;
    setMemberError(null);
    setAddingMember(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/campaigns/${campaignId}/members`, {
        leadId: selectedLeadId,
      });
      setSelectedLeadId("");
      await load();
    } catch (err) {
      setMemberError(err instanceof ApiError ? err.message : "Could not attach this lead.");
    } finally {
      setAddingMember(false);
    }
  }

  async function handleSubmitForApproval() {
    if (!tenantId || !projectId || !campaignId) return;
    setActionError(null);
    setSubmitting(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/campaigns/${campaignId}/submit-for-approval`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not submit this campaign for approval.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDecision(decision: "approved" | "rejected") {
    if (!tenantId || !pendingApproval) return;
    setActionError(null);
    setDeciding(true);
    try {
      await api.post(`/tenants/${tenantId}/approvals/${pendingApproval.id}/decision`, { decision });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not record that decision.");
    } finally {
      setDeciding(false);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Campaigns", to: `/tenants/${tenantId}/projects/${projectId}/campaigns` },
        { label: campaign?.name ?? "..." },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      {campaign ? (
        <section className="panel">
          <h1>
            {campaign.name} <Badge tone={campaignStatusTone(campaign.status)}>{campaign.status.replace("_", " ")}</Badge>
          </h1>
          <dl className="detail-grid">
            <div>
              <dt>Channel</dt>
              <dd>{campaign.channel}</dd>
            </div>
            <div>
              <dt>Objective</dt>
              <dd>{campaign.objective || "—"}</dd>
            </div>
            <div>
              <dt>Audience</dt>
              <dd>{campaign.audience_description || "—"}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{new Date(campaign.created_at).toLocaleString()}</dd>
            </div>
          </dl>

          <ErrorBanner message={actionError} />

          {campaign.status === "draft" ? (
            <button type="button" className="btn btn-primary" onClick={handleSubmitForApproval} disabled={submitting}>
              {submitting ? "Submitting..." : "Submit for approval"}
            </button>
          ) : null}

          {campaign.status === "pending_approval" && pendingApproval ? (
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleDecision("approved")}
                disabled={deciding}
              >
                {deciding ? "Recording..." : "Approve"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => handleDecision("rejected")}
                disabled={deciding}
              >
                Reject
              </button>
            </div>
          ) : null}

          {campaign.status === "approved" ? (
            <div className="callout">
              Approved — sending integration not yet connected. Nothing has been sent or published; this campaign is
              cleared to send once an email/social provider is wired up in a later phase.
            </div>
          ) : null}

          {campaign.status === "rejected" ? (
            <div className="callout">This campaign was rejected and will not proceed.</div>
          ) : null}
        </section>
      ) : (
        <p className="muted">Loading...</p>
      )}

      <section className="panel">
        <h2>Attached leads</h2>

        {members === null ? (
          <p className="muted">Loading...</p>
        ) : members.length === 0 ? (
          <EmptyState title="No leads attached yet" hint="Attach leads from this project below." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Company</th>
                  <th>Source</th>
                  <th>Attached</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name ?? "—"}</td>
                    <td>{m.email ?? "—"}</td>
                    <td>{m.company ?? "—"}</td>
                    <td>
                      <Badge tone={sourceBadgeTone(m.source)}>{sourceLabel(m.source)}</Badge>
                    </td>
                    <td>{new Date(m.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {campaign && campaign.status === "draft" ? (
          <form className="form form-inline" onSubmit={handleAddMember}>
            <ErrorBanner message={memberError} />
            <label className="field">
              <span>Lead</span>
              <select
                required
                value={selectedLeadId}
                onChange={(e) => setSelectedLeadId(e.target.value)}
                disabled={availableLeads.length === 0}
              >
                <option value="" disabled>
                  {availableLeads.length === 0 ? "No more leads to attach" : "Select a lead"}
                </option>
                {availableLeads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name ?? l.email ?? l.id}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn btn-secondary" disabled={addingMember || !selectedLeadId}>
              {addingMember ? "Attaching..." : "Attach lead"}
            </button>
          </form>
        ) : null}
      </section>
    </Layout>
  );
}
