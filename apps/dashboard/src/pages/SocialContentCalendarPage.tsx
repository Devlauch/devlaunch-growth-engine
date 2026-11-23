import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Workstream H: social content calendar + approval workflow + campaign
// attribution, built on top of the EXISTING Postiz integration
// (PostizIntegrationPage.tsx is the reference this page follows
// convention-for-convention: same load()/handle* shape, same
// panel/table/Badge/EmptyState/ErrorBanner usage). Local types kept here
// (not api/types.ts) for the same reason PostizIntegrationPage.tsx does —
// shapes mirror apps/api/src/routes/socialCommunicationIntelligence.ts
// exactly.

type ApprovalStatus = "pending" | "approved" | "rejected";
type PublishedStatus = "not_published" | "scheduled" | "published" | "failed";

interface CalendarItem {
  id: string;
  campaign_id: string | null;
  platform: string;
  content_draft: string;
  scheduled_at: string | null;
  approval_status: ApprovalStatus;
  postiz_post_id: string | null;
  published_status: PublishedStatus;
  created_at: string;
}

interface AttributionResult {
  campaignId: string;
  campaignAttribution: { campaign_name: string; reply_count: number; conversion_count: number } | null;
  socialContent: {
    calendar_item_count: number;
    published_count: number;
    pending_approval_count: number;
    rejected_count: number;
    platforms: string[];
  };
}

function approvalTone(status: ApprovalStatus): "neutral" | "success" | "warn" | "danger" {
  switch (status) {
    case "approved":
      return "success";
    case "rejected":
      return "danger";
    default:
      return "warn";
  }
}

function publishedTone(status: PublishedStatus): "neutral" | "info" | "success" | "danger" {
  switch (status) {
    case "published":
    case "scheduled":
      return "success";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function SocialContentCalendarPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [platform, setPlatform] = useState("");
  const [contentDraft, setContentDraft] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actingItemId, setActingItemId] = useState<string | null>(null);

  const [attributionCampaignId, setAttributionCampaignId] = useState("");
  const [attribution, setAttribution] = useState<AttributionResult | null>(null);
  const [attributionError, setAttributionError] = useState<string | null>(null);
  const [attributionLoading, setAttributionLoading] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, itemsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ items: CalendarItem[] }>(
          `/tenants/${tenantId}/projects/${projectId}/social-communication-intelligence/calendar`,
        ),
      ]);
      setProject(projectRes.project);
      setItems(itemsRes.items);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the social content calendar for this project.");
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
      await api.post(`/tenants/${tenantId}/projects/${projectId}/social-communication-intelligence/calendar`, {
        platform,
        contentDraft,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        campaignId: campaignId || undefined,
      });
      setPlatform("");
      setContentDraft("");
      setScheduledAt("");
      setCampaignId("");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this calendar item.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRequestApproval(itemId: string) {
    if (!tenantId || !projectId) return;
    setActionError(null);
    setActingItemId(itemId);
    try {
      await api.post(
        `/tenants/${tenantId}/projects/${projectId}/social-communication-intelligence/calendar/${itemId}/request-approval`,
        {},
      );
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not submit this item for approval.");
    } finally {
      setActingItemId(null);
    }
  }

  async function handleApproveAndPublish(itemId: string) {
    if (!tenantId || !projectId) return;
    setActionError(null);
    setActingItemId(itemId);
    try {
      await api.post(
        `/tenants/${tenantId}/projects/${projectId}/social-communication-intelligence/calendar/${itemId}/approve-and-publish`,
        {},
      );
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.message
          : "Could not publish this item (it may still be awaiting a real human approval decision).",
      );
    } finally {
      setActingItemId(null);
    }
  }

  async function handleLoadAttribution(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId || !attributionCampaignId) return;
    setAttributionError(null);
    setAttributionLoading(true);
    try {
      const result = await api.get<AttributionResult>(
        `/tenants/${tenantId}/projects/${projectId}/social-communication-intelligence/campaigns/${attributionCampaignId}/attribution`,
      );
      setAttribution(result);
    } catch (err) {
      setAttribution(null);
      setAttributionError(err instanceof ApiError ? err.message : "Could not load attribution for this campaign.");
    } finally {
      setAttributionLoading(false);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Social content calendar" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Social content calendar</h1>
        <p className="callout">
          Plans and drafts for Postiz-published social content. Every item requires a real human approval decision
          (via the existing approvals queue) before it is ever published through the existing, real Postiz
          integration — this page never bypasses that gate or calls Postiz directly.
        </p>

        <ErrorBanner message={createError} />
        <form className="form" onSubmit={handleCreate}>
          <label className="field">
            <span>Platform (Postiz integration id)</span>
            <input value={platform} onChange={(e) => setPlatform(e.target.value)} required />
          </label>
          <label className="field">
            <span>Content draft</span>
            <textarea value={contentDraft} onChange={(e) => setContentDraft(e.target.value)} rows={3} required />
          </label>
          <label className="field">
            <span>Schedule for (optional)</span>
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </label>
          <label className="field">
            <span>Campaign id (optional — for attribution)</span>
            <input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="uuid" />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? "Saving..." : "Add to calendar"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Calendar</h2>
        <ErrorBanner message={actionError} />
        {items && items.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Content</th>
                <th>Platform</th>
                <th>Scheduled</th>
                <th>Approval</th>
                <th>Published</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.content_draft.slice(0, 80)}</td>
                  <td>{item.platform}</td>
                  <td>{item.scheduled_at ?? "—"}</td>
                  <td>
                    <Badge tone={approvalTone(item.approval_status)}>{item.approval_status}</Badge>
                  </td>
                  <td>
                    <Badge tone={publishedTone(item.published_status)}>{item.published_status}</Badge>
                  </td>
                  <td style={{ display: "flex", gap: 8 }}>
                    {item.approval_status === "pending" ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={actingItemId === item.id}
                        onClick={() => handleRequestApproval(item.id)}
                      >
                        Request approval
                      </button>
                    ) : null}
                    {item.approval_status === "approved" && item.published_status === "not_published" ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        disabled={actingItemId === item.id}
                        onClick={() => handleApproveAndPublish(item.id)}
                      >
                        Publish
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No social content calendar items yet." />
        )}
      </section>

      <section className="panel">
        <h2>Campaign attribution</h2>
        <p className="callout">
          Social's real, honest contribution to a campaign — joined with the existing campaign attribution view, not
          a fabricated conversion number.
        </p>
        <ErrorBanner message={attributionError} />
        <form className="form" onSubmit={handleLoadAttribution}>
          <label className="field">
            <span>Campaign id</span>
            <input value={attributionCampaignId} onChange={(e) => setAttributionCampaignId(e.target.value)} placeholder="uuid" required />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-secondary" disabled={attributionLoading}>
              {attributionLoading ? "Loading..." : "Load attribution"}
            </button>
          </div>
        </form>
        {attribution ? (
          <div className="form" style={{ marginTop: 12 }}>
            <div>
              Calendar items: <strong>{attribution.socialContent.calendar_item_count}</strong>, published:{" "}
              <strong>{attribution.socialContent.published_count}</strong>, pending approval:{" "}
              <strong>{attribution.socialContent.pending_approval_count}</strong>, rejected:{" "}
              <strong>{attribution.socialContent.rejected_count}</strong>
            </div>
            <div>Platforms: {attribution.socialContent.platforms.join(", ") || "—"}</div>
            {attribution.campaignAttribution ? (
              <div>
                Campaign "{attribution.campaignAttribution.campaign_name}" — replies:{" "}
                {attribution.campaignAttribution.reply_count}, conversions: {attribution.campaignAttribution.conversion_count}
              </div>
            ) : (
              <div className="muted">No campaign_attribution row yet for this campaign (no members/replies recorded).</div>
            )}
          </div>
        ) : null}
      </section>
    </Layout>
  );
}
