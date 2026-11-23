import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconChart, IconTarget, IconUsers, IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Site Analytics (Milestone 2, P1): real first-party website-traffic
// numbers, composed by GET .../site-analytics
// (apps/api/src/lib/siteAnalytics.ts) from the new site_visitors/
// site_sessions/site_pageviews tables that packages/embed-widget/
// analytics.js's tracking beacon writes to. This is a SEPARATE page/route
// from GrowthAnalyticsPage.tsx (growthRevenueAnalytics.ts's "website
// traffic" field there stays a UTM/lead-capture proxy, untouched this
// round — see this feature's handback for how the two relate).
interface SiteAnalytics {
  periodDays: number;
  uniqueVisitors: number;
  sessions: number;
  pageviews: number;
  bounceRate: number | null;
  topReferrers: { referrer: string; count: number }[];
  topLandingPages: { landingUrl: string; count: number }[];
  botSessionsExcluded: number;
}

function formatPercent(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n * 1000) / 10}%`;
}

export function SiteAnalyticsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [analytics, setAnalytics] = useState<SiteAnalytics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, analyticsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ siteAnalytics: SiteAnalytics }>(
          `/tenants/${tenantId}/projects/${projectId}/site-analytics`,
        ),
      ]);
      setProject(projectRes.project);
      setAnalytics(analyticsRes.siteAnalytics);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load site analytics for this project.");
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
        { label: "Site Analytics" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Site Analytics</h1>
        <p className="muted">
          Real, first-party visitor/session/pageview tracking (packages/embed-widget/analytics.js) — every number
          here is a real row written by an actual visitor's browser, bot sessions excluded (a deterministic
          User-Agent check — see the API's botDetection.ts — necessarily incomplete against sophisticated bots).
          This is separate from Growth Analytics' "website traffic" field, which remains a UTM/lead-capture proxy.
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
              label={`Unique visitors (last ${analytics.periodDays}d)`}
              value={analytics.uniqueVisitors}
            />
            <StatCard icon={<IconZap />} label="Sessions" value={analytics.sessions} />
            <StatCard icon={<IconChart />} label="Pageviews" value={analytics.pageviews} />
            <StatCard
              icon={<IconTarget />}
              label="Single-pageview sessions"
              value={formatPercent(analytics.bounceRate)}
              hint="bounce-rate-style ratio"
            />
          </StatGrid>

          <section className="panel">
            <h2>Top referrers</h2>
            {analytics.topReferrers.length === 0 ? (
              <p className="muted">No referrer data yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Referrer</th>
                    <th>Sessions</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.topReferrers.map((r) => (
                    <tr key={r.referrer}>
                      <td>{r.referrer}</td>
                      <td>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <h2>Top landing pages</h2>
            {analytics.topLandingPages.length === 0 ? (
              <p className="muted">No landing-page data yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Landing URL</th>
                    <th>Sessions</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.topLandingPages.map((p) => (
                    <tr key={p.landingUrl}>
                      <td>{p.landingUrl}</td>
                      <td>{p.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <p className="muted">
              {analytics.botSessionsExcluded} bot session(s) detected and excluded from the numbers above (still
              stored for transparency, never counted as real traffic).
            </p>
          </section>
        </>
      )}
    </Layout>
  );
}
