import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconChart, IconTarget, IconUsers, IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Phase 7, Revenue Intelligence (roadmap item: campaigns -> qualified leads
// -> meetings -> customers -> actual revenue -> CAC -> ROI). Every number
// here comes straight from GET .../revenue-intelligence
// (apps/api/src/lib/revenueIntelligence.ts) — real SQL aggregates over
// leads/meetings/deals/campaigns/prospecting_campaigns, per campaign. CAC
// and ROI render as "Not available" whenever the API reports them that way
// (no spend recorded, or no deals won yet) — never a guessed number.
type CacResult = { value: number; currency: string; customersWon: number; totalSpend: number } | {
  value: "not_available";
  reason: string;
};
type RoiResult = { value: number; totalRevenue: number; totalSpend: number } | { value: "not_available"; reason: string };

interface CampaignRevenueRow {
  campaignType: "outbound" | "prospecting";
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  qualifiedLeads: number;
  meetingsBooked: number;
  dealsWon: number;
  customersWon: number;
  revenue: number;
  spend: number | null;
  cac: CacResult;
  roi: RoiResult;
}

interface RevenueIntelligence {
  campaigns: CampaignRevenueRow[];
  totals: {
    qualifiedLeads: number;
    meetingsBooked: number;
    dealsWon: number;
    customersWon: number;
    revenue: number;
    recordedSpend: number;
  };
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatCac(cac: CacResult): string {
  if (cac.value === "not_available") return "Not available";
  return `${formatMoney(cac.value)} / customer`;
}

function formatRoi(roi: RoiResult): string {
  if (roi.value === "not_available") return "Not available";
  return `${(roi.value * 100).toFixed(0)}%`;
}

export function RevenueIntelligencePage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [data, setData] = useState<RevenueIntelligence | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, revenueRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ revenueIntelligence: RevenueIntelligence }>(
          `/tenants/${tenantId}/projects/${projectId}/revenue-intelligence`,
        ),
      ]);
      setProject(projectRes.project);
      setData(revenueRes.revenueIntelligence);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load revenue intelligence for this project.");
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
        { label: "Revenue Intelligence" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Revenue Intelligence</h1>
        <p className="muted">
          Per-campaign rollup from campaigns (outbound and discovery) through qualified leads, meetings booked, and
          deals won, to real recorded revenue, CAC, and ROI. Nothing here is estimated — a campaign with no spend
          recorded, or no deals won yet, shows "Not available" rather than a guessed number.
        </p>
      </section>

      {data === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : (
        <>
          <StatGrid>
            <StatCard icon={<IconTarget />} label="Qualified leads" value={data.totals.qualifiedLeads} />
            <StatCard icon={<IconZap />} label="Meetings booked" value={data.totals.meetingsBooked} />
            <StatCard
              icon={<IconUsers />}
              label="Customers won"
              value={data.totals.customersWon}
              hint={`${data.totals.dealsWon} deals won`}
            />
            <StatCard icon={<IconChart />} label="Real revenue" value={formatMoney(data.totals.revenue)} />
          </StatGrid>

          <section className="panel">
            <h2>Per-campaign revenue, CAC &amp; ROI</h2>
            {data.campaigns.length === 0 ? (
              <p className="muted">No campaigns yet for this project.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Type</th>
                    <th>Qualified leads</th>
                    <th>Meetings</th>
                    <th>Customers won</th>
                    <th>Revenue</th>
                    <th>Spend</th>
                    <th>CAC</th>
                    <th>ROI</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((c) => (
                    <tr key={`${c.campaignType}-${c.campaignId}`}>
                      <td>{c.campaignName}</td>
                      <td>{c.campaignType === "outbound" ? "Outbound" : "Discovery"}</td>
                      <td>{c.qualifiedLeads}</td>
                      <td>{c.meetingsBooked}</td>
                      <td>{c.customersWon}</td>
                      <td>{formatMoney(c.revenue)}</td>
                      <td>{c.spend === null ? "Not recorded" : formatMoney(c.spend)}</td>
                      <td>{formatCac(c.cac)}</td>
                      <td>{formatRoi(c.roi)}</td>
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
