import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge, sourceBadgeTone, sourceLabel, statusTone } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local types for roadmap item 8 ("Priority queue"). Kept here rather than
// in api/types.ts to avoid colliding with other pages/agents editing that
// shared file in parallel — shapes mirror
// apps/api/src/routes/priorityQueue.ts's `toLeadShape` exactly.

const LEAD_STATUSES = ["new", "qualified", "rejected", "approved_for_outreach", "archived"] as const;
type LeadStatus = (typeof LEAD_STATUSES)[number];

interface QueueLeadScore {
  totalScore: number;
  whySummary: string | null;
  nextResearchNote: string | null;
  computedAt: string | null;
}

interface QueueLead {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  status: string;
  source: string;
  createdAt: string;
  score: QueueLeadScore | null;
}

interface PriorityQueueListResponse {
  leads: QueueLead[];
  page: number;
  pageSize: number;
  total: number;
}

interface PriorityQueueTodayResponse {
  leads: QueueLead[];
}

const PAGE_SIZE = 25;

export function PriorityQueuePage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [today, setToday] = useState<QueueLead[] | null>(null);
  const [todayError, setTodayError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<LeadStatus | "">("");
  const [minScoreFilter, setMinScoreFilter] = useState("");
  const [page, setPage] = useState(1);

  const [queue, setQueue] = useState<PriorityQueueListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadProject = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const res = await api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`);
      setProject(res.project);
    } catch {
      // Non-fatal for this page: the queue below still loads and reports its own errors.
    }
  }, [tenantId, projectId]);

  const loadToday = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const res = await api.get<PriorityQueueTodayResponse>(
        `/tenants/${tenantId}/projects/${projectId}/priority-queue/today`,
      );
      setToday(res.leads);
    } catch (err) {
      setTodayError(err instanceof ApiError ? err.message : "Could not load today's top leads.");
    }
  }, [tenantId, projectId]);

  const loadQueue = useCallback(async () => {
    if (!tenantId || !projectId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (minScoreFilter.trim()) params.set("minScore", minScoreFilter.trim());
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));

      const res = await api.get<PriorityQueueListResponse>(
        `/tenants/${tenantId}/projects/${projectId}/priority-queue?${params.toString()}`,
      );
      setQueue(res);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the priority queue.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, projectId, statusFilter, minScoreFilter, page]);

  useEffect(() => {
    loadProject();
    loadToday();
  }, [loadProject, loadToday]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  function handleStatusChange(value: string) {
    setStatusFilter(value as LeadStatus | "");
    setPage(1);
  }

  function handleMinScoreChange(value: string) {
    setMinScoreFilter(value);
    setPage(1);
  }

  const totalPages = queue ? Math.max(1, Math.ceil(queue.total / queue.pageSize)) : 1;

  function renderLeadRow(lead: QueueLead) {
    return (
      <tr key={lead.id}>
        <td>{lead.name ?? "—"}</td>
        <td>{lead.email ?? "—"}</td>
        <td>{lead.company ?? "—"}</td>
        <td>
          <Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, " ")}</Badge>
        </td>
        <td>
          <Badge tone={sourceBadgeTone(lead.source)}>{sourceLabel(lead.source)}</Badge>
        </td>
        <td>
          {lead.score ? (
            <strong>{lead.score.totalScore}/100</strong>
          ) : (
            <span className="muted">not scored</span>
          )}
        </td>
        <td>{new Date(lead.createdAt).toLocaleDateString()}</td>
      </tr>
    );
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Priority queue" },
      ]}
      projectName={project?.name}
    >
      <section className="panel">
        <h1>Priority queue</h1>
        <p className="callout">
          Leads ranked by their computed score (highest first), with unscored leads sorted after every scored one.
          Every number here comes straight from <code>lead_scores</code> — an unscored lead is still a real, current
          lead, just shown as "not scored" rather than a fabricated number.
        </p>
      </section>

      <section className="panel">
        <h2>Today's top leads</h2>
        <ErrorBanner message={todayError} />
        {today === null ? (
          <p className="muted">Loading...</p>
        ) : today.length === 0 ? (
          <EmptyState
            title="Nothing to work today"
            hint="No actionable lead has a computed score yet — recompute scores from the Scoring page once a rubric is active."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Score</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>{today.map(renderLeadRow)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>All leads</h2>
        <div className="form-inline">
          <label className="field">
            <span>Status</span>
            <select value={statusFilter} onChange={(e) => handleStatusChange(e.target.value)}>
              <option value="">Any</option>
              {LEAD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Min score</span>
            <input
              type="number"
              min={0}
              max={100}
              value={minScoreFilter}
              onChange={(e) => handleMinScoreChange(e.target.value)}
              placeholder="0-100"
              style={{ width: 90 }}
            />
          </label>
        </div>

        <ErrorBanner message={loadError} />

        {loading && queue === null ? (
          <p className="muted">Loading...</p>
        ) : queue === null || queue.leads.length === 0 ? (
          <EmptyState
            title="No leads match these filters"
            hint="Try clearing the status/min-score filters, or check back once more leads come in."
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Company</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Score</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>{queue.leads.map(renderLeadRow)}</tbody>
              </table>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <span className="muted">
                Page {queue.page} of {totalPages} · {queue.total} lead{queue.total === 1 ? "" : "s"} total
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </button>
            </div>
          </>
        )}
      </section>
    </Layout>
  );
}
