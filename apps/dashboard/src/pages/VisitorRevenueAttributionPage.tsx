import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconChart, IconTarget, IconUsers, IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Visitor-to-revenue attribution: the closing hop of the attribution chain,
// extending RevenueIntelligencePage's per-campaign rollup one step further
// back, to the anonymous website visitor who started the journey. Every
// number here comes straight from
// GET .../visitor-attribution (apps/api/src/lib/visitorRevenueAttribution.ts)
// — a real first-touch-channel -> visitor -> lead -> deal-won -> revenue
// rollup. CAC/ROI render as "Not available" exactly when the API reports
// them that way (no acquisition_costs row recorded for that channel, or no
// deals won yet) — never a guessed number. This page is NOT wired into
// App.tsx/Layout.tsx's navigation by this change (reconciled separately) —
// it is reachable directly at
// /tenants/:tenantId/projects/:projectId/visitor-attribution once routed.
type CacResult = { value: number; currency: string; customersWon: number; totalSpend: number } | {
  value: "not_available";
  reason: string;
};
type RoiResult = { value: number; totalRevenue: number; totalSpend: number } | { value: "not_available"; reason: string };

interface VisitorChannelRow {
  channelSource: string;
  channelMedium: string | null;
  channelCampaignOrLandingPage: string;
  visitorCount: number;
  leadCount: number;
  qualifiedLeadCount: number;
  dealsWon: number;
  customersWon: number;
  revenue: number;
  spend: number | null;
  cac: CacResult;
  roi: RoiResult;
}

interface VisitorRevenueAttribution {
  channels: VisitorChannelRow[];
  totals: {
    visitorCount: number;
    leadCount: number;
    qualifiedLeadCount: number;
    dealsWon: number;
    customersWon: number;
    revenue: number;
    recordedSpend: number;
  };
  degraded: boolean;
  degradedNote?: string;
  unattributedLeadCount: number;
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

export function VisitorRevenueAttributionPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [data, setData] = useState<VisitorRevenueAttribution | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, attributionRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ visitorRevenueAttribution: VisitorRevenueAttribution }>(
          `/tenants/${tenantId}/projects/${projectId}/visitor-attribution`,
        ),
      ]);
      setProject(projectRes.project);
      setData(attributionRes.visitorRevenueAttribution);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load visitor-to-revenue attribution for this project.");
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
        { label: "Visitor-to-Revenue Attribution" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Visitor-to-Revenue Attribution</h1>
        <p className="muted">
          First-touch channel rollup: real anonymous website visitors (grouped by the UTM source/medium/campaign of
          their earliest tracked session, or by landing page when no UTM was captured), joined through to leads they
          submitted, through to deals won, to real recorded revenue. CAC/ROI render as "Not available" whenever no
          channel spend has been recorded — never a guessed number.
        </p>
      </section>

      {data === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : data.degraded ? (
        <section className="panel">
          <p className="muted">{data.degradedNote ?? "Visitor analytics data is not available yet for this project."}</p>
        </section>
      ) : (
        <>
          <StatGrid>
            <StatCard icon={<IconUsers />} label="Visitors (first-touch attributed)" value={data.totals.visitorCount} />
            <StatCard icon={<IconTarget />} label="Leads from tracked visitors" value={data.totals.leadCount} />
            <StatCard
              icon={<IconZap />}
              label="Customers won"
              value={data.totals.customersWon}
              hint={`${data.totals.dealsWon} deals won`}
            />
            <StatCard icon={<IconChart />} label="Real revenue" value={formatMoney(data.totals.revenue)} />
          </StatGrid>

          {data.unattributedLeadCount > 0 ? (
            <section className="panel">
              <p className="muted">
                {data.unattributedLeadCount} lead{data.unattributedLeadCount === 1 ? "" : "s"} in this project{" "}
                {data.unattributedLeadCount === 1 ? "has" : "have"} no visitor/session id recorded — they are not
                included above, honestly, rather than guessed into a channel.
              </p>
            </section>
          ) : null}

          <section className="panel">
            <h2>Per-channel visitors, leads, revenue &amp; ROI</h2>
            {data.channels.length === 0 ? (
              <p className="muted">No tracked visitors yet for this project.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Channel (source / medium)</th>
                    <th>Campaign / landing page</th>
                    <th>Visitors</th>
                    <th>Leads</th>
                    <th>Qualified</th>
                    <th>Customers won</th>
                    <th>Revenue</th>
                    <th>Spend</th>
                    <th>CAC</th>
                    <th>ROI</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.map((c) => (
                    <tr key={`${c.channelSource}-${c.channelMedium ?? ""}-${c.channelCampaignOrLandingPage}`}>
                      <td>
                        {c.channelSource}
                        {c.channelMedium ? ` / ${c.channelMedium}` : ""}
                      </td>
                      <td>{c.channelCampaignOrLandingPage}</td>
                      <td>{c.visitorCount}</td>
                      <td>{c.leadCount}</td>
                      <td>{c.qualifiedLeadCount}</td>
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
