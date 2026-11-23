import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconChart, IconTarget, IconUsers } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Advanced Analytics (Workstream C1): funnel visualization, cohort
// retention, and behavioral segmentation, all composed by
// GET/POST .../advanced-analytics/* (apps/api/src/routes/
// growthExperimentsAnalytics.ts) from the EXISTING site_visitors/
// site_sessions/site_pageviews/site_events tables — same real-data source
// as SiteAnalyticsPage.tsx, a separate route/page from it and from
// GrowthAnalyticsPage.tsx. A visitor-journey lookup is also available via
// the API (GET .../advanced-analytics/visitor-journey/:visitorId) but isn't
// wired into this page's UI yet — it needs a visitor-id search input, left
// as a follow-up rather than built half-heartedly here.

interface FunnelStepResult {
  stepIndex: number;
  eventName: string;
  sessionCount: number;
  conversionRateFromPrevious: number | null;
  conversionRateFromFirst: number | null;
}

interface FunnelResult {
  periodDays: number;
  totalSessionsInRange: number;
  steps: FunnelStepResult[];
}

interface CohortWeekRetention {
  weekOffset: number;
  activeVisitors: number;
  retentionRate: number;
}

interface CohortRow {
  cohortWeekStart: string;
  cohortSize: number;
  weeks: CohortWeekRetention[];
}

interface CohortTable {
  cohortBy: string;
  periodDays: number;
  maxWeekOffset: number;
  cohorts: CohortRow[];
}

interface SegmentResult {
  totalVisitors: number;
  matchedVisitors: number;
  matchRate: number;
  sampleVisitorIds: string[];
}

// A default, always-available funnel: visited any page -> fired any custom
// event. Deliberately generic (not tied to a tenant-specific event name we
// cannot assume exists) so the chart renders something real for every
// project the moment it has ANY tracked traffic, rather than requiring
// pre-configuration before this page shows anything.
const DEFAULT_FUNNEL_STEPS = [{ eventName: "page_view" }, { eventName: "cta_click" }, { eventName: "form_submitted" }];

function formatPercent(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n * 1000) / 10}%`;
}

export function AdvancedAnalyticsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [funnel, setFunnel] = useState<FunnelResult | null>(null);
  const [cohortTable, setCohortTable] = useState<CohortTable | null>(null);
  const [segment, setSegment] = useState<SegmentResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const base = `/tenants/${tenantId}/projects/${projectId}`;
      const [projectRes, funnelRes, cohortRes, segmentRes] = await Promise.all([
        api.get<{ project: Project }>(base),
        api.post<{ funnel: FunnelResult }>(`${base}/advanced-analytics/funnel`, {
          steps: DEFAULT_FUNNEL_STEPS,
          sinceDays: 30,
        }),
        api.get<{ cohortTable: CohortTable }>(`${base}/advanced-analytics/cohort-retention?sinceDays=90&maxWeekOffset=6`),
        api.post<{ segment: SegmentResult }>(`${base}/advanced-analytics/segment`, {
          rules: [{ type: "event_count_at_least", eventName: "cta_click", minCount: 1 }],
        }),
      ]);
      setProject(projectRes.project);
      setFunnel(funnelRes.funnel);
      setCohortTable(cohortRes.cohortTable);
      setSegment(segmentRes.segment);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load advanced analytics for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const maxFunnelCount = funnel ? Math.max(1, ...funnel.steps.map((s) => s.sessionCount)) : 1;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Advanced Analytics" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Advanced Analytics</h1>
        <p className="muted">
          Visitor-behavior funnels, cohort retention, and behavioral segmentation — built on the same real
          site_visitors/site_sessions/site_pageviews/site_events tables as Site Analytics, not a new tracking
          pipeline. The funnel below is unordered-window (no per-step time limit) and strictly session-scoped; a
          step can only count a session that reached it, in order, after the previous step in the SAME session.
        </p>
      </section>

      <section className="panel">
        <h2>Funnel: pageview → CTA click → form submitted</h2>
        {funnel === null ? (
          <p className="muted">Loading...</p>
        ) : (
          <>
            <p className="muted">
              {funnel.totalSessionsInRange} total non-bot session(s) in the last {funnel.periodDays} days.
            </p>
            <div className="funnel-chart">
              {funnel.steps.map((step) => (
                <div key={step.stepIndex} className="funnel-step">
                  <div className="funnel-step-label">
                    {step.stepIndex + 1}. {step.eventName}
                  </div>
                  <div className="funnel-bar-track">
                    <div
                      className="funnel-bar-fill"
                      style={{ width: `${Math.max(2, (step.sessionCount / maxFunnelCount) * 100)}%` }}
                    />
                  </div>
                  <div className="funnel-step-stats">
                    <span>{step.sessionCount} sessions</span>
                    {step.conversionRateFromPrevious !== null ? (
                      <span className="muted"> · {formatPercent(step.conversionRateFromPrevious)} from previous step</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Cohort retention (first-visit week)</h2>
        {cohortTable === null ? (
          <p className="muted">Loading...</p>
        ) : cohortTable.cohorts.length === 0 ? (
          <p className="muted">Not enough session history yet to build a cohort table.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Cohort week</th>
                <th>Visitors</th>
                {cohortTable.cohorts[0].weeks.map((w) => (
                  <th key={w.weekOffset}>Week {w.weekOffset}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohortTable.cohorts.map((cohort) => (
                <tr key={cohort.cohortWeekStart}>
                  <td>{new Date(cohort.cohortWeekStart).toLocaleDateString()}</td>
                  <td>{cohort.cohortSize}</td>
                  {cohort.weeks.map((w) => (
                    <td key={w.weekOffset}>{formatPercent(w.retentionRate)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Behavioral segment: clicked a CTA at least once</h2>
        {segment === null ? (
          <p className="muted">Loading...</p>
        ) : (
          <StatGrid>
            <StatCard icon={<IconUsers />} label="Total visitors" value={segment.totalVisitors} />
            <StatCard icon={<IconTarget />} label="Matched this segment" value={segment.matchedVisitors} />
            <StatCard icon={<IconChart />} label="Match rate" value={formatPercent(segment.matchRate)} />
          </StatGrid>
        )}
      </section>
    </Layout>
  );
}
