import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { StatusBarChart } from "../components/charts/StatusBarChart";
import { LeadsTimeSeries } from "../components/charts/LeadsTimeSeries";
import { IconTarget, IconUsers, IconZap } from "../components/Icons";
import { colorForExecutionStatus, colorForIndex } from "../lib/chartColors";
import { campaignStatusTone } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { AnalyticsOverview, Project } from "../api/types";

// Real analytics only. Every number rendered on this page comes straight
// from GET .../analytics/overview (apps/api/src/routes/analytics.ts), which
// is itself a direct SQL aggregate over leads/campaigns/agent_executions —
// nothing here is estimated, sampled, or invented. A category with zero
// rows renders the existing EmptyState via StatusBarChart/LeadsTimeSeries,
// never a fabricated placeholder chart.
export function AnalyticsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, overviewRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<AnalyticsOverview>(`/tenants/${tenantId}/projects/${projectId}/analytics/overview`),
      ]);
      setProject(projectRes.project);
      setOverview(overviewRes);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load analytics for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const campaignTotal = overview?.campaigns.byStatus.reduce((sum, s) => sum + s.count, 0) ?? 0;
  const executionTotal = overview?.agentExecutions.byStatus.reduce((sum, s) => sum + s.count, 0) ?? 0;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Analytics" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Analytics</h1>
        <p className="muted">
          Real aggregates computed directly from this project's leads, campaigns, and agent executions — nothing on
          this page is estimated or fabricated. An empty section means there is genuinely no data yet.
        </p>
      </section>

      {overview === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : (
        <>
          <StatGrid>
            <StatCard icon={<IconUsers />} label="Total leads" value={overview.leads.total} />
            <StatCard icon={<IconTarget />} label="Total campaigns" value={campaignTotal} />
            <StatCard icon={<IconZap />} label="Total agent executions" value={executionTotal} />
          </StatGrid>

          <section className="panel">
            <h2>Leads over time</h2>
            <LeadsTimeSeries data={overview.leads.perDay} />
          </section>

          <section className="panel">
            <h2>Breakdown by status</h2>
            {overview.leads.byStatus.length === 0 && overview.campaigns.byStatus.length === 0 && overview.agentExecutions.byStatus.length === 0 ? (
              <EmptyState title="No data yet" hint="Charts will appear here once there's real activity in this project." />
            ) : (
              <div className="chart-grid">
                <StatusBarChart
                  title="Leads by status"
                  segments={overview.leads.byStatus.map((s, i) => ({
                    key: s.status,
                    label: s.status,
                    value: s.count,
                    color: colorForIndex(i),
                  }))}
                />
                <StatusBarChart
                  title="Campaigns by status"
                  segments={overview.campaigns.byStatus.map((s) => ({
                    key: s.status,
                    label: s.status.replace("_", " "),
                    value: s.count,
                    color:
                      campaignStatusTone(s.status) === "success"
                        ? "#0ca30c"
                        : campaignStatusTone(s.status) === "danger"
                          ? "#d03b3b"
                          : campaignStatusTone(s.status) === "warn"
                            ? "#fab219"
                            : "#3987e5",
                  }))}
                />
                <StatusBarChart
                  title="Agent executions by status"
                  segments={overview.agentExecutions.byStatus.map((s) => ({
                    key: s.status,
                    label: s.status,
                    value: s.count,
                    color: colorForExecutionStatus(s.status),
                  }))}
                />
              </div>
            )}
          </section>
        </>
      )}
    </Layout>
  );
}
