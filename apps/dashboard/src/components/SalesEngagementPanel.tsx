import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { StatCard, StatGrid } from "./StatCard";
import { IconTarget, IconUsers, IconZap } from "./Icons";
import { api, ApiError } from "../api/client";

// Workstream G2: multi-touch sales engagement tracking, lead intent
// scoring, follow-up recommendations, and prospect-to-meeting conversion
// analytics. Built as its OWN sibling component rather than inlined into
// SalesPipelinePage.tsx — that page is untracked/new from a parallel
// workstream (confirmed via `git status` before touching anything), so
// this panel is additive and self-contained: it fetches its own data and
// renders nothing destructive to the page it's dropped into.
//
// DROP-IN POINT (2 lines, apps/dashboard/src/pages/SalesPipelinePage.tsx):
//   import { SalesEngagementPanel } from "../components/SalesEngagementPanel";
//   ...later, inside the <Layout> JSX, e.g. right after the stalled-deals section:
//   <SalesEngagementPanel tenantId={tenantId!} projectId={projectId!} />
//
// Every number here is a direct read from
// GET /tenants/:tenantId/projects/:projectId/sales-engagement-intelligence/conversion-funnel
// (apps/api/src/routes/salesEngagementIntelligence.ts) — nothing is
// estimated client-side.
interface ConversionFunnelStats {
  dateRange: { from: string; to: string };
  prospectsContacted: number;
  repliesReceived: number;
  leadsWhoReplied: number;
  meetingsBooked: number;
  leadsWithMeetingBooked: number;
  meetingsCompleted: number;
  conversionRates: {
    contactToReply: number | null;
    replyToMeeting: number | null;
    contactToMeeting: number | null;
    meetingToCompleted: number | null;
  };
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 1000) / 10}%`;
}

export function SalesEngagementPanel({ tenantId, projectId }: { tenantId: string; projectId: string }) {
  const [stats, setStats] = useState<ConversionFunnelStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ conversionFunnel: ConversionFunnelStats }>(
        `/tenants/${tenantId}/projects/${projectId}/sales-engagement-intelligence/conversion-funnel`,
      );
      setStats(res.conversionFunnel);
    } catch (err) {
      setLoadError(
        err instanceof ApiError ? err.message : "Could not load the prospect-to-meeting conversion funnel.",
      );
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="panel">
      <h2>Engagement &amp; conversion funnel</h2>
      <p className="muted">
        Real counts across this project's last 90 days by default: sequence enrollments / message drafts (closest
        real "contacted" signal this codebase has, since no send/open/click event table exists yet) through replies
        to booked and completed meetings.
      </p>
      <ErrorBanner message={loadError} />
      {stats === null ? (
        <p className="muted">Loading...</p>
      ) : stats.prospectsContacted === 0 && stats.meetingsBooked === 0 ? (
        <EmptyState
          title="No engagement recorded yet in this window"
          hint="Enroll leads in a sequence, draft outreach messages, or log a meeting to start building this funnel."
        />
      ) : (
        <>
          <StatGrid>
            <StatCard icon={<IconUsers />} label="Prospects contacted" value={stats.prospectsContacted} />
            <StatCard icon={<IconTarget />} label="Replies received" value={stats.repliesReceived} />
            <StatCard icon={<IconZap />} label="Meetings booked" value={stats.meetingsBooked} />
          </StatGrid>
          <table className="table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Conversion rate</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Contacted → replied</td>
                <td>{formatRate(stats.conversionRates.contactToReply)}</td>
              </tr>
              <tr>
                <td>Replied → meeting booked</td>
                <td>{formatRate(stats.conversionRates.replyToMeeting)}</td>
              </tr>
              <tr>
                <td>Contacted → meeting booked</td>
                <td>{formatRate(stats.conversionRates.contactToMeeting)}</td>
              </tr>
              <tr>
                <td>Meeting booked → completed</td>
                <td>{formatRate(stats.conversionRates.meetingToCompleted)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
