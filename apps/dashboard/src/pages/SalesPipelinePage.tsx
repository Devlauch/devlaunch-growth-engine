import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconTarget, IconUsers, IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Sales Conversion Agent (roadmap items 6/7): real deals + meetings for
// this project. Every number on this page is a direct read from
// GET .../deals and GET .../meetings (apps/api/src/routes/deals.ts /
// meetings.ts) — nothing here is estimated or fabricated. "Check stalled
// deals" calls the same manual trigger the API exposes (there is no
// cron/scheduler in this codebase yet).
interface Deal {
  id: string;
  lead_id: string;
  stage: "new" | "contacted" | "qualified" | "proposal" | "won" | "lost";
  value_amount: string | null;
  expected_close_date: string | null;
  owner_user_id: string | null;
  stage_changed_at: string;
}

interface Meeting {
  id: string;
  lead_id: string;
  deal_id: string | null;
  type: "call" | "demo";
  scheduled_at: string;
  status: "scheduled" | "completed" | "no_show" | "rescheduled" | "cancelled";
  outcome_notes: string | null;
  next_step: string | null;
  booking_provider: "manual" | "calendly";
}

const STAGE_LABELS: Record<Deal["stage"], string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

export function SalesPipelinePage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkingStalled, setCheckingStalled] = useState(false);
  const [stalledMessage, setStalledMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, dealsRes, meetingsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ deals: Deal[] }>(`/tenants/${tenantId}/projects/${projectId}/deals`),
        api.get<{ meetings: Meeting[] }>(`/tenants/${tenantId}/projects/${projectId}/meetings`),
      ]);
      setProject(projectRes.project);
      setDeals(dealsRes.deals);
      setMeetings(meetingsRes.meetings);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the sales pipeline for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const checkStalled = useCallback(async () => {
    if (!tenantId || !projectId) return;
    setCheckingStalled(true);
    setStalledMessage(null);
    try {
      const res = await api.post<{ followUpsCreated: unknown[]; thresholdDays: number }>(
        `/tenants/${tenantId}/projects/${projectId}/deals/check-stalled`,
      );
      setStalledMessage(
        res.followUpsCreated.length > 0
          ? `Created ${res.followUpsCreated.length} follow-up task(s) for deals stalled over ${res.thresholdDays} days.`
          : `No deals have been stalled for over ${res.thresholdDays} days.`,
      );
      load();
    } catch (err) {
      setStalledMessage(err instanceof ApiError ? err.message : "Could not run the stalled-deal check.");
    } finally {
      setCheckingStalled(false);
    }
  }, [tenantId, projectId, load]);

  const wonCount = deals?.filter((d) => d.stage === "won").length ?? 0;
  const openCount = deals?.filter((d) => d.stage !== "won" && d.stage !== "lost").length ?? 0;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Sales Pipeline" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Sales Pipeline</h1>
        <p className="muted">
          Real deals and meetings for this project — nothing here is estimated. Stage changes and meeting outcomes
          can automatically create follow-up tasks (see crm_tasks); booking meetings via an external calendar
          provider is not configured in this environment, so meetings are recorded manually.
        </p>
        <button type="button" onClick={checkStalled} disabled={checkingStalled}>
          {checkingStalled ? "Checking..." : "Check for stalled deals"}
        </button>
        {stalledMessage ? <p className="muted">{stalledMessage}</p> : null}
      </section>

      {deals === null || meetings === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : (
        <>
          <StatGrid>
            <StatCard icon={<IconTarget />} label="Open deals" value={openCount} />
            <StatCard icon={<IconZap />} label="Won deals" value={wonCount} />
            <StatCard icon={<IconUsers />} label="Meetings booked" value={meetings.length} />
          </StatGrid>

          <section className="panel">
            <h2>Deals</h2>
            {deals.length === 0 ? (
              <EmptyState title="No deals yet" hint="Create a deal from a qualified lead to start the pipeline." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Value</th>
                    <th>Expected close</th>
                    <th>Stage changed</th>
                  </tr>
                </thead>
                <tbody>
                  {deals.map((d) => (
                    <tr key={d.id}>
                      <td>{STAGE_LABELS[d.stage]}</td>
                      <td>{d.value_amount ?? "—"}</td>
                      <td>{d.expected_close_date ?? "—"}</td>
                      <td>{new Date(d.stage_changed_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <h2>Meetings</h2>
            {meetings.length === 0 ? (
              <EmptyState title="No meetings yet" hint="Record a meeting manually from a lead's detail view." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Scheduled</th>
                    <th>Status</th>
                    <th>Next step</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((m) => (
                    <tr key={m.id}>
                      <td>{m.type}</td>
                      <td>{new Date(m.scheduled_at).toLocaleString()}</td>
                      <td>{m.status}</td>
                      <td>{m.next_step ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Layout>
  );
}
