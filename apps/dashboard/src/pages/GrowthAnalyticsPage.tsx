import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconChart, IconTarget, IconUsers, IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Growth/Revenue Analytics (roadmap item 7). Every number here comes
// straight from GET .../growth-analytics
// (apps/api/src/lib/growthRevenueAnalytics.ts) — a real SQL composition
// over leads/meetings/deals/campaigns. CAC and ROI are rendered as
// "Not available" (never a guessed number) whenever the API reports them
// that way, which it does honestly whenever no campaign spend has been
// recorded yet.
interface GrowthAnalytics {
  periodDays: number;
  websiteTraffic: { totalLeads: number; leadsWithReferrer: number; note: string };
  leadQualification: { totalLeads: number; qualifiedCount: number; qualifiedRate: number; averageScore: number | null };
  meetingsBooked: { totalInPeriod: number };
  salesConversion: {
    totalDeals: number;
    wonDeals: number;
    lostDeals: number;
    openDeals: number;
    winRate: number | null;
    leadToDealRate: number | null;
  };
  customerAcquisitionCost: { value: number; currency: string; customersWon: number; totalSpend: number } | {
    value: "not_available";
    reason: string;
  };
  roi: { value: number; totalRevenue: number; totalSpend: number } | { value: "not_available"; reason: string };
}

function formatPercent(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n * 1000) / 10}%`;
}

export function GrowthAnalyticsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [analytics, setAnalytics] = useState<GrowthAnalytics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, analyticsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ growthAnalytics: GrowthAnalytics }>(
          `/tenants/${tenantId}/projects/${projectId}/growth-analytics`,
        ),
      ]);
      setProject(projectRes.project);
      setAnalytics(analyticsRes.growthAnalytics);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load growth analytics for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Growth Analytics" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Growth &amp; Revenue Analytics</h1>
        <p className="muted">
          Real aggregates over leads, meetings, deals, and manually-entered campaign spend — nothing here is
          estimated. Customer acquisition cost and ROI are shown as "Not available" whenever spend hasn't been
          recorded for any campaign yet, rather than a fabricated number.
        </p>
      </section>

      {analytics === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : (
        <>
          <StatGrid>
            <StatCard
              icon={<IconUsers />}
              label="Leads with traffic signal"
              value={analytics.websiteTraffic.leadsWithReferrer}
              hint={`of ${analytics.websiteTraffic.totalLeads} total leads`}
            />
            <StatCard
              icon={<IconTarget />}
              label="Qualified leads"
              value={analytics.leadQualification.qualifiedCount}
              hint={formatPercent(analytics.leadQualification.qualifiedRate)}
            />
            <StatCard icon={<IconZap />} label={`Meetings booked (last ${analytics.periodDays}d)`} value={analytics.meetingsBooked.totalInPeriod} />
            <StatCard
              icon={<IconChart />}
              label="Sales win rate"
              value={formatPercent(analytics.salesConversion.winRate)}
              hint={`${analytics.salesConversion.wonDeals} won / ${analytics.salesConversion.lostDeals} lost`}
            />
          </StatGrid>

          <section className="panel">
            <h2>Customer acquisition cost</h2>
            {analytics.customerAcquisitionCost.value === "not_available" ? (
              <p className="muted">Not available — {analytics.customerAcquisitionCost.reason}</p>
            ) : (
              <p>
                ${analytics.customerAcquisitionCost.value.toFixed(2)} per customer (
                {analytics.customerAcquisitionCost.customersWon} customers won, $
                {analytics.customerAcquisitionCost.totalSpend.toFixed(2)} total spend)
              </p>
            )}
          </section>

          <section className="panel">
            <h2>ROI</h2>
            {analytics.roi.value === "not_available" ? (
              <p className="muted">Not available — {analytics.roi.reason}</p>
            ) : (
              <p>
                {(analytics.roi.value * 100).toFixed(0)}% (${analytics.roi.totalRevenue.toFixed(2)} revenue vs. $
                {analytics.roi.totalSpend.toFixed(2)} spend)
              </p>
            )}
          </section>
        </>
      )}
    </Layout>
  );
}
